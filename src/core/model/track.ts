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

export interface TrackMeta { name: string; format: TrackFormat; fileName: string; creator?: string }

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
