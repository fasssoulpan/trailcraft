/**
 * 轨迹工具箱纯函数:split / join / reverse / removeAnomalies / simplify。
 *
 * 设计约定(P0 验收要求的一部分):每个操作都是纯函数,返回一条全新的 Track
 * (新 id、全新 TypedArray、meta.name 带操作后缀),绝不修改传入的 Track ——
 * 这是"原始导入轨迹永不被覆盖、每次编辑都可撤销"的底层保证。派生轨迹的
 * cumDist 总是重新计算,不沿用源轨迹的旧值。
 */
import { createTrack, type Track, type TrackPoints, type TrackPointsInput } from '../model/track'
import { computeCumDist, haversine } from '../geo/distance'

function slicePoints(p: TrackPoints, keep: ArrayLike<number>): TrackPointsInput {
  const n = keep.length
  const lon = new Float64Array(n)
  const lat = new Float64Array(n)
  const ele = p.ele ? new Float32Array(n) : undefined
  const time = p.time ? new Float64Array(n) : undefined
  const hr = p.hr ? new Uint16Array(n) : undefined
  for (let i = 0; i < n; i++) {
    const idx = keep[i]
    lon[i] = p.lon[idx]
    lat[i] = p.lat[idx]
    if (ele) ele[i] = p.ele![idx]
    if (time) time[i] = p.time![idx]
    if (hr) hr[i] = p.hr![idx]
  }
  return { lon, lat, ele, time, hr }
}

function derive(src: Track, keep: ArrayLike<number>, suffix: string): Track {
  const t = createTrack(
    slicePoints(src.points, keep),
    { ...src.meta, name: `${src.meta.name}${suffix}` },
    src.originalCrs,
  )
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

function rangeArray(length: number, offset = 0): number[] {
  return Array.from({ length }, (_, i) => i + offset)
}

// ---------------------------------------------------------------------------
// splitAt
// ---------------------------------------------------------------------------

export function splitAt(t: Track, index: number): [Track, Track] {
  const n = t.points.lon.length
  if (!Number.isInteger(index) || index <= 0 || index >= n - 1) {
    throw new Error(`splitAt: index ${index} out of range for track with ${n} points (must be 1..${n - 2})`)
  }
  const a = rangeArray(index + 1, 0)
  const b = rangeArray(n - index, index)
  return [derive(t, a, ' ·A'), derive(t, b, ' ·B')]
}

// ---------------------------------------------------------------------------
// joinTracks
// ---------------------------------------------------------------------------

export function joinTracks(list: Track[]): Track {
  if (list.length < 2) throw new Error(`joinTracks: need at least 2 tracks, got ${list.length}`)

  const totalN = list.reduce((sum, t) => sum + t.points.lon.length, 0)
  const anyEle = list.some((t) => t.points.ele !== undefined)
  const anyTime = list.some((t) => t.points.time !== undefined)
  const anyHr = list.some((t) => t.points.hr !== undefined)

  const lon = new Float64Array(totalN)
  const lat = new Float64Array(totalN)
  const ele = anyEle ? new Float32Array(totalN) : undefined
  const time = anyTime ? new Float64Array(totalN) : undefined
  // Uint16Array default-initializes to 0, which is exactly the "no hr reading"
  // sentinel used elsewhere in the model, so a source track lacking hr needs
  // no explicit fill.
  const hr = anyHr ? new Uint16Array(totalN) : undefined

  let off = 0
  for (const t of list) {
    const n = t.points.lon.length
    lon.set(t.points.lon, off)
    lat.set(t.points.lat, off)
    if (ele) { if (t.points.ele) ele.set(t.points.ele, off); else ele.fill(NaN, off, off + n) }
    if (time) { if (t.points.time) time.set(t.points.time, off); else time.fill(NaN, off, off + n) }
    if (hr && t.points.hr) hr.set(t.points.hr, off)
    off += n
  }

  const first = list[0]
  const t = createTrack(
    { lon, lat, ele, time, hr },
    { ...first.meta, name: `${first.meta.name} +${list.length - 1}` },
    first.originalCrs,
  )
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

// ---------------------------------------------------------------------------
// reverseTrack
// ---------------------------------------------------------------------------

export function reverseTrack(t: Track): Track {
  const n = t.points.lon.length
  const idx = Array.from({ length: n }, (_, i) => n - 1 - i)
  return derive(t, idx, ' ·rev')
}

// ---------------------------------------------------------------------------
// removeAnomalies
// ---------------------------------------------------------------------------

export interface AnomalyOptions { maxSpeed?: number } // m/s

const DEFAULT_MAX_SPEED = 10 // m/s, ~36km/h - generous for trail running/biking descents

/**
 * 真实 COROS 轨迹中经常出现相邻两点时间戳完全相同(dt=0)的情况,此时
 * distance/dt 要么是 Infinity(会把正常点误判为异常并丢弃),要么在朴素地
 * 用 `dt > 0 ? … : 0` 兜底时,会让"零耗时里的 GPS 瞬移"永远无法被识别为异常。
 * 这里对 dt<=0 单独处理:距离超过该阈值,判定为"零耗时瞬移"(现实中人体不可能
 * 在零时间内移动这么远)予以剔除;距离在阈值以内,判定为同一时刻的重复采样
 * (GPS 噪声)予以保留。5m 是经验值,远大于静止状态下的 GPS 抖动(通常 1~3m),
 * 又远小于真实瞬移(通常几十米以上)。
 */
const ZERO_DT_DIST_THRESHOLD_M = 5

/**
 * 剔除轨迹中的速度异常点。逐点与"上一个被保留的点"比较(而不是与上一个原始
 * 点比较),这样连续多个异常点不会互相掩护对方。
 *
 * 若轨迹完全没有 time 列,速度无从计算,此时按文档约定原样返回(仅重新生成
 * id/cumDist),不做任何剔除 —— 沉默地丢弃所有点或全部保留都不算错,但
 * "全部保留"是唯一不会误删合法数据的选择。
 */
export function removeAnomalies(t: Track, opt: AnomalyOptions = {}): Track {
  const maxSpeed = opt.maxSpeed ?? DEFAULT_MAX_SPEED
  const n = t.points.lon.length

  if (!t.points.time) return derive(t, rangeArray(n), ' ·clean')

  const { lon, lat, time } = t.points
  const keep: number[] = [0]
  let lastKept = 0
  for (let i = 1; i < n; i++) {
    const dist = haversine(lon[lastKept], lat[lastKept], lon[i], lat[i])
    const dt = (time[i] - time[lastKept]) / 1000 // seconds
    const isAnomaly = dt <= 0 ? dist > ZERO_DT_DIST_THRESHOLD_M : dist / dt > maxSpeed
    if (!isAnomaly) {
      keep.push(i)
      lastKept = i
    }
  }
  return derive(t, keep, ' ·clean')
}

// ---------------------------------------------------------------------------
// simplifyTrack (Douglas-Peucker)
// ---------------------------------------------------------------------------

/**
 * 等距圆柱投影(equirectangular),把经纬度换算成以米为单位的局部平面坐标,
 * 这样 toleranceM 才是一个真实的距离阈值,而不是无量纲的经纬度差。纬度跨度
 * 大的轨迹会有一定投影畸变,但轨迹工具箱处理的都是单次徒步/越野跑的量级,
 * 可以接受。参考纬度取轨迹第一个点的纬度。
 */
function projectToMetres(lon: Float64Array, lat: Float64Array): { xs: Float64Array; ys: Float64Array } {
  const n = lon.length
  const lat0 = lat[0]
  const mx = 111320 * Math.cos((lat0 * Math.PI) / 180)
  const my = 110540
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = lon[i] * mx
    ys[i] = lat[i] * my
  }
  return { xs, ys }
}

function perpendicularDistance(xs: Float64Array, ys: Float64Array, i: number, a: number, b: number): number {
  const ax = xs[a], ay = ys[a], bx = xs[b], by = ys[b]
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(xs[i] - ax, ys[i] - ay)
  const tParam = ((xs[i] - ax) * dx + (ys[i] - ay) * dy) / len2
  const projX = ax + tParam * dx
  const projY = ay + tParam * dy
  return Math.hypot(xs[i] - projX, ys[i] - projY)
}

/**
 * 道格拉斯-普克(Douglas-Peucker)抽稀,tolerance 单位为米。
 *
 * 比较用 `>=` 而不是 `>`:当 toleranceM = 0 时,任何完全共线的中间点其
 * perpendicular distance 也恰好是 0,若用严格大于号,0 > 0 为假,这些点会
 * 被误删 —— 而 "tolerance 0 保留所有点" 是本函数的一个显式契约(调用方用
 * 0 表示"不要简化,只是标准化一下 cumDist"这种意图)。用 `>=` 之后,只要
 * tolerance 是 0,任何偏差(哪怕是 0)都会触发保留,从而保留全部点;
 * tolerance > 0 时行为和标准 Douglas-Peucker 一致。
 */
export function simplifyTrack(t: Track, toleranceM: number): Track {
  const n = t.points.lon.length
  if (n <= 2) return derive(t, rangeArray(n), ' ·simplified')

  const { xs, ys } = projectToMetres(t.points.lon, t.points.lat)
  const keepMask = new Uint8Array(n)
  keepMask[0] = 1
  keepMask[n - 1] = 1

  const stack: Array<[number, number]> = [[0, n - 1]]
  while (stack.length > 0) {
    const [start, end] = stack.pop()!
    if (end <= start + 1) continue
    let maxDist = -1
    let maxIdx = -1
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(xs, ys, i, start, end)
      if (d > maxDist) { maxDist = d; maxIdx = i }
    }
    if (maxIdx !== -1 && maxDist >= toleranceM) {
      keepMask[maxIdx] = 1
      stack.push([start, maxIdx])
      stack.push([maxIdx, end])
    }
  }

  const keep: number[] = []
  for (let i = 0; i < n; i++) if (keepMask[i]) keep.push(i)
  return derive(t, keep, ' ·simplified')
}
