/**
 * Grade-based segmentation / climb detection, ported from
 * `cyber-trail-hud/src/analysis/elevation.js`'s `calculateGradeSegments`
 * (P2 §3.2, milestone Q2). User's own project, no licence obstacle.
 *
 * Splits a track into consecutive uphill / flat / downhill segments by
 * local grade:
 * - uphill:   grade > 5%
 * - flat:     -5% ~ 5%
 * - downhill: grade < -5%
 *
 * Porting notes: the segmentation loop and threshold constants are an exact
 * transcription of the reference.
 *
 * ── Per-segment ascent/descent (P2 Q2 commit 1) ─────────────────────────
 * Originally (milestone Q2's first cut) this used the reference's own simple
 * diff-sum over the segment's raw elevation points, deliberately NOT routed
 * through P0's `core/stats/elevation.ts#computeGainLoss` -- reasoned at the
 * time as "nothing else in TrailCraft displays a per-climb breakdown, so
 * there's no second number for it to disagree with yet". The P2 Q3 report
 * panel changes that: it puts climbs, splits AND the track-total on the same
 * screen, so a user summing per-climb ascents would get a different figure
 * from the headline total with no explanation -- exactly what routing the
 * score's `kme_v2` through P0's hysteresis (see `score.ts`'s header comment)
 * was meant to avoid in the first place.
 *
 * Fixed by computing ascent/descent as a PREFIX DIFFERENCE over
 * `core/stats/runningStats.ts#buildRunningGain`/`buildRunningLoss`'s
 * whole-track running totals: `ascent = runningGain[to] - runningGain[from]`.
 * Those prefix arrays are themselves a line-for-line transcription of
 * `computeGainLoss`'s hysteresis loop (see that module's file comment), so
 * this now uses the SAME algorithm and the SAME `statsOptions` (threshold +
 * smoothing window) as the whole-track ascent feeding the score.
 *
 * Subtlety worth being explicit about: hysteresis is PATH-DEPENDENT (the
 * running reference elevation carries across whatever boundary you'd cut
 * at), so these per-segment values will NOT in general equal
 * `computeGainLoss` run independently on each segment's own elevation slice
 * -- that would reset the reference elevation at every segment boundary and
 * get a different (structurally similar but numerically different) answer.
 * The prefix-difference definition is the right one here specifically
 * because summing prefix differences over a set of segments that together
 * cover the whole track telescopes back to the whole-track total by
 * construction -- see this file's test suite for a segmentation where every
 * segment clears `MIN_SEGMENT_POINTS` (so none get dropped and the segments
 * cover the full track with no gaps) and the per-segment ascents/descents
 * are asserted to sum to `computeGainLoss`'s whole-track total.
 *
 * Adapted for the columnar model: consumes `pointSeries.ts#PointSeries`
 * (grade/dist/elapsedSec) plus `track.points.ele`/`hr` directly, instead of
 * the reference's array of enriched point objects.
 */
import type { Track } from '../model/track'
import type { StatsOptions } from '../stats/segments'
import { buildRunningGainLoss } from '../stats/runningStats'
import { derivePointSeries, type PointSeries } from './pointSeries'

// Same defaults as core/stats/segments.ts's DEFAULT_THRESHOLD/
// DEFAULT_SMOOTH_WINDOW (not exported from there) -- mirrors score.ts's own
// local copy of the same constants, used as the fallback when a caller
// doesn't supply `statsOptions`.
const DEFAULT_THRESHOLD = 5
const DEFAULT_SMOOTH_WINDOW = 5

export type GradeSegmentType = 'uphill' | 'flat' | 'downhill'

export interface GradeSegment {
  type: GradeSegmentType
  /** Cumulative distance (m) at the segment's start/end. */
  startDist: number
  endDist: number
  /** Segment length (m). */
  distance: number
  /** Segment duration (s); `undefined` when the track has no time column. */
  time: number | undefined
  /** Segment ascent/descent (m) -- prefix difference over P0's
   * threshold-hysteresis running totals, see file comment. */
  ascent: number
  descent: number
  /** Mean local grade (%) over the segment's points. */
  avgGrade: number
  /** Mean pace (s/km); `undefined` when `time` is `undefined` or the segment
   * has zero distance. */
  avgPace: number | undefined
  /** Mean heart rate (bpm) over points with a reading; `undefined` when the
   * track has no `hr` column or no point in the segment has one (0 is the
   * "no reading" sentinel, see `core/model/track.ts`). */
  avgHR: number | undefined
}

const UPHILL_THRESHOLD = 5
const DOWNHILL_THRESHOLD = -5
const MIN_SEGMENT_POINTS = 10

function classifyGrade(grade: number): GradeSegmentType {
  if (grade > UPHILL_THRESHOLD) return 'uphill'
  if (grade < DOWNHILL_THRESHOLD) return 'downhill'
  return 'flat'
}

function buildSegment(
  track: Track,
  s: PointSeries,
  from: number,
  to: number,
  type: GradeSegmentType,
  runningGain: Float64Array,
  runningLoss: Float64Array,
): GradeSegment {
  const { dist, elapsedSec, grade } = s
  const hr = track.points.hr

  const distance = dist[to] - dist[from]
  const time = elapsedSec ? elapsedSec[to] - elapsedSec[from] : undefined

  // Prefix difference over the whole-track running totals -- see this
  // file's header comment for why this (not an independent computeGainLoss
  // over just this segment's slice) is the right definition. `runningGain`/
  // `runningLoss` are empty arrays when the track has no elevation column,
  // matching the old `if (ele)` guard's "no data -> zero" behaviour.
  const ascent = runningGain.length > 0 ? runningGain[to] - runningGain[from] : 0
  const descent = runningLoss.length > 0 ? runningLoss[to] - runningLoss[from] : 0

  let sumGrade = 0
  for (let i = from; i <= to; i++) sumGrade += grade![i]
  const avgGrade = sumGrade / (to - from + 1)

  const avgPace = time !== undefined && distance > 0 ? time / (distance / 1000) : undefined

  let avgHR: number | undefined
  if (hr) {
    let sum = 0
    let count = 0
    for (let i = from; i <= to; i++) {
      if (hr[i] !== 0) { sum += hr[i]; count++ }
    }
    avgHR = count > 0 ? Math.round(sum / count) : undefined
  }

  return {
    type,
    startDist: Math.round(dist[from]),
    endDist: Math.round(dist[to]),
    distance: Math.round(distance),
    time: time !== undefined ? Math.round(time) : undefined,
    ascent: Math.round(ascent),
    descent: Math.round(descent),
    avgGrade: Math.round(avgGrade * 10) / 10,
    avgPace: avgPace !== undefined ? Math.round(avgPace) : undefined,
    avgHR,
  }
}

/**
 * Segments `track` into consecutive uphill/flat/downhill runs. Returns an
 * empty array when the track has no elevation column (grade is undefined --
 * there is nothing to segment by) or fewer than `MIN_SEGMENT_POINTS * 2`
 * points, matching the reference's own short-track guard.
 *
 * `series` may be passed in by a caller sharing one `PointSeries` across
 * modules (see `gap.ts#computeTrackGap`'s doc comment) -- omitted, a fresh
 * one is derived, which is what standalone unit tests do.
 *
 * `statsOptions` (threshold + smoothing window) is forwarded to
 * `buildRunningGain`/`buildRunningLoss` so the per-segment ascent/descent
 * uses the exact same hysteresis settings as the whole-track total feeding
 * the score -- see file comment. Defaults match `core/stats/segments.ts`'s
 * own defaults when omitted, which is what standalone unit tests exercise.
 */
export function computeGradeSegments(track: Track, series?: PointSeries, statsOptions: StatsOptions = {}): GradeSegment[] {
  const s = series ?? derivePointSeries(track)
  if (!s.grade) return []
  const n = s.n
  if (n < MIN_SEGMENT_POINTS * 2) return []

  const threshold = statsOptions.threshold ?? DEFAULT_THRESHOLD
  const smoothWindow = statsOptions.smoothWindow ?? DEFAULT_SMOOTH_WINDOW
  const { gain: runningGain, loss: runningLoss } = buildRunningGainLoss(track.points.ele, threshold, smoothWindow)

  const segments: GradeSegment[] = []
  let segStart = 0
  let currentType = classifyGrade(s.grade[0])

  for (let i = 1; i < n; i++) {
    const type = classifyGrade(s.grade[i])
    if (type !== currentType || i === n - 1) {
      const segEnd = i === n - 1 ? i : i - 1
      if (segEnd - segStart + 1 >= MIN_SEGMENT_POINTS) {
        segments.push(buildSegment(track, s, segStart, segEnd, currentType, runningGain, runningLoss))
      }
      segStart = i
      currentType = type
    }
  }

  return segments
}
