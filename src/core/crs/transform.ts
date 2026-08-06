// GCJ-02 偏转算法为社区公开近似实现(参见 wandergis/coordtransform, MIT)
import type { Crs } from '../model/track'

const a = 6378245.0
const ee = 0.00669342162296594323
const xPI = (Math.PI * 3000.0) / 180.0

export function outOfChina(lon: number, lat: number): boolean {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55)
}

function tLat(x: number, y: number): number {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3
  return r
}
function tLon(x: number, y: number): number {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3
  return r
}

export function wgs84ToGcj02(lon: number, lat: number): [number, number] {
  if (outOfChina(lon, lat)) return [lon, lat]
  let dLat = tLat(lon - 105.0, lat - 35.0)
  let dLon = tLon(lon - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - ee * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI)
  dLon = (dLon * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return [lon + dLon, lat + dLat]
}

/** 迭代精确反解,残差 < 0.5m */
export function gcj02ToWgs84(lon: number, lat: number): [number, number] {
  if (outOfChina(lon, lat)) return [lon, lat]
  let wlon = lon
  let wlat = lat
  for (let i = 0; i < 3; i++) {
    const [glon, glat] = wgs84ToGcj02(wlon, wlat)
    wlon -= glon - lon
    wlat -= glat - lat
  }
  return [wlon, wlat]
}

export function gcj02ToBd09(lon: number, lat: number): [number, number] {
  const z = Math.sqrt(lon * lon + lat * lat) + 0.00002 * Math.sin(lat * xPI)
  const theta = Math.atan2(lat, lon) + 0.000003 * Math.cos(lon * xPI)
  return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006]
}

export function bd09ToGcj02(lon: number, lat: number): [number, number] {
  const x = lon - 0.0065
  const y = lat - 0.006
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * xPI)
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * xPI)
  return [z * Math.cos(theta), z * Math.sin(theta)]
}

const pointFns: Record<string, (lon: number, lat: number) => [number, number]> = {
  'gcj02>wgs84': gcj02ToWgs84,
  'wgs84>gcj02': wgs84ToGcj02,
  'bd09>gcj02': bd09ToGcj02,
  'gcj02>bd09': gcj02ToBd09,
  'bd09>wgs84': (lo, la) => {
    const [g0, g1] = bd09ToGcj02(lo, la)
    return gcj02ToWgs84(g0, g1)
  },
  'wgs84>bd09': (lo, la) => {
    const [g0, g1] = wgs84ToGcj02(lo, la)
    return gcj02ToBd09(g0, g1)
  },
}

export function convertTrackArrays(lon: Float64Array, lat: Float64Array, from: Crs, to: Crs) {
  if (from === to) return { lon: Float64Array.from(lon), lat: Float64Array.from(lat) }
  const fn = pointFns[`${from}>${to}`]
  if (!fn) throw new Error(`unsupported crs conversion ${from}>${to}`)
  const n = lon.length
  const outLon = new Float64Array(n)
  const outLat = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const [x, y] = fn(lon[i], lat[i])
    outLon[i] = x
    outLat[i] = y
  }
  return { lon: outLon, lat: outLat }
}
