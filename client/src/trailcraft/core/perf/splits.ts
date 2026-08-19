/**
 * Per-kilometre split statistics, ported from
 * `cyber-trail-hud/src/analysis/splits.js` (P2 §3.2, milestone Q2). User's
 * own project, no licence obstacle.
 *
 * Cuts the track at each whole-kilometre mark (the last split absorbs
 * whatever distance remains, however short) and reports pace/GAP/ascent/
 * descent/heart-rate/grade per split.
 *
 * Porting notes: the split-boundary logic is numerically identical to the
 * reference.
 *
 * ── Per-split ascent/descent (P2 Q2 commit 1) ───────────────────────────
 * Originally (milestone Q2's first cut) this used the reference's own
 * per-point diff threshold (>2m / <-2m), distinct from and NOT routed
 * through P0's `computeGainLoss` hysteresis. Fixed for the same reason and
 * the same way as `climbs.ts` (see that file's header comment for the full
 * rationale, the path-dependence subtlety, and why prefix-difference is the
 * right definition): ascent/descent here are now
 * `runningGain[to] - runningGain[from]` / `runningLoss[to] - runningLoss[from]`
 * over `core/stats/runningStats.ts#buildRunningGain`/`buildRunningLoss`'s
 * whole-track prefix arrays, honouring the same `statsOptions` as the
 * track-total ascent feeding the score. Unlike `climbs.ts`'s grade
 * segments (which can drop short transitional segments below
 * `MIN_SEGMENT_POINTS`), splits always partition the whole track with no
 * gaps, so per-split ascent/descent sum to the whole-track total exactly
 * (up to per-split rounding) for every track, not just specially-shaped
 * ones -- see this file's test suite.
 *
 * Adapted for the columnar model: consumes `pointSeries.ts#PointSeries` (dist/
 * elapsedSec/grade) and `gap.ts#TrackGap` (gap) plus `track.points.ele`/`hr`
 * directly, instead of the reference's array of enriched point objects.
 */
import type { Track } from '../model/track'
import type { StatsOptions } from '../stats/segments'
import { buildRunningGainLoss } from '../stats/runningStats'
import { derivePointSeries, type PointSeries } from './pointSeries'
import type { TrackGap } from './gap'

// Same defaults as core/stats/segments.ts's DEFAULT_THRESHOLD/
// DEFAULT_SMOOTH_WINDOW (not exported from there) -- mirrors score.ts's own
// local copy of the same constants, used as the fallback when a caller
// doesn't supply `statsOptions`.
const DEFAULT_THRESHOLD = 5
const DEFAULT_SMOOTH_WINDOW = 5

export interface KmSplit {
  /** 1-based split number. */
  km: number
  /** Actual distance covered (m), close to 1000 except the final split. */
  distance: number
  /** Duration (s); `undefined` when the track has no time column. */
  time: number | undefined
  /** Pace (s/km); `undefined` when `time` is `undefined` or distance is 0. */
  pace: number | undefined
  /** Mean GAP pace (s/km) over points with a computable GAP; `undefined`
   * when no point in the split has one (see `gap.ts#computeTrackGap`). */
  gap: number | undefined
  /** Ascent/descent (m) within the split -- prefix difference over P0's
   * threshold-hysteresis running totals, see file comment. */
  ascent: number
  descent: number
  /** Mean heart rate (bpm); `undefined` when the track has no `hr` column or
   * no point in the split has a reading. */
  avgHR: number | undefined
  /** Mean local grade (%) over the split's points. */
  avgGrade: number
}

const KM_MARK_M = 1000

function buildSplit(
  track: Track,
  s: PointSeries,
  gapResult: TrackGap | undefined,
  from: number,
  to: number,
  kmNumber: number,
  runningGain: Float64Array,
  runningLoss: Float64Array,
): KmSplit {
  const { dist, elapsedSec, grade } = s
  const hr = track.points.hr

  const distance = dist[to] - dist[from]
  const time = elapsedSec ? elapsedSec[to] - elapsedSec[from] : undefined
  const pace = time !== undefined && distance > 0 ? time / (distance / 1000) : undefined

  // Prefix difference over the whole-track running totals -- see this
  // file's header comment. Empty arrays (no elevation column) -> zero,
  // matching the old `if (ele)` guard's behaviour.
  const ascent = runningGain.length > 0 ? runningGain[to] - runningGain[from] : 0
  const descent = runningLoss.length > 0 ? runningLoss[to] - runningLoss[from] : 0

  let avgHR: number | undefined
  if (hr) {
    let sum = 0
    let count = 0
    for (let i = from; i <= to; i++) {
      if (hr[i] !== 0) { sum += hr[i]; count++ }
    }
    avgHR = count > 0 ? Math.round(sum / count) : undefined
  }

  let avgGrade = 0
  if (grade) {
    let sum = 0
    for (let i = from; i <= to; i++) sum += grade[i]
    avgGrade = sum / (to - from + 1)
  }

  let avgGAP: number | undefined
  if (gapResult) {
    let sum = 0
    let count = 0
    for (let i = from; i <= to; i++) {
      const g = gapResult.gap[i]
      if (Number.isFinite(g) && g > 0) { sum += g; count++ }
    }
    avgGAP = count > 0 ? sum / count : undefined
  }

  return {
    km: kmNumber,
    distance: Math.round(distance),
    time: time !== undefined ? Math.round(time) : undefined,
    pace: pace !== undefined ? Math.round(pace) : undefined,
    gap: avgGAP !== undefined ? Math.round(avgGAP) : undefined,
    ascent: Math.round(ascent),
    descent: Math.round(descent),
    avgHR,
    avgGrade: Math.round(avgGrade * 10) / 10,
  }
}

/**
 * Splits `track` at each kilometre mark. Returns an empty array for a
 * track with fewer than 2 points, matching the reference's own guard.
 *
 * `series`/`gapResult` may be passed in by a caller sharing them across
 * modules (see `gap.ts#computeTrackGap`'s doc comment) -- omitted, a fresh
 * `PointSeries` is derived and GAP is left out of the result (`gap` is
 * always `undefined` in that case), which is what standalone unit tests
 * exercise unless they explicitly want GAP figures too.
 *
 * `statsOptions` (threshold + smoothing window) is forwarded to
 * `buildRunningGain`/`buildRunningLoss` so per-split ascent/descent uses the
 * exact same hysteresis settings as the whole-track total feeding the score
 * -- see file comment. Defaults match `core/stats/segments.ts`'s own
 * defaults when omitted, which is what standalone unit tests exercise.
 */
export function computeKmSplits(
  track: Track,
  series?: PointSeries,
  gapResult?: TrackGap,
  statsOptions: StatsOptions = {},
): KmSplit[] {
  const s = series ?? derivePointSeries(track)
  if (s.n < 2) return []

  const threshold = statsOptions.threshold ?? DEFAULT_THRESHOLD
  const smoothWindow = statsOptions.smoothWindow ?? DEFAULT_SMOOTH_WINDOW
  const { gain: runningGain, loss: runningLoss } = buildRunningGainLoss(track.points.ele, threshold, smoothWindow)

  const splits: KmSplit[] = []
  let splitStart = 0
  let nextKmMark = KM_MARK_M

  for (let i = 1; i < s.n; i++) {
    if (s.dist[i] >= nextKmMark || i === s.n - 1) {
      splits.push(buildSplit(track, s, gapResult, splitStart, i, splits.length + 1, runningGain, runningLoss))
      splitStart = i
      nextKmMark += KM_MARK_M
    }
  }

  return splits
}
