import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTrack } from '../../src/core/model/track'
import { classifyTrack, getTrackKind, resolveTrackKind } from '../../src/core/perf/trackKind'
import { synthesizeTimeline } from '../../src/cesium/trackGeometry'
import { parseGpx } from '../../src/core/parsers/gpx'
import { parseKml } from '../../src/core/parsers/kml'
import { parseFit } from '../../src/core/parsers/fit'
import { dataDir, hasFixture } from '../testData'

/** 起点经纬度,后面各用例在此基础上按恒定步长挪动生成一条直线轨迹。 */
const LON0 = 116.0
const LAT0 = 39.9
/** 相邻点之间的经度步长,配合 haversine 大约是每点 ~8.5 米,量级上贴近真实
 *  1Hz GPS 记录的点间距,不追求精确,只用来让 distanceM/elapsedS 换算出的
 *  平均速度落在测试想要的区间。 */
const STEP_DEG = 0.00008

function line(n: number) {
  const lon = new Array(n)
  const lat = new Array(n)
  for (let i = 0; i < n; i++) {
    lon[i] = LON0 + i * STEP_DEG
    lat[i] = LAT0
  }
  return { lon, lat }
}

function meta(name: string) {
  return { name, format: 'gpx' as const, fileName: `${name}.gpx` }
}

describe('classifyTrack', () => {
  it('no time column at all -> planned (regardless of other signals)', () => {
    const { lon, lat } = line(20)
    const t = createTrack({ lon, lat }, meta('no-time'))
    const r = classifyTrack(t)
    expect(r.signals.hasTime).toBe(false)
    expect(r.kind).toBe('planned')
    expect(r.reason).toContain('不含时间戳')
  })

  it('a perfectly uniform synthetic timeline (TrailCraft synthesizeTimeline at 2.5 m/s) is a red flag, never recorded', () => {
    // 直接复用 cesium/trackGeometry.ts#synthesizeTimeline 合成的等速时间轴,
    // 而不是自己再拍一份等距时间戳——这样这条用例真实反映了"TrailCraft 自己
    // 给无时间戳轨迹合成的时间轴"会不会被错误地判成 recorded。
    const { lon, lat } = line(20)
    const t = createTrack({ lon, lat }, meta('synthetic'))
    const idx = Uint32Array.from(t.points.lon.map((_, i) => i))
    const { times, synthetic } = synthesizeTimeline(t, idx)
    expect(synthetic).toBe(true)
    const timeMs = times.map((s) => s * 1000)
    const withTime = createTrack({ lon, lat, time: timeMs }, meta('synthetic'))

    const r = classifyTrack(withTime)
    expect(r.signals.intervalUniform).toBe(true)
    // 均匀时间轴 + 合理速度只够到 uncertain(总分 +1),够不到 recorded 的
    // 阈值(+4)——这正是"等速合成不能被单一弱证据蒙混过关"的设计意图。
    expect(r.kind).not.toBe('recorded')
  })

  it('a realistic jittery timeline (varying, non-uniform intervals) with plausible speed -> recorded', () => {
    const { lon, lat } = line(20)
    // 1s/2s/1s/3s 交替抖动,变异系数明显高于 UNIFORM_CV_THRESHOLD(0.05)。
    const deltasS = [1, 2, 1, 3, 1, 2, 1, 3, 1, 2, 1, 3, 1, 2, 1, 3, 1, 2, 1]
    const time: number[] = [0]
    for (const d of deltasS) time.push(time[time.length - 1] + d * 1000)
    const t = createTrack({ lon, lat, time }, meta('jitter'))
    const r = classifyTrack(t)
    expect(r.signals.intervalUniform).toBe(false)
    expect(r.signals.speedPlausible).toBe(true)
    expect(r.kind).toBe('recorded')
  })

  it('duplicate consecutive timestamps mixed with jitter (real COROS pattern) are not misjudged as "uniform"', () => {
    const { lon, lat } = line(20)
    // 0/1/0/2/0/1/0/3... 反复出现的重复时间戳(delta=0)与非零间隔混在一起
    // ——一个天真的"存在相同间隔就算不规律"规则会误判,这里验证变异系数法
    // 正确地把它识别成"抖动"(intervalUniform=false),而不是"过于规整"。
    const deltasS = [0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0]
    const time: number[] = [0]
    for (const d of deltasS) time.push(time[time.length - 1] + d * 1000)
    const t = createTrack({ lon, lat, time }, meta('dup-ts'))
    const r = classifyTrack(t)
    expect(r.signals.intervalSampleCount).toBeGreaterThanOrEqual(4)
    expect(r.signals.intervalUniform).toBe(false)
    expect(r.kind).not.toBe('planned')
  })

  it('implausibly fast elapsed/distance ratio (time present but garbage) -> planned', () => {
    // 参照文件头注释里的例子:109.7km 20 分钟内跑完(~91 m/s)。这里造一条
    // 短轨迹但给它一个荒谬短的时长,复现"有时间戳但时间戳与里程对不上"。
    const lon = [LON0, LON0 + 1.0] // ~85km 量级的经度跨度
    const lat = [LAT0, LAT0]
    const t = createTrack({ lon, lat, time: [0, 1000] }, meta('bogus-speed')) // 1 秒内跑完
    const r = classifyTrack(t)
    expect(r.signals.speedPlausible).toBe(false)
    expect(r.kind).toBe('planned')
    expect(r.reason).toContain('超出人类运动合理区间')
  })

  it('hr present (0 is the missing sentinel, not a reading) is detected correctly', () => {
    const { lon, lat } = line(20)
    const deltasS = [1, 2, 1, 3, 1, 2, 1, 3, 1, 2, 1, 3, 1, 2, 1, 3, 1, 2, 1]
    const time: number[] = [0]
    for (const d of deltasS) time.push(time[time.length - 1] + d * 1000)

    // 全 0 心率列(哨兵值,代表"无读数")不应被当成"有心率数据"。
    const zeroHr = new Array(20).fill(0)
    const withoutHr = createTrack({ lon, lat, time, hr: zeroHr }, meta('hr-zero'))
    expect(classifyTrack(withoutHr).signals.hasHr).toBe(false)

    // 至少一个非 0 读数就该被识别为"有心率数据"。
    const realHr = new Array(20).fill(0)
    realHr[5] = 132
    const withHr = createTrack({ lon, lat, time, hr: realHr }, meta('hr-real'))
    const r = classifyTrack(withHr)
    expect(r.signals.hasHr).toBe(true)
    expect(r.reason).toContain('含心率读数')
  })

  it('single-point track does not throw and yields a low-confidence result', () => {
    const t = createTrack({ lon: [LON0], lat: [LAT0], time: [0] }, meta('single'))
    expect(() => classifyTrack(t)).not.toThrow()
    const r = classifyTrack(t)
    expect(r.signals.pointCount).toBe(1)
    expect(r.signals.avgSpeedMPS).toBeUndefined()
    expect(r.kind).not.toBe('recorded') // 单点撑不起"确实是实跑"的证据
  })

  it('two-point track does not throw (not enough samples for interval regularity)', () => {
    const t = createTrack({ lon: [LON0, LON0 + STEP_DEG], lat: [LAT0, LAT0], time: [0, 1000] }, meta('two'))
    expect(() => classifyTrack(t)).not.toThrow()
    const r = classifyTrack(t)
    expect(r.signals.intervalSampleCount).toBeLessThan(4)
    expect(r.signals.intervalUniform).toBeUndefined()
  })

  it('getTrackKind memoises per Track identity (WeakMap) -- same object returns the exact cached result', () => {
    const { lon, lat } = line(20)
    const t = createTrack({ lon, lat }, meta('cache'))
    const first = getTrackKind(t)
    const second = getTrackKind(t)
    expect(second).toBe(first) // 同一个对象引用,不是重算出来的等值对象
  })

  it('resolveTrackKind uses the auto result when there is no override', () => {
    const { lon, lat } = line(20)
    const t = createTrack({ lon, lat }, meta('auto'))
    const resolved = resolveTrackKind(t)
    expect(resolved.overridden).toBe(false)
    expect(resolved.kind).toBe(classifyTrack(t).kind)
  })

  it('resolveTrackKind honours track.meta.kindOverride and labels it as overridden', () => {
    const { lon, lat } = line(20)
    const t = createTrack({ lon, lat }, { ...meta('override'), kindOverride: 'recorded' })
    // 这条轨迹没有时间列,自动判别一定是 planned,但覆盖值应该赢。
    expect(classifyTrack(t).kind).toBe('planned')
    const resolved = resolveTrackKind(t)
    expect(resolved.kind).toBe('recorded')
    expect(resolved.overridden).toBe(true)
    expect(resolved.reason).toContain('用户手动指定')
  })
})

// ---- 真实数据(P2 §3.1 里程碑 Q1 验收:四条真实样本 100% 正确,本测试额外
// 覆盖到 8 条:2 FIT 实跑 + 2 KML 规划 + 4 GPX 实跑) -----------------------


const SUPP = '补充测试轨迹数据'
const suppDir = join(dataDir, SUPP)

function bufFrom(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

const MAIN_DIR_GPX = [
  '468分张家口市越野跑20240713070047.gpx',
  '620崇礼68 20240712170018.gpx',
  '690分20240921065926.gpx',
  '大五台9个半20240615055824.gpx',
]

describe.skipIf(!hasFixture(SUPP))('classifyTrack real data', () => {
  it('both supplementary real COROS FIT recordings classify as recorded', async () => {
    for (const f of ['张家口市_越野跑20260710080013.fit', '张家口市_越野跑20260725084217.fit']) {
      const buf = readFileSync(join(suppDir, f))
      const t = await parseFit(bufFrom(buf), f)
      const r = classifyTrack(t)
      expect(r.kind, `${f}: ${r.reason}`).toBe('recorded')
    }
  })

  it('both supplementary real planned-route KMLs classify as planned', () => {
    for (const f of ['路线-崇礼_172_8km-7944m20260706090026.kml', '路线-四灵反穿20260811095617.kml']) {
      const xml = readFileSync(join(suppDir, f), 'utf-8')
      const t = parseKml(xml, f)
      const r = classifyTrack(t)
      expect(r.kind, `${f}: ${r.reason}`).toBe('planned')
    }
  })

  // Tens of MB each, so not committed to samples/ -- this case runs only
  // against the full local corpus (see tests/testData.ts).
  it.skipIf(!hasFixture(MAIN_DIR_GPX[0]))('four main-directory real GPX recordings classify as recorded', () => {
    for (const f of MAIN_DIR_GPX) {
      const xml = readFileSync(join(dataDir, f), 'utf-8')
      const t = parseGpx(xml, f)
      const r = classifyTrack(t)
      expect(r.kind, `${f}: ${r.reason}`).toBe('recorded')
    }
  })
})
