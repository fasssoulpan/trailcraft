/**
 * 把地形采样得到的高程写回轨迹(P2 手绘路线「补全高程」)——纯映射逻辑,
 * 不 import cesium。真正发起 `sampleTerrainMostDetailed` 网络请求的地方是
 * `cesium/terrainSample.ts`(隔在动态 import 边界另一侧,见该文件的文档
 * 注释),那个模块把"点→高度"的结果收敛成一个和这里的 `heights` 参数同样
 * 形状的普通数组之后,才会调用到这个文件——这样这个文件才能在不加载 Cesium、
 * 不发真实网络请求的前提下被单元测试完整覆盖(用一个假的 heights 数组
 * 模拟采样结果,包括部分失败的情况)。
 *
 * 核心约束(P0 已经吃过一次亏,见 docs/P0-验收记录.md §五「杜绝伪造 0 值」):
 * 采样失败的点绝不能被当成 0 米写进去——0 米是一个完全合法的真实高程读数
 * (海平面附近的路线),一旦和"没采到数据"混淆,下游的爬升统计、坡度、
 * 表现分会被这批伪造的 0 悄悄污染,且没有任何症状能让用户发现。
 */
import { newId, type Track } from '../model/track'

export interface ElevationSampleResult {
  /** 写入高程后的新 Track(全新 id,`meta.name` 带后缀)——和
   *  `core/toolbox/ops.ts` 里每个操作的约定一致:绝不修改传入的 Track。
   *  全部采样失败时,`track` 就是原样传回的输入 Track(未派生任何新对象),
   *  见下方 `sampledCount === 0` 分支的注释。 */
  track: Track
  /** 成功采到高程的点数。 */
  sampledCount: number
  /** 采样失败(该点在 `heights` 里是 `undefined`)的点数。 */
  failedCount: number
}

/**
 * `heights[i]` 对应 `track.points.{lon,lat}[i]`。`undefined` 表示这一点
 * 采样失败或地形服务对这一点没有数据——调用方(`cesium/terrainSample.ts`)
 * 有责任保证"这一点真的没采到"和"采到的高程恰好是 0"绝不会被合并成同一个
 * 值,这个函数信任这份约定、不做二次判断。
 *
 * - `heights.length` 必须等于轨迹点数,否则抛错(调用方传入的一定是同一次
 *   针对这条轨迹发起的采样结果,长度不match 说明调用方自己的簿记出了问题,
 *   静默截断/补零都会掩盖这个 bug)。
 * - 一个点都没采到(`sampledCount === 0`,比如地形服务整体不可达):原样
 *   返回输入 Track,不新增 `ele` 列、不产出任何新对象——"轨迹保持没有高程"
 *   是这里唯一诚实的选择,不能因为调用了"补全高程"就一定要在 `ele` 上
 *   写点什么。
 * - 部分成功:新 Track 带一条全新 `Float32Array` 的 `ele`,成功点写真实
 *   高程,失败点写 `NaN`——这正是 `core/model/track.ts` 给 `ele` 列定义的
 *   "单点缺失用 NaN"约定,下游(`core/perf/trackKind.ts`、`core/stats/*`
 *   等)本来就要面对真实 GPS 记录里同样会出现的逐点缺失,不需要这里额外
 *   做什么特殊处理。
 */
export function applySampledElevation(track: Track, heights: readonly (number | undefined)[]): ElevationSampleResult {
  const n = track.points.lon.length
  if (heights.length !== n) {
    throw new Error(`applySampledElevation: heights.length=${heights.length}, expected ${n}`)
  }

  let sampledCount = 0
  for (const h of heights) {
    if (h !== undefined) sampledCount++
  }
  const failedCount = n - sampledCount

  if (sampledCount === 0) {
    return { track, sampledCount: 0, failedCount: n }
  }

  const ele = new Float32Array(n)
  for (let i = 0; i < n; i++) ele[i] = heights[i] ?? NaN

  const next: Track = {
    ...track,
    id: newId('trk'),
    meta: { ...track.meta, name: `${track.meta.name} ·高程` },
    points: { ...track.points, ele },
  }
  return { track: next, sampledCount, failedCount }
}
