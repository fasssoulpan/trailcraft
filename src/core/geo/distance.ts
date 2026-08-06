const R = 6371008.8
const rad = Math.PI / 180

export function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** 累计里程数组,cum[0]=0,单位米 */
export function computeCumDist(lon: Float64Array, lat: Float64Array): Float64Array {
  const n = lon.length
  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + haversine(lon[i - 1], lat[i - 1], lon[i], lat[i])
  return cum
}

/** 返回 dist 所在段的起点索引(二分),dist 超界时夹到边界段 */
export function locateByDist(cum: Float64Array, dist: number): number {
  let lo = 0, hi = cum.length - 1
  if (dist <= 0) return 0
  if (dist >= cum[hi]) return hi - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= dist) lo = mid
    else hi = mid
  }
  return lo
}
