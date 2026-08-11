/**
 * Per-kilometre split statistics, ported from
 * `cyber-trail-hud/src/analysis/splits.js` (P2 §3.2, milestone Q2). User's
 * own project, no licence obstacle.
 *
 * Cuts the track at each whole-kilometre mark (the last split absorbs
 * whatever distance remains, however short) and reports pace/GAP/ascent/
 * descent/heart-rate/grade per split.
 *
 * Porting notes: numerically identical to the reference, including its own
 * per-point ascent/descent diff threshold (>2m / <-2m, distinct from and NOT
 * replaced by P0's `computeGainLoss` hysteresis -- see `climbs.ts`'s file
 * comment for why that substitution is scoped to the track-total ascent
 * feeding the score, not every ascent-shaped number in the port). Adapted
 * for the columnar model: consumes `pointSeries.ts#PointSeries` (dist/
 * elapsedSec/grade) and `gap.ts#TrackGap` (gap) plus `track.points.ele`/`hr`
 * directly, instead of the reference's array of enriched point objects.
 */
import type { Track } from '../model/track'
import { derivePointSeries, type PointSeries } from './pointSeries'
import type { TrackGap } from './gap'

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
  /** Ascent/descent (m) within the split -- reference's own >2m/<-2m diff
   * threshold, see file comment. */
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
): KmSplit {
  const { dist, elapsedSec, grade } = s
  const ele = track.points.ele
  const hr = track.points.hr

  const distance = dist[to] - dist[from]
  const time = elapsedSec ? elapsedSec[to] - elapsedSec[from] : undefined
  const pace = time !== undefined && distance > 0 ? time / (distance / 1000) : undefined

  let ascent = 0
  let descent = 0
  if (ele) {
    for (let i = from + 1; i <= to; i++) {
      if (!Number.isFinite(ele[i]) || !Number.isFinite(ele[i - 1])) continue
      const diff = ele[i] - ele[i - 1]
      if (diff > 2) ascent += diff
      else if (diff < -2) descent += Math.abs(diff)
    }
  }

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
 */
export function computeKmSplits(track: Track, series?: PointSeries, gapResult?: TrackGap): KmSplit[] {
  const s = series ?? derivePointSeries(track)
  if (s.n < 2) return []

  const splits: KmSplit[] = []
  let splitStart = 0
  let nextKmMark = KM_MARK_M

  for (let i = 1; i < s.n; i++) {
    if (s.dist[i] >= nextKmMark || i === s.n - 1) {
      splits.push(buildSplit(track, s, gapResult, splitStart, i, splits.length + 1))
      splitStart = i
      nextKmMark += KM_MARK_M
    }
  }

  return splits
}
