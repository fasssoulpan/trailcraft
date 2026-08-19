import { haversine } from './distance'

export interface NearestVertexResult {
  /** 最近轨迹点在全精度点数组里的下标。 */
  index: number
  /** 到该点的距离,单位米。 */
  distanceM: number
}

/**
 * 无单调约束的全局最近轨迹点搜索——纯粹"这个经纬度离轨迹哪个点最近",
 * 不管前面已经锚定到了哪里。
 *
 * 单独抽成这个模块(而不是继续留在 `pipeline/checkpointImport.ts` 里当
 * 私有函数),是因为 `pipeline/photoAnchor.ts`(P3-R2 commit 3,把照片的
 * EXIF GPS 锚定到轨迹上)需要完全相同的两件事:
 *  1. 同款"两阶段"预处理的第一阶段(先算无约束最近点下标,按它排序,再喂给
 *     `stats/anchor.ts#anchorMonotonic` 做真正的单调锚定)——`checkpointImport.ts`
 *     文件顶部注释详细解释了这个预处理为什么必要(折返赛道 + 输入顺序
 *     不严格按赛道前进方向排列时,单调约束会把"地板"钉错位置)。
 *  2. `photoAnchor.ts` 额外还需要这次搜索找到的**距离本身**,用来判断
 *     "这张照片离轨迹是不是太远,应该拒绝而不是勉强贴上去"——`checkpointImport.ts`
 *     原来的版本不需要距离,只需要下标,所以没有返回它。
 * 两处需求有重叠但不完全相同,与其在两个文件里各写一份几乎一样的
 * O(n) 线性搜索(且两份实现随时间推移分叉出细微不一致的风险),不如提出来
 * 共用一份。
 */
export function nearestVertex(lon: Float64Array, lat: Float64Array, clickLon: number, clickLat: number): NearestVertexResult {
  let index = 0
  let distanceM = Infinity
  for (let i = 0; i < lon.length; i++) {
    const d = haversine(clickLon, clickLat, lon[i], lat[i])
    if (d < distanceM) {
      distanceM = d
      index = i
    }
  }
  return { index, distanceM }
}
