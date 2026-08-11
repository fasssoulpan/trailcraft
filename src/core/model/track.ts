export type TrackFormat = 'gpx' | 'kml' | 'fit'
export type Crs = 'wgs84' | 'gcj02' | 'bd09'

export interface TrackPoints {
  lon: Float64Array
  lat: Float64Array
  ele?: Float32Array          // 米,缺失整列 undefined,单点缺失 NaN
  time?: Float64Array         // epoch ms,同上
  /**
   * 心率(bpm)。Uint16Array 无法表示 NaN,因此此字段使用 0 作为"本点无心率读数"
   * 的哨兵值,而不是 ele/time 所用的逐点 NaN 缺失约定 —— 0 在这里永远表示"缺失",
   * 不表示"心率读数为 0"。做图表/求平均等下游处理时需要显式过滤掉 0,不能当作
   * 有效数据点。
   */
  hr?: Uint16Array
  /** 累计里程(米),由 geo 模块计算后挂载 */
  cumDist?: Float64Array
}

export interface TrackMeta {
  name: string
  format: TrackFormat
  fileName: string
  creator?: string
  /**
   * 展示态属性(线条颜色/粗细),不是导入产生的数据本身——放在 meta 上是
   * 为了让 `core/toolbox/ops.ts` 的每个操作(它们统一用 `{ ...src.meta, name: ... }`
   * 派生新 Track 的 meta)自动带上,不用逐个操作单独处理。缺失时由
   * `core/model/trackStyle.ts` 的 `backfillTrackStyles` 兜底分配默认值——
   * 因此这里保持可选,不强制所有 Track 构造点都显式传。
   */
  color?: string
  lineWidth?: number
  /**
   * 用户对 `core/perf/trackKind.ts` 自动判别结果(实跑/规划/待确认)的手动
   * 覆盖(P2 §3.1,里程碑 Q1)。放在 meta 上而不是新开一个顶层字段/store
   * 侧的 Record<trackId, ...>,理由和 color/lineWidth 完全一致:
   * `core/model/project.ts` 的 `trackToFeature`/`featureToTrack` 已经把整个
   * `meta` 对象原样塞进/读出工程文件的 `properties.meta`——加这个字段不需要
   * 再碰 project.ts 一行代码就自动获得持久化,旧工程文件(没有这个字段)
   * 反序列化时这里自然是 `undefined`,不会抛错(与 color/lineWidth 对旧
   * 工程文件的兼容方式相同)。
   *
   * 这里刻意不从 `core/perf/trackKind.ts` import `TrackKind` 类型,而是重复
   * 写一遍同样的字面量联合——和 `state/appStore.ts` 里 `FlythroughCameraMode`
   * 的处理理由相同:那个类型所在的模块 import 了 `Track`,反过来这里再 import
   * 它就会形成类型层面的循环依赖,重复一行字面量联合比冒这个险更便宜。
   *
   * 值为 `undefined` 表示"没有手动覆盖,以自动判别结果为准"——见
   * `core/perf/trackKind.ts` 的 `resolveTrackKind`。
   */
  kindOverride?: 'recorded' | 'planned' | 'uncertain'
}

export interface Track {
  id: string
  meta: TrackMeta
  crs: 'wgs84'                // 内部永远 WGS-84
  originalCrs: Crs            // 导入时识别到的原始坐标系
  points: TrackPoints
}

export interface TrackPointsInput {
  lon: ArrayLike<number>; lat: ArrayLike<number>
  ele?: ArrayLike<number>; time?: ArrayLike<number>; hr?: ArrayLike<number>
}

let seq = 0
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`
}

export function createTrack(pts: TrackPointsInput, meta: TrackMeta, originalCrs: Crs = 'wgs84'): Track {
  const n = pts.lon.length
  const fields: Array<[string, ArrayLike<number> | undefined]> = [
    ['lat', pts.lat],
    ['ele', pts.ele],
    ['time', pts.time],
    ['hr', pts.hr],
  ]
  for (const [name, arr] of fields) {
    if (arr && arr.length !== n)
      throw new Error(`point array length mismatch: ${name}.length=${arr.length}, expected ${n}`)
  }
  return {
    id: newId('trk'),
    meta, crs: 'wgs84', originalCrs,
    points: {
      lon: Float64Array.from(pts.lon), lat: Float64Array.from(pts.lat),
      ele: pts.ele ? Float32Array.from(pts.ele) : undefined,
      time: pts.time ? Float64Array.from(pts.time) : undefined,
      hr: pts.hr ? Uint16Array.from(pts.hr) : undefined,
    },
  }
}

export function trackPointCount(t: Track): number { return t.points.lon.length }
