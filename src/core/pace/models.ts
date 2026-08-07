/**
 * 配速模型与关门预警。
 *
 * 三档模型服务于不同"了解自己"的程度:Tobler 只需要赛道本身(坡度曲线),
 * 不需要用户提供任何个人数据;实用档(practical)则用跑者已经知道的三个
 * 数字——平路配速、爬升垂直速度(VAM)、下坡每米的额外耗时——去逐段估算。
 * `estimateArrivals` 把逐段耗时累加成每个 CP 的预计到达时间,再和关门时间
 * 比较,产出红/黄/绿三档预警,这是赛前计划的核心用途:回答"我能不能在关门
 * 前到"。
 */

/**
 * Tobler 徒步函数:speed(km/h) = 6·exp(-3.5·|slope+0.05|),slope = dh/dx。
 *
 * 峰值不在坡度 0(平地),而在坡度 −0.05(5% 的缓下坡)——这是选择 Tobler
 * 而不是线性模型的原因:缓下坡比平地更快,符合人体工程学直觉;但坡度继续
 * 变陡下降(比如 −0.4)反而比缓下坡慢很多,因为陡下坡需要刹车减速,这种
 * "先加速后减速"的非对称曲线,线性模型完全表达不出来。
 */
export function toblerSpeed(slope: number): number {
  return 6 * Math.exp(-3.5 * Math.abs(slope + 0.05))
}

export interface SegmentLike { dist: number; gain: number; loss: number }

export interface PaceParams {
  model?: 'tobler' | 'practical'
  flatPaceSecPerKm: number // 平路配速 秒/公里
  vamMPerH: number // 爬升垂直速度 米/小时
  descentFactor: number // 每米下降折算秒数
  fatiguePctPerHour: number // 每小时疲劳减速百分比
}

/**
 * 疲劳系数:跑到第 elapsedSec 秒时,把"新鲜状态"下的耗时按已耗时长放大。
 * practical 和 tobler 两档共用同一条疲劳曲线,唯一的区别只在"新鲜状态耗时"
 * 怎么算——这里抽出来避免两个函数各写一份、将来改疲劳公式时漏掉一处。
 */
function fatigueMultiplier(p: PaceParams, elapsedSec: number): number {
  return 1 + (p.fatiguePctPerHour / 100) * (elapsedSec / 3600)
}

/** 实用档:平路时间 + 爬升时间 + 下坡附加,再乘疲劳系数。 */
export function practicalSegmentTime(seg: SegmentLike, p: PaceParams, elapsedSec: number): number {
  const base = (seg.dist / 1000) * p.flatPaceSecPerKm + (seg.gain / p.vamMPerH) * 3600 + seg.loss * p.descentFactor
  return base * fatigueMultiplier(p, elapsedSec)
}

/**
 * Tobler 档:按净坡度取 Tobler 速度,再用"用户平路配速 ÷ Tobler 平地速度"
 * 得到的缩放系数去校正——这样同一个用户在平地上,Tobler 档和实用档给出的
 * 时间一致,坡度带来的相对快慢仍然遵循 Tobler 曲线的形状。
 */
export function toblerSegmentTime(seg: SegmentLike, p: PaceParams, elapsedSec: number): number {
  const slope = seg.dist > 0 ? (seg.gain - seg.loss) / seg.dist : 0
  const scale = 3600 / p.flatPaceSecPerKm / toblerSpeed(0)
  const kmh = toblerSpeed(slope) * scale
  const base = (seg.dist / 1000 / kmh) * 3600
  return base * fatigueMultiplier(p, elapsedSec)
}

export type WarnLevel = 'green' | 'yellow' | 'red'
export interface Arrival { etaMs: number; level: WarnLevel; marginSec: number }

/**
 * 逐段累加耗时(把当前已耗时喂给下一段,让疲劳效应跨段复利式生效),算出
 * 每个 CP 的预计到达时间,再对照关门时间给出红/黄/绿三档预警。
 *
 * 黄色阈值 `max(segTime*0.15, 1200)` 是刻意的双下限:短段(比如 5 分钟的
 * 补给站间距)用 15% 比例算出来的余量可能只有几十秒,一次小小的配速波动
 * 就会从"绿"跳成"错过",所以额外兜底一个 1200 秒(20 分钟)的绝对下限。
 */
export function estimateArrivals(
  segs: SegmentLike[],
  p: PaceParams,
  startMs: number,
  cutoffsMs: (number | undefined)[],
): Arrival[] {
  const segmentTime = p.model === 'tobler' ? toblerSegmentTime : practicalSegmentTime
  let elapsedSec = 0
  const arrivals: Arrival[] = []
  for (let i = 0; i < segs.length; i++) {
    const segTime = segmentTime(segs[i], p, elapsedSec)
    elapsedSec += segTime
    const etaMs = startMs + elapsedSec * 1000
    const cutoff = cutoffsMs[i]
    if (cutoff === undefined) {
      arrivals.push({ etaMs, level: 'green', marginSec: Infinity })
      continue
    }
    const marginSec = (cutoff - etaMs) / 1000
    const yellowThreshold = Math.max(segTime * 0.15, 1200)
    const level: WarnLevel = marginSec < 0 ? 'red' : marginSec < yellowThreshold ? 'yellow' : 'green'
    arrivals.push({ etaMs, level, marginSec })
  }
  return arrivals
}
