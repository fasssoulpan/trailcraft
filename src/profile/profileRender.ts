import type { Track } from '../core/model/track'
import { locateByDist } from '../core/geo/distance'
import { decimateIndices } from '../core/toolbox/decimate'

export interface ProfileData {
  dist: Float64Array // 抽稀后各采样点的累计里程(米)
  ele: Float32Array // 抽稀后各采样点的海拔(米),可能含 NaN
  idx: Uint32Array // 抽稀后采样点 -> 全精度轨迹点索引的映射
  totalDist: number // 全程里程(米),即 dist[dist.length-1]
  minEle: number // 忽略 NaN 后的最小海拔;全列 NaN 时为 0(见下方说明)
  maxEle: number // 忽略 NaN 后的最大海拔;全列 NaN 时为 0(见下方说明)
}

/**
 * 构建剖面绘制所需的抽稀数据。
 *
 * 返回 undefined 的情形:轨迹完全没有 ele 列,或没有 cumDist(尚未跑过
 * geo.computeCumDist 挂载里程)。两者任一缺失都无法画出有意义的剖面,调用方
 * (ProfileCanvas)必须显式处理 undefined,而不是把 NaN/undefined 画出来。
 *
 * Edge cases (deliberate):
 * - `totalDist === 0`(单点轨迹,或所有点坐标重合导致里程恒为 0):不做除法,
 *   `xToIndex`/`indexToX` 各自按自己的方式避免 0/0。
 * - ele 列存在但逐点全为 NaN(传感器整段丢失海拔,但轨迹仍标记"有海拔列"):
 *   min/max 若用朴素 reduce 会停留在 ±Infinity,污染后续所有基于 min/max 的
 *   缩放计算。这里选择让 min/max 都收敛到 0,得到一个合法但退化("平的")的
 *   范围,而不是抛出或返回 Infinity。ProfileCanvas 在绘制折线时仍需对每个
 *   采样点单独判断 `Number.isFinite(ele[i])` 来决定要不要连线/该不该显示
 *   "无海拔数据"提示 —— min/max 收敛到 0 只是保证坐标换算不会算出 Infinity/NaN,
 *   不代表"这段海拔就是 0"。
 */
export function buildProfileData(t: Track, maxPoints = 2000): ProfileData | undefined {
  const { ele, cumDist } = t.points
  if (!ele || !cumDist) return undefined

  const n = t.points.lon.length
  const idx = decimateIndices(n, maxPoints)
  const dist = new Float64Array(idx.length)
  const eleOut = new Float32Array(idx.length)

  let minEle = Infinity
  let maxEle = -Infinity
  for (let i = 0; i < idx.length; i++) {
    const srcIdx = idx[i]
    dist[i] = cumDist[srcIdx]
    const e = ele[srcIdx]
    eleOut[i] = e
    if (Number.isFinite(e)) {
      if (e < minEle) minEle = e
      if (e > maxEle) maxEle = e
    }
  }
  if (!Number.isFinite(minEle)) {
    minEle = 0
    maxEle = 0
  }

  const totalDist = dist.length > 0 ? dist[dist.length - 1] : 0
  return { dist, ele: eleOut, idx, totalDist, minEle, maxEle }
}

/**
 * 像素 x → 全精度点索引。
 *
 * x 先被夹到 [0, width],再按比例换算成沿轨里程(乘法,不做除法,所以
 * width<=0 或 totalDist===0 都只会得到 targetDist=0,不会产生 NaN)。用
 * `locateByDist` 在抽稀后的 dist 上二分定位所在段,再在该段内按里程占比线性
 * 插值回全精度索引(而不是直接取段起点索引),这样往返精度不受抽稀粒度的
 * 粗糙拖累 —— 段起点索引会在大间隔时把整段都吸附到同一个点,插值后误差通常
 * 只有几个点。
 */
export function xToIndex(p: ProfileData, x: number, width: number): number {
  if (p.dist.length === 0) return 0
  if (p.dist.length === 1) return p.idx[0]

  const w = width > 0 ? width : 1
  const cx = Math.min(Math.max(x, 0), width > 0 ? width : 0)
  const targetDist = (cx / w) * p.totalDist

  const seg = locateByDist(p.dist, targetDist)
  const segNext = Math.min(seg + 1, p.dist.length - 1)
  const d0 = p.dist[seg]
  const d1 = p.dist[segNext]
  const span = d1 - d0
  const t = span > 0 ? (targetDist - d0) / span : 0

  const i0 = p.idx[seg]
  const i1 = p.idx[segNext]
  return Math.round(i0 + t * (i1 - i0))
}

/**
 * 全精度点索引 → 像素 x。
 *
 * 用轨迹自身的(未抽稀)cumDist 取该点的真实里程,再按 totalDist 比例换算成
 * x。`totalDist <= 0`(零里程轨迹)时没有意义的比例可言,直接返回 0 —— 与
 * xToIndex 在同样场景下把任意 x 都归约到 targetDist=0(从而落在索引 0 附近)
 * 保持一致,避免两个函数在退化场景下互相矛盾。
 */
export function indexToX(t: Track, p: ProfileData, index: number, width: number): number {
  const cumDist = t.points.cumDist
  if (!cumDist || cumDist.length === 0) return 0
  const n = cumDist.length
  const i = Math.min(Math.max(Math.round(index), 0), n - 1)
  if (p.totalDist <= 0) return 0

  const frac = cumDist[i] / p.totalDist
  return Math.min(Math.max(frac, 0), 1) * width
}
