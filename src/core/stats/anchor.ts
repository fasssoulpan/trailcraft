import { haversine } from '../geo/distance'

/**
 * 里程单调约束锚定:按 CP 输入顺序,每个 CP 只在上一锚点之后的索引里找最近点。
 *
 * 越野跑赛道常见"折返"或"8 字形"线路,同一地理位置会被经过多次。若只用
 * 朴素的全局最近点匹配,出程和回程的两个 CP 会被同时锚定到几何上最近的
 * 那一次经过,悄悄把回程 CP 的里程算错。这里强制锚点索引按用户输入顺序
 * 单调递增来解决这个问题:复杂度是 O(n·k)(k 为 CP 数量,通常个位数),
 * 是刻意的权衡,不要为了"效率"去掉单调约束。
 */
export function anchorMonotonic(
  lon: Float64Array,
  lat: Float64Array,
  clicks: [number, number][],
): number[] {
  const n = lon.length
  const result: number[] = []
  let from = 0
  for (const [clickLon, clickLat] of clicks) {
    let bestIndex = from
    let bestDist = Infinity
    for (let i = from; i < n; i++) {
      const d = haversine(clickLon, clickLat, lon[i], lat[i])
      if (d < bestDist) {
        bestDist = d
        bestIndex = i
      }
    }
    result.push(bestIndex)
    from = Math.min(bestIndex + 1, n - 1)
  }
  return result
}
