/**
 * Pure presentation logic for `PerformancePanel.tsx` (P2 §3.3, milestone
 * Q3) -- formatting helpers, gradient-band bucketing and the panel's
 * availability decision, all kept framework-free so they're unit-testable
 * under Vitest's `node` environment (no jsdom in this project -- see
 * `PerformancePanel.tsx`'s own file comment for why the component itself is
 * NOT covered by an automated test).
 */
import type { TrackKind } from '../core/perf/trackKind'
import type { GradeSegment, GradeSegmentType } from '../core/perf/climbs'
import type { EnvCompensation } from '../core/perf/env'

const PLACEHOLDER = '--'

/** "12:34/km" (mm:ss); `undefined`/non-positive input -> placeholder,
 * matching the rest of the app's convention for "not computable" (never a
 * fabricated 0:00). */
export function formatPaceMinPerKm(secPerKm: number | undefined): string {
  if (secPerKm === undefined || !Number.isFinite(secPerKm) || secPerKm <= 0) return PLACEHOLDER
  const m = Math.floor(secPerKm / 60)
  const s = Math.round(secPerKm % 60)
  return `${m}:${String(s).padStart(2, '0')}/km`
}

/** "3小时25分" / "42分钟" -- elapsed-time display for 核心指标/主要爬坡.
 * Rounds to the nearest minute; negative/non-finite input -> placeholder. */
export function formatDurationHM(totalSeconds: number | undefined): string {
  if (totalSeconds === undefined || !Number.isFinite(totalSeconds) || totalSeconds < 0) return PLACEHOLDER
  const totalMin = Math.round(totalSeconds / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m}分钟`
  return `${h}小时${m}分`
}

/** "12.34 km" from a metre figure. */
export function formatKm(meters: number): string {
  if (!Number.isFinite(meters)) return PLACEHOLDER
  return `${(meters / 1000).toFixed(2)} km`
}

/** "1234 m" from a metre figure, rounded to the nearest metre. */
export function formatMeters(meters: number | undefined): string {
  if (meters === undefined || !Number.isFinite(meters)) return PLACEHOLDER
  return `${Math.round(meters)} m`
}

/** "+12.3%" / "-4.0%" -- signed one-decimal grade display. */
export function formatGradePct(pct: number): string {
  if (!Number.isFinite(pct)) return PLACEHOLDER
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

// ── 坡度分布 (grade-band bucketing) ────────────────────────────────────────

export const GRADE_BAND_LABEL: Record<GradeSegmentType, string> = {
  uphill: '上坡 (>5%)',
  flat: '平地 (-5%~5%)',
  downhill: '下坡 (<-5%)',
}

/** Display order for the 坡度分布 bar breakdown -- uphill first (what a
 * trail runner cares most about), flat, then downhill. */
export const GRADE_BAND_ORDER: GradeSegmentType[] = ['uphill', 'flat', 'downhill']

export interface GradeBandSummary {
  type: GradeSegmentType
  label: string
  /** Summed segment distance (m) for this band. */
  distanceM: number
  /** Share of the segmented distance, 0-100. 0 when there is no segmented
   * distance at all (e.g. `gradeSegments` is empty), never `NaN`. */
  pct: number
}

/**
 * Buckets `computeGradeSegments`' output into the three grade bands for a
 * simple horizontal bar breakdown (P2 §3.3: "不引入图表库" -- percentages
 * feeding a plain `<div>` width, no charting library). Percentages are of
 * the segmented distance (the sum of every segment TrailCraft.ts's own
 * `MIN_SEGMENT_POINTS` gate kept), which can be slightly less than the
 * track's full distance -- short transitional segments below that gate are
 * dropped by `computeGradeSegments` itself, not by this function.
 */
export function summarizeGradeBands(segments: GradeSegment[]): GradeBandSummary[] {
  const totals: Record<GradeSegmentType, number> = { uphill: 0, flat: 0, downhill: 0 }
  for (const seg of segments) totals[seg.type] += seg.distance
  const total = totals.uphill + totals.flat + totals.downhill
  return GRADE_BAND_ORDER.map((type) => ({
    type,
    label: GRADE_BAND_LABEL[type],
    distanceM: totals[type],
    pct: total > 0 ? (totals[type] / total) * 100 : 0,
  }))
}

/** Minimum ascent (m) for an uphill grade segment to be listed under 主要爬坡
 * -- `computeGradeSegments` already drops short transitional segments (its
 * own `MIN_SEGMENT_POINTS` gate), but that's a POINT-COUNT filter, not an
 * ascent-magnitude one, so a long, gently-graded (just over 5%) stretch with
 * little real climbing could still pass it. 30m keeps the list to segments a
 * runner would actually call "a climb" without hard-coding a specific race's
 * profile. */
const SIGNIFICANT_CLIMB_MIN_ASCENT_M = 30

/** Uphill segments worth surfacing individually in 主要爬坡, sorted by where
 * they start. See `SIGNIFICANT_CLIMB_MIN_ASCENT_M` for why a distance/point
 * filter alone (already applied upstream) isn't enough. */
export function significantClimbs(segments: GradeSegment[]): GradeSegment[] {
  return segments
    .filter((s) => s.type === 'uphill' && s.ascent >= SIGNIFICANT_CLIMB_MIN_ASCENT_M)
    .sort((a, b) => a.startDist - b.startDist)
}

// ── 深度分析: environmental compensation one-liner ─────────────────────────

/**
 * One-line explanation of what `envCompensation.totalFactor` adjusted for
 * (P2 §3.3 深度分析 requirement) -- makes the multiplier auditable instead of
 * a bare number. Heat/humidity only ever move off 1.0 when the caller
 * supplied a temperature (`computePerformance`'s `profile` argument, still
 * unwired to any weather source -- see `core/perf/env.ts`'s file comment),
 * so the note says so explicitly rather than silently describing an inert
 * factor as if it were live.
 */
export function envCompensationNote(env: EnvCompensation): string {
  const altNote =
    env.altFactor > 1
      ? `海拔修正 ×${env.altFactor.toFixed(3)}（轨迹平均海拔较高，体能按文献比例打折）`
      : '海拔修正 ×1.000（平均海拔不足300m，未触发）'
  const heatNote =
    env.heatFactor > 1
      ? `温湿度修正 ×${env.heatFactor.toFixed(3)}（按输入的气温/湿度下调）`
      : '温湿度修正 ×1.000（未输入气温/湿度，暂未生效）'
  return `综合环境修正系数 ×${env.totalFactor.toFixed(3)} = ${altNote}；${heatNote}`
}

// ── Shared honesty disclosure (P2 §5, non-negotiable) ──────────────────────

/**
 * The score's disclosure text, shared verbatim between the real-track report
 * (`PerformancePanel.tsx`'s 核心指标 section) and the track-free quick
 * calculator (`QuickCalcPanel.tsx`) -- P2 §5 requires this be visible
 * wherever the score is shown, and a calculator that types its own second
 * copy is exactly how the two would drift apart over time. Never label the
 * score "ITRA 积分" anywhere this string (or an equivalent) isn't shown.
 */
export const PERF_DISCLAIMER =
  '「表现分(社区估算)」是基于爬升 / 配速 / 环境的社区反向推导模型,不是官方 ITRA 积分,' +
  '标定依赖若干假设(精英参考区间取 900-960 分档而非公开的逐运动员官方成绩;部分赛事赛道数据为估算值),' +
  '仅供个人训练参考,不代表任何官方认证结果。'

// ── Entry-point availability decision (P2 §3.3, the whole point of Q1) ────

export type PerfAvailabilityStatus = 'available' | 'planned' | 'uncertain'

export interface PerfAvailability {
  status: PerfAvailabilityStatus
  /** Short heading for the explanatory pane; empty for `available` (the
   * panel renders the real report instead, no heading needed here). */
  title: string
  /** Chinese explanation for direct UI display; empty for `available`. */
  message: string
}

/**
 * The panel's entry-point gate (P2 §3.3): "offered only when
 * `resolveTrackKind` returns `recorded`". Kept as a pure function of just
 * the resolved `TrackKind` (not a full `Track`) so the decision itself is
 * unit-testable without constructing track fixtures -- `PerformancePanel.tsx`
 * is the only caller, feeding it `resolveTrackKind(track).kind`.
 *
 * The `planned`/`uncertain` copy here is deliberately richer than
 * `core/perf/score.ts#PerformanceNotApplicable.message` (which exists to
 * gate the SCORE computation itself, and is reused verbatim for the OTHER
 * not-applicable reasons -- no elevation/time/points -- that can still occur
 * on a `recorded` track): this is the panel's own entry point, so it names
 * the complementary features by their actual sidebar labels (「配速与关门
 * 预警」, 分段表) rather than just stating the gate fired.
 */
export function perfAvailability(kind: TrackKind): PerfAvailability {
  if (kind === 'recorded') return { status: 'available', title: '', message: '' }

  if (kind === 'planned') {
    return {
      status: 'planned',
      title: '规划路线暂无表现分析',
      message:
        '表现分析回答的是"跑得怎么样"——配速、爬升、用时都来自一次真实记录下来的跑步数据，规划路线还没有跑过，没有这些数据可分析。\n' +
        '规划路线回答的是另一个问题——"能不能按时完赛"：请看侧边栏「配速与关门预警」面板的到达时间估算，以及分段表里逐段的关门时间对照。两者是互补关系，不是谁替代谁：规划路线告诉你能不能按时完赛，实跑记录告诉你跑得怎么样。',
    }
  }

  // uncertain
  return {
    status: 'uncertain',
    title: '尚未确定轨迹类型',
    message:
      '这条轨迹的实跑/规划判定证据不足，暂时无法计算表现分。请在轨迹列表该轨迹的类型下拉框中手动指定为"实跑"，确认后即可查看表现分析。',
  }
}
