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
 * transcription of the reference. The per-segment `ascent`/`descent` figures
 * are the reference's own simple diff-sum over the segment's raw elevation
 * points (no threshold/hysteresis) -- deliberately NOT switched to P0's
 * `core/stats/elevation.ts#computeGainLoss`. The one ascent number this
 * milestone is required to unify across the app is the *track-total* figure
 * that feeds the performance score's `kmEffortV2` (see `score.ts`); a
 * per-climb-segment breakdown is a different, finer-grained statistic that
 * nothing else in TrailCraft currently displays, so there is no second
 * number for it to disagree with yet. Worth revisiting if/when the P2 Q3
 * report panel puts both figures on screen at once.
 *
 * Adapted for the columnar model: consumes `pointSeries.ts#PointSeries`
 * (grade/dist/elapsedSec) plus `track.points.ele`/`hr` directly, instead of
 * the reference's array of enriched point objects.
 */
import type { Track } from '../model/track'
import { derivePointSeries, type PointSeries } from './pointSeries'

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
  /** Segment ascent/descent (m), raw diff-sum -- see file comment. */
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

function buildSegment(track: Track, s: PointSeries, from: number, to: number, type: GradeSegmentType): GradeSegment {
  const { dist, elapsedSec, grade } = s
  const ele = track.points.ele
  const hr = track.points.hr

  const distance = dist[to] - dist[from]
  const time = elapsedSec ? elapsedSec[to] - elapsedSec[from] : undefined

  let ascent = 0
  let descent = 0
  if (ele) {
    for (let i = from + 1; i <= to; i++) {
      if (Number.isFinite(ele[i]) && Number.isFinite(ele[i - 1])) {
        const diff = ele[i] - ele[i - 1]
        if (diff > 0) ascent += diff
        else descent += Math.abs(diff)
      }
    }
  }

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
 */
export function computeGradeSegments(track: Track, series?: PointSeries): GradeSegment[] {
  const s = series ?? derivePointSeries(track)
  if (!s.grade) return []
  const n = s.n
  if (n < MIN_SEGMENT_POINTS * 2) return []

  const segments: GradeSegment[] = []
  let segStart = 0
  let currentType = classifyGrade(s.grade[0])

  for (let i = 1; i < n; i++) {
    const type = classifyGrade(s.grade[i])
    if (type !== currentType || i === n - 1) {
      const segEnd = i === n - 1 ? i : i - 1
      if (segEnd - segStart + 1 >= MIN_SEGMENT_POINTS) {
        segments.push(buildSegment(track, s, segStart, segEnd, currentType))
      }
      segStart = i
      currentType = type
    }
  }

  return segments
}
