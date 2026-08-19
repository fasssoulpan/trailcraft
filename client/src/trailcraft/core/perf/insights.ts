/**
 * 行动建议(P3-R5 commit 3)—— `fit-ride-studio` 参考项目报告结构里
 * "核心指标 / 坡度 / 主要爬坡 / 深度分析 / 行动建议" 最后一节的移植。前四节
 * 回答的是"这次跑得数字上是什么样"，这一节要回答的是"下一步该看哪"——但
 * 这正是整个 P3-R5 里风险最高的一块:这个项目已经在 `docs/P0-验收记录.md`
 * §五吃过"静默编造数据"的亏，一条洞察如果背后没有真实测量出的数字撑着，
 * 就是穿着一句话外衣的编造数据。
 *
 * 硬性要求(贯穿本文件每一个探测函数):
 * 1. 每条洞察必须引用一个具体测量出来的数字，并把它写进文案里——
 *    「你在 60km 后配速下降 23%」是有用的洞察，「注意补给和配速」这种套
 *    在任何轨迹上都成立的场面话决不允许出现。
 * 2. 触发阈值是命名常量，每个都写明为什么选这个数——阈值定得随意，等于
 *    变相允许在噪声上生成"看起来煞有介事"的建议，这和编造数据是同一类
 *    问题的两种表现形式。
 * 3. 没有任何一条阈值被命中时返回空数组——面板对应展示"本次没有特别需要
 *    指出的问题"，而不是硬凑一条空话填满这一节。
 * 4. 只消费应用已经算出来的东西(分段配速/GAP、爬坡分段、传感器覆盖率、
 *    CP 关门时间与实际到达时间的差)，不重新发明任何一套分析算法——这里
 *    只是在已有数字上加一层"哪些数字足够极端、值得单独说一句"的筛选。
 *
 * 门禁:和 `climbs.ts`/`splits.ts`/`gap.ts` 一样，`deriveInsights` 本身
 * 不重复判断轨迹是不是 `recorded`——它消费的 `splits`/`gradeSegments` 本来
 * 就只在 `core/perf/score.ts#analyze` 判定为 `recorded` 且爬升/时间等前置
 * 条件都满足后才有意义。真正面向 Track 的入口 `deriveInsightsForTrack`
 * 额外做了一层防御性 gate(见其文档注释)，但调用方(`PerformancePanel.tsx`)
 * 本身也应该像 深度分析/坡度分布 等其它小节一样只在 `perfAvailability`
 * 判定为 `available` 时才渲染这一节。
 */
import type { Track } from '../model/track'
import type { CheckPoint } from '../model/checkpoint'
import type { StatsOptions } from '../stats/segments'
import type { KmSplit } from './splits'
import type { GradeSegment } from './climbs'
import type { SensorCoverageSummary } from './sensorCoverage'
import { computeSensorCoverage } from './sensorCoverage'
import { computePerformance } from './score'
import type { EnvUserProfile } from './env'

export type InsightId =
  | 'late_pace_decay'
  | 'costliest_climb'
  | 'cutoff_margin_thin'
  | 'cutoff_margin_missed'
  | 'split_anomaly_slow'
  | 'split_anomaly_fast'
  | 'sensor_gap'

export interface Insight {
  id: InsightId
  /** 中文文案，直接供 UI 展示——按硬性要求 1，必须包含具体数字。 */
  text: string
  /** 支撑 `text` 的结构化证据，供测试核对文案里的数字确实来自这里，不是
   *  拼出来的；也方便未来 UI 想要单独展示某个数字时不必重新解析文案。 */
  evidence: Record<string, number | string>
}

/** 单个 CP 的"实际到达时间 vs 关门时间"证据——由 `computeActualCutoffMargins`
 *  产出，和 `core/pace/models.ts#estimateArrivals` 的"赛前预计到达时间"是
 *  两回事:那个函数算的是还没跑之前、按配速模型估出来的到达时间；这里用的
 *  是轨迹自己 `time` 列里真实记录到的到达时刻，是事后回看"当时到底有多
 *  紧张"，而不是赛前规划。 */
export interface CutoffMarginEvidence {
  cpName: string
  /** 关门时刻 - 实际到达时刻，秒。正数=提前到达，负数=错过关门。 */
  marginSec: number
}

export interface InsightsInput {
  totalDistanceM: number
  totalTimeS: number
  splits: KmSplit[]
  gradeSegments: GradeSegment[]
  sensorCoverage: SensorCoverageSummary
  cutoffMargins: CutoffMarginEvidence[]
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function round1(x: number): number {
  return Math.round(x * 10) / 10
}

/** "5:12/km"，本文件内部使用——不从 `ui/perfFormat.ts` 导入，`core/` 不
 *  依赖 `ui/`(和这个项目其它 core 模块的分层一致)。 */
function formatPaceLocal(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60)
  const s = Math.round(secPerKm % 60)
  return `${m}:${String(s).padStart(2, '0')}/km`
}

/** 秒数格式化成"X分钟"（不足 60 秒时"X秒"）——关门余量/超时量的展示单位。 */
function formatDurationRough(absSec: number): string {
  if (absSec < 60) return `${Math.round(absSec)}秒`
  return `${Math.round(absSec / 60)}分钟`
}

function formatKmRange(startDistM: number, endDistM: number): string {
  return `${(startDistM / 1000).toFixed(1)}km-${(endDistM / 1000).toFixed(1)}km`
}

// ---------------------------------------------------------------------------
// 1. 后半程配速衰减:前三分之一 vs 后三分之一的平均 GAP
// ---------------------------------------------------------------------------

/** 前/后三分之一至少各要有这么多个带 GAP 读数的整公里分段，"前后段配速
 *  对比"才立得住——样本太少时一两个分段的噪声就能把均值带偏，不构成"后半
 *  程普遍变慢"的证据。 */
const MIN_GAP_SAMPLES_PER_THIRD = 2
/** 总分段数至少要达到这个数，三等分后每一段才可能有 `MIN_GAP_SAMPLES_
 *  PER_THIRD` 个样本(6 = 3 等分 × 每份至少 2 个)。 */
const MIN_SPLITS_FOR_PACE_DECAY = 6
/** 后三分之一均值 GAP 相对前三分之一慢出这个比例才算"明显掉速"。
 *  `core/perf/score.ts` 自己的耐力衰减模型(Riegel M/K 物理区间)认为
 *  10 倍里程量级下的合理配速衰减也就 13%-37%——同一次比赛内前后三分之一
 *  这种量级的距离差，正常疲劳带来的漂移远小于这个数量级；15% 只在明显
 *  偏离"正常疲劳曲线"时才触发，不是随手挑的门槛。 */
const LATE_PACE_DECAY_THRESHOLD_PCT = 15

function lateGapDecayInsight(splits: KmSplit[]): Insight | undefined {
  if (splits.length < MIN_SPLITS_FOR_PACE_DECAY) return undefined
  const thirdLen = Math.floor(splits.length / 3)
  const firstThird = splits.slice(0, thirdLen)
  const lastThird = splits.slice(splits.length - thirdLen)
  const firstGaps = firstThird.map((s) => s.gap).filter((g): g is number => g !== undefined)
  const lastGaps = lastThird.map((s) => s.gap).filter((g): g is number => g !== undefined)
  if (firstGaps.length < MIN_GAP_SAMPLES_PER_THIRD || lastGaps.length < MIN_GAP_SAMPLES_PER_THIRD) return undefined

  const meanFirst = mean(firstGaps)
  const meanLast = mean(lastGaps)
  if (!(meanFirst > 0)) return undefined
  const decayPct = ((meanLast - meanFirst) / meanFirst) * 100
  if (decayPct < LATE_PACE_DECAY_THRESHOLD_PCT) return undefined

  const firstRange = `${firstThird[0].km}-${firstThird[firstThird.length - 1].km}`
  const lastRange = `${lastThird[0].km}-${lastThird[lastThird.length - 1].km}`
  return {
    id: 'late_pace_decay',
    text:
      `后半程配速明显下降:前段(第 ${firstRange} 公里)平均 GAP ${formatPaceLocal(meanFirst)}，` +
      `后段(第 ${lastRange} 公里)平均 GAP ${formatPaceLocal(meanLast)}，慢了 ${decayPct.toFixed(0)}%。`,
    evidence: {
      firstRangeKm: firstRange,
      lastRangeKm: lastRange,
      meanFirstGapSecPerKm: round1(meanFirst),
      meanLastGapSecPerKm: round1(meanLast),
      decayPct: round1(decayPct),
    },
  }
}

// ---------------------------------------------------------------------------
// 2. 最费时的爬坡:耗时占比相对距离占比的倍数
// ---------------------------------------------------------------------------

/** 一段爬坡"耗时占比 / 距离占比"的比值超过这个数，才算"明显不成比例地
 *  费时"——1.5 倍意味着这段爬坡拖慢整体节奏的程度比它在全程距离里占的
 *  份额多出至少 50%，不是坡度稍陡带来的正常耗时。 */
const COSTLIEST_CLIMB_RATIO_THRESHOLD = 1.5
/** 爬坡至少要占这么大的距离份额才纳入比较——距离占比太小时，时间占比的
 *  比值对噪声极其敏感(哪怕只是几十米的短爬坡，也可能因为一两个采样点
 *  就得到夸张的比值)。 */
const COSTLIEST_CLIMB_MIN_DISTANCE_SHARE = 0.03

function costliestClimbInsight(
  gradeSegments: GradeSegment[],
  totalDistanceM: number,
  totalTimeS: number,
): Insight | undefined {
  if (!(totalDistanceM > 0) || !(totalTimeS > 0)) return undefined

  let best: { seg: GradeSegment; ratio: number; distanceShare: number; timeShare: number } | undefined
  for (const seg of gradeSegments) {
    if (seg.type !== 'uphill') continue
    if (seg.time === undefined || !(seg.time > 0)) continue
    const distanceShare = seg.distance / totalDistanceM
    if (distanceShare < COSTLIEST_CLIMB_MIN_DISTANCE_SHARE) continue
    const timeShare = seg.time / totalTimeS
    const ratio = timeShare / distanceShare
    if (ratio < COSTLIEST_CLIMB_RATIO_THRESHOLD) continue
    if (!best || ratio > best.ratio) best = { seg, ratio, distanceShare, timeShare }
  }
  if (!best) return undefined

  const { seg, ratio, distanceShare, timeShare } = best
  return {
    id: 'costliest_climb',
    text:
      `${formatKmRange(seg.startDist, seg.endDist)} 的爬坡(爬升 ${Math.round(seg.ascent)}m)只占全程距离的 ` +
      `${(distanceShare * 100).toFixed(0)}%，却用掉了 ${(timeShare * 100).toFixed(0)}% 的时间——是距离占比的 ` +
      `${ratio.toFixed(1)} 倍，是本次相对最费时的爬坡段。`,
    evidence: {
      startDistM: Math.round(seg.startDist),
      endDistM: Math.round(seg.endDist),
      ascentM: Math.round(seg.ascent),
      distanceSharePct: round1(distanceShare * 100),
      timeSharePct: round1(timeShare * 100),
      ratio: round1(ratio),
    },
  }
}

// ---------------------------------------------------------------------------
// 3. 关门余量过紧 / 实际已超时
// ---------------------------------------------------------------------------

/** 关门余量在这个秒数以内算"紧张"。直接复用 `core/pace/models.ts` 里
 *  `estimateArrivals` 自己的 20 分钟绝对下限——那个文件的注释解释了为什么
 *  需要一个不随分段长短变化的绝对下限(短分段按比例算出来的余量可能只有
 *  几十秒)。这里是回顾"实际跑出来的余量"而不是赛前估算，用同一个数字
 *  保持两处"多紧算紧张"的口径一致，不引入第二个容易分歧的判断。 */
const THIN_CUTOFF_MARGIN_SEC = 1200

function cutoffMarginInsights(margins: CutoffMarginEvidence[]): Insight[] {
  const out: Insight[] = []
  for (const m of margins) {
    if (m.marginSec < 0) {
      out.push({
        id: 'cutoff_margin_missed',
        text: `实际到达「${m.cpName}」的时间晚于关门时间 ${formatDurationRough(-m.marginSec)}，已超出关门限制。`,
        evidence: { cpName: m.cpName, marginSec: round1(m.marginSec) },
      })
    } else if (m.marginSec < THIN_CUTOFF_MARGIN_SEC) {
      out.push({
        id: 'cutoff_margin_thin',
        text: `实际到达「${m.cpName}」时距关门只剩 ${formatDurationRough(m.marginSec)}，余量偏紧。`,
        evidence: { cpName: m.cpName, marginSec: round1(m.marginSec) },
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 4. 异常分段(明显偏离全程平均配速的单公里)
// ---------------------------------------------------------------------------

/** 单公里配速偏离全程平均配速的比例超过这个数，才算"异常分段"——排除掉
 *  正常地形起伏带来的配速波动(坡度分布/主要爬坡已经在解释"为什么这一公里
 *  慢"，这里只挑真正显眼、值得单独点出来的分段)。 */
const SPLIT_ANOMALY_PCT = 30
/** 至少要有这么多个可比较的整公里分段，"全程平均配速"才有统计意义。 */
const MIN_SPLITS_FOR_ANOMALY = 5
/** 排除小于这个距离的收尾分段——`splits.ts` 的最后一段吸收不足 1 公里的
 *  剩余距离，配速统计在只剩几十米时噪声极大，不该被当成"异常分段"报出来。 */
const TRAILING_SPLIT_MIN_DISTANCE_M = 500

function splitAnomalyInsights(splits: KmSplit[]): Insight[] {
  const usable = splits.filter(
    (s): s is KmSplit & { pace: number } => s.pace !== undefined && s.distance >= TRAILING_SPLIT_MIN_DISTANCE_M,
  )
  if (usable.length < MIN_SPLITS_FOR_ANOMALY) return []

  const avgPace = mean(usable.map((s) => s.pace))
  if (!(avgPace > 0)) return []

  let slowest: { split: KmSplit; devPct: number } | undefined
  let fastest: { split: KmSplit; devPct: number } | undefined
  for (const s of usable) {
    const devPct = ((s.pace - avgPace) / avgPace) * 100
    if (devPct >= SPLIT_ANOMALY_PCT && (!slowest || devPct > slowest.devPct)) slowest = { split: s, devPct }
    if (-devPct >= SPLIT_ANOMALY_PCT && (!fastest || -devPct > -fastest.devPct)) fastest = { split: s, devPct }
  }

  const out: Insight[] = []
  if (slowest) {
    out.push({
      id: 'split_anomaly_slow',
      text:
        `第 ${slowest.split.km} 公里配速 ${formatPaceLocal(slowest.split.pace!)}，比全程平均配速慢 ` +
        `${slowest.devPct.toFixed(0)}%，是本次波动最大的一段。`,
      evidence: {
        km: slowest.split.km,
        paceSecPerKm: slowest.split.pace!,
        avgPaceSecPerKm: round1(avgPace),
        devPct: round1(slowest.devPct),
      },
    })
  }
  if (fastest) {
    out.push({
      id: 'split_anomaly_fast',
      text:
        `第 ${fastest.split.km} 公里配速 ${formatPaceLocal(fastest.split.pace!)}，比全程平均配速快 ` +
        `${(-fastest.devPct).toFixed(0)}%，明显快于其它公里段。`,
      evidence: {
        km: fastest.split.km,
        paceSecPerKm: fastest.split.pace!,
        avgPaceSecPerKm: round1(avgPace),
        devPct: round1(fastest.devPct),
      },
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 5. 传感器覆盖缺口
// ---------------------------------------------------------------------------

/** 传感器覆盖率低于这个比例，才提示"这项数据不足以支撑判断"——50% 意味着
 *  一半以上的点根本没有读数，任何基于它的平均值/最值都已经不能代表整条
 *  轨迹。 */
const SENSOR_GAP_COVERAGE_THRESHOLD = 0.5

const SENSOR_GAP_LABELS: Record<keyof SensorCoverageSummary, string> = {
  hr: '心率', cadence: '步频/踏频', power: '功率', temperature: '气温',
}
const SENSOR_GAP_ORDER: (keyof SensorCoverageSummary)[] = ['hr', 'cadence', 'power', 'temperature']

function sensorGapInsights(coverage: SensorCoverageSummary): Insight[] {
  const out: Insight[] = []
  for (const key of SENSOR_GAP_ORDER) {
    const stat = coverage[key]
    if (!stat.present) continue // 整列都没有,是更基础的"没有这个传感器",不是"有缺口"
    if (stat.coverage >= SENSOR_GAP_COVERAGE_THRESHOLD) continue
    const label = SENSOR_GAP_LABELS[key]
    out.push({
      id: 'sensor_gap',
      text:
        `${label}覆盖率只有 ${(stat.coverage * 100).toFixed(0)}%(${stat.validCount}/${stat.totalCount} 个点有读数)，` +
        `基于${label}的判断在本次分析中不可靠。`,
      evidence: {
        sensor: key,
        coveragePct: round1(stat.coverage * 100),
        validCount: stat.validCount,
        totalCount: stat.totalCount,
      },
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 汇总入口
// ---------------------------------------------------------------------------

/**
 * 从已经算好的分析结果里筛出"值得单独说一句"的洞察，固定顺序输出(和本
 * 文件小节顺序一致:后程掉速 → 最费时爬坡 → 关门余量 → 异常分段 → 传感器
 * 缺口)，方便测试和展示都有确定性的排列。任何一步的输入是空/退化的
 * (没有分段、没有爬坡、单点轨迹……)都只是让对应探测函数返回"未命中"，
 * 不会抛错——见本文件顶部硬性要求 3。
 */
export function deriveInsights(input: InsightsInput): Insight[] {
  const out: Insight[] = []
  const decay = lateGapDecayInsight(input.splits)
  if (decay) out.push(decay)
  const climb = costliestClimbInsight(input.gradeSegments, input.totalDistanceM, input.totalTimeS)
  if (climb) out.push(climb)
  out.push(...cutoffMarginInsights(input.cutoffMargins))
  out.push(...splitAnomalyInsights(input.splits))
  out.push(...sensorGapInsights(input.sensorCoverage))
  return out
}

/**
 * 从轨迹自己的 `time` 列读出"实际到达每个设了关门时间的 CP 的时刻"，和
 * `cutoffTime` 相减——这是"事后回看当时有多紧张"，不是
 * `core/pace/models.ts#estimateArrivals` 那种赛前按配速模型估算的到达
 * 时间(那个函数需要还没发生的未来配速假设；这里只需要轨迹自己已经记录下
 * 来的真实时间戳，两者不应该、也不需要共用同一套推导)。
 *
 * `cp.anchorIndex` 按 `buildCheckpointCardData` 同样的方式 clamp 进轨迹的
 * 有效点范围(工具箱抽稀等操作可能让旧的 anchorIndex 越界)。`cutoffTime`
 * 缺失/无法解析、或该点没有有限的时间戳读数的 CP 直接跳过，不产出一条
 * "余量未知"的假证据。
 */
export function computeActualCutoffMargins(track: Track, cps: CheckPoint[]): CutoffMarginEvidence[] {
  const time = track.points.time
  if (!time || time.length === 0) return []
  const n = time.length
  const out: CutoffMarginEvidence[] = []
  for (const cp of cps) {
    if (cp.trackId !== track.id) continue
    if (!cp.cutoffTime) continue
    const cutoffMs = Date.parse(cp.cutoffTime)
    if (Number.isNaN(cutoffMs)) continue
    const idx = Math.min(Math.max(cp.anchorIndex, 0), n - 1)
    const arrivalMs = time[idx]
    if (!Number.isFinite(arrivalMs)) continue
    out.push({ cpName: cp.name, marginSec: (cutoffMs - arrivalMs) / 1000 })
  }
  return out
}

/**
 * 面向 `Track` 的便捷入口——`PerformancePanel.tsx` 只需要这一个函数。内部
 * 复用 `computePerformance` 的 `WeakMap` 缓存(和面板其它小节共享同一份
 * 结果，不重复计算)，并在这里再做一层防御性 gate:只有 `analysis.
 * applicable` 为真(意味着 `resolveTrackKind` 已判定为 `recorded`，且
 * 爬升/时间等前置条件都满足)才会实际产出洞察，否则返回空数组——这是本
 * 文件顶部"只对 recorded 轨迹生效"这条要求的硬保证，不只是依赖调用方
 * 记得先检查。
 */
export function deriveInsightsForTrack(
  track: Track,
  statsOptions: StatsOptions,
  cps: CheckPoint[],
  profile: EnvUserProfile = {},
): Insight[] {
  const analysis = computePerformance(track, statsOptions, profile)
  if (!analysis.applicable) return []
  const input: InsightsInput = {
    totalDistanceM: analysis.totalDistanceM,
    totalTimeS: analysis.totalTimeS,
    splits: analysis.splits,
    gradeSegments: analysis.gradeSegments,
    sensorCoverage: computeSensorCoverage(track.points),
    cutoffMargins: computeActualCutoffMargins(track, cps),
  }
  return deriveInsights(input)
}
