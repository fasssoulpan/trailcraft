/**
 * Grade Adjusted Pace (GAP), ported from
 * `cyber-trail-hud/src/analysis/gap.js` (P2 §3.2, milestone Q2). User's own
 * project (`D:\MyAIProject\cyber-trail-hud`), no licence obstacle.
 *
 * Base model: Minetti et al. (2002) fifth-order polynomial energy cost of
 * running on a grade:
 *   Cr(i) = 155.4i^5 - 30.4i^4 - 43.3i^3 + 46.3i^2 + 19.5i + 3.6
 *
 * v2 refinements (kept from the reference):
 * 1. Grade > +15%: switches to a linear extrapolation (run -> hike mode).
 * 2. Grade < -15%: factor floored at 0.88.
 * 3. `isHikingSegment`: grade > 20% and speed < 2 km/h (0.56 m/s).
 *
 * Porting notes (P1 §5 / P2 §3.2 rules): the three scalar functions below
 * (`gapFactor`, `calculateGAP`, `isHikingSegment`) are numerically identical
 * transcriptions of the reference -- no behaviour change, so the reference's
 * own worked examples remain valid regression tests. `computeTrackGap` is
 * the adaptation of the reference's `calculateTrackGAP(points)` (which
 * mutates an array of point objects) to TrailCraft's columnar model: it
 * consumes `pointSeries.ts#PointSeries` (grade/segmentDist/segmentTime)
 * instead of reading `p.grade`/`p.segmentDist`/`p.segmentTime` off point
 * objects, and returns parallel TypedArrays instead of mutating in place --
 * no module-level mutable state, matching the P1 flythrough port's
 * precedent.
 */
import type { Track } from '../model/track'
import { derivePointSeries, type PointSeries } from './pointSeries'

const CR_FLAT = 3.6

function minettiCr(grade: number): number {
  const i = grade
  const cr = 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6
  return Math.max(cr, 0.5)
}

/** GAP correction factor (v2, with the steep-grade mode switch). `gradePercent`
 * is a percentage (e.g. `12` for +12%), not a fraction. */
export function gapFactor(gradePercent: number): number {
  const clamped = Math.max(-45, Math.min(45, gradePercent))

  // Steep uphill (>15%): linear extrapolation.
  if (clamped > 15) {
    const baseGrade = 0.15
    const baseFactor = minettiCr(baseGrade) / CR_FLAT
    const extraFactor = (clamped - 15) * 0.05
    return Math.min(baseFactor + extraFactor, 5.0)
  }

  // Steep downhill (<-15%): floored factor.
  if (clamped < -15) return 0.88

  // Normal range (-15% ~ +15%).
  const grade = clamped / 100
  let factor = minettiCr(grade) / CR_FLAT
  if (factor < 0.88) factor = 0.88
  return factor
}

/** Grade-adjusted pace (sec/km). Returns 0 for a non-positive input pace,
 * matching the reference's guard. */
export function calculateGAP(paceSecPerKm: number, gradePercent: number): number {
  if (!paceSecPerKm || paceSecPerKm <= 0) return 0
  return paceSecPerKm / gapFactor(gradePercent)
}

/** Whether a point should be classified as hiking rather than running. */
export function isHikingSegment(gradePercent: number, speedMs: number): boolean {
  if (gradePercent > 20 && speedMs < 0.56) return true
  if (gradePercent > 30) return true
  return false
}

export interface TrackGap {
  /** GAP pace (sec/km) at each point; `NaN` where not computable (point 0,
   * a missing segment distance/time, or instantaneous speed <= 0.2 m/s --
   * matching the reference's `speedMs > 0.2` gate against near-zero-speed
   * noise). */
  gap: Float64Array
  /** Hiking flag at each point (see `isHikingSegment`). `0`/`1` rather than
   * `boolean[]` to stay a TypedArray -- P1/P2 convention for point-indexed
   * derived data on tracks that can reach ~330k points. */
  isHiking: Uint8Array
}

/**
 * Track-wide GAP + hiking-flag computation -- the columnar-model
 * counterpart of the reference's `calculateTrackGAP(points)`. Requires both
 * an elevation column (for grade) and a time column (for segment pace);
 * returns `undefined` when either is absent rather than fabricating grade-0
 * or zero-pace numbers for a track that cannot support this computation.
 *
 * `series` may be passed in by a caller that already built it (e.g.
 * `score.ts#computePerformance`, which shares one `PointSeries` across
 * `gap.ts`/`climbs.ts`/`splits.ts` per the memoisation requirement) --
 * omitting it computes a fresh one, which is what standalone unit tests do.
 */
export function computeTrackGap(track: Track, series?: PointSeries): TrackGap | undefined {
  const s = series ?? derivePointSeries(track)
  if (!s.grade || !s.segmentTime) return undefined

  const gap = new Float64Array(s.n).fill(NaN)
  const isHiking = new Uint8Array(s.n)
  for (let i = 1; i < s.n; i++) {
    const segDist = s.segmentDist[i]
    const segTime = s.segmentTime[i]
    if (segDist > 0 && segTime > 0) {
      const speedMs = segDist / segTime
      isHiking[i] = isHikingSegment(s.grade[i], speedMs) ? 1 : 0
      if (speedMs > 0.2) {
        const paceSecPerKm = 1000 / speedMs
        gap[i] = calculateGAP(paceSecPerKm, s.grade[i])
      }
    }
  }
  return { gap, isHiking }
}
