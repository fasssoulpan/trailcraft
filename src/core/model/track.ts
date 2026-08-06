export type TrackFormat = 'gpx' | 'kml' | 'fit'
export type Crs = 'wgs84' | 'gcj02' | 'bd09'

export interface TrackPoints {
  lon: Float64Array
  lat: Float64Array
  ele?: Float32Array          // 米,缺失整列 undefined,单点缺失 NaN
  time?: Float64Array         // epoch ms,同上
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
  if (pts.lat.length !== n || (pts.ele && pts.ele.length !== n) || (pts.time && pts.time.length !== n))
    throw new Error(`point array length mismatch`)
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
