/**
 * Shared per-point derived arrays for the performance-analysis engine
 * (P2 §3.2, milestone Q2).
 *
 * This is NOT one of the five files the milestone table maps from
 * `cyber-trail-hud/src/analysis/*.js` -- it is supporting infrastructure that
 * corresponds to what the reference project's `src/processing/enricher.js`
 * (a *pipeline* file, not an `analysis/*.js` algorithm file, so it is
 * deliberately outside the porting table) does before any of the five ported
 * modules ever run: attach `dist`/`elapsedSec`/`segmentDist`/`segmentTime`/
 * `grade` to every point.
 *
 * The reference gets away with computing this once into mutable point
 * objects because its whole pipeline is object-array shaped. TrailCraft's
 * columnar `Track` (P0/P1) has no such per-point object to hang derived
 * fields off, and per the P1 §5 / P2 §3.2 porting rule we do not introduce
 * one -- so `gap.ts`, `climbs.ts` and `splits.ts` all need the same
 * grade/segment arrays and would otherwise each recompute them. This module
 * is that single shared computation, built once per `Track` by
 * `score.ts#computePerformance` (see that file's `WeakMap` cache) and passed
 * down to the others.
 */
import type { Track } from '../model/track'
import { computeCumDist } from '../geo/distance'

export interface PointSeries {
  n: number
  /** Cumulative distance (m) from the start of the track, same convention as
   * `track.points.cumDist` (reused if present, computed on the fly if not --
   * mirroring `trackKind.ts#classifyTrack`'s own fallback). */
  dist: Float64Array
  /** Distance (m) from the previous point; `segmentDist[0] = 0`. */
  segmentDist: Float64Array
  /** Seconds elapsed since the first point with a finite timestamp.
   * `undefined` when the track has no `time` column at all (whole-column
   * absence, matching `core/model/track.ts`'s TypedArray convention) --
   * `NaN` at individual points whose own reading (or the start point's) is
   * missing. */
  elapsedSec: Float64Array | undefined
  /** Seconds elapsed since the previous point; `NaN` where either endpoint's
   * timestamp is missing. `undefined` under the same whole-column condition
   * as `elapsedSec`. `segmentTime[0]` is always 0 when defined. */
  segmentTime: Float64Array | undefined
  /** Local grade (%), forward/backward window rise-over-run on the RAW
   * (unsmoothed) elevation column -- a direct port of the reference
   * enricher's `calculateGrade`: window `GRADE_WINDOW` points on each side,
   * clamped to [-60, 60]. Matches the reference's fallback of `0` (not NaN)
   * when the window's edges have no usable elevation reading or span less
   * than 1m horizontally -- this is an internal modelling input to
   * GAP/climb-detection (not a figure shown to the user the way ascent is),
   * so we keep the reference's exact behaviour here rather than applying
   * TrailCraft's usual "never fabricate a missing reading" rule, to stay
   * numerically consistent with the ported algorithm. `undefined` when the
   * track has no elevation column at all. */
  grade: Float64Array | undefined
}

/** Forward/backward window (points, one side) for local grade -- same value
 * as the reference's `enricher.js#GRADE_WINDOW`. */
const GRADE_WINDOW = 3

export function derivePointSeries(track: Track): PointSeries {
  const { lon, lat, ele, time } = track.points
  const n = lon.length
  const dist = track.points.cumDist ?? computeCumDist(lon, lat)

  const segmentDist = new Float64Array(n)
  for (let i = 1; i < n; i++) segmentDist[i] = dist[i] - dist[i - 1]

  let elapsedSec: Float64Array | undefined
  let segmentTime: Float64Array | undefined
  if (time && time.length > 0) {
    let t0: number | undefined
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(time[i])) { t0 = time[i]; break }
    }
    elapsedSec = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      elapsedSec[i] = t0 !== undefined && Number.isFinite(time[i]) ? (time[i] - t0) / 1000 : NaN
    }
    segmentTime = new Float64Array(n)
    for (let i = 1; i < n; i++) {
      segmentTime[i] = Number.isFinite(time[i]) && Number.isFinite(time[i - 1])
        ? (time[i] - time[i - 1]) / 1000
        : NaN
    }
  }

  let grade: Float64Array | undefined
  if (ele) {
    grade = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const back = Math.max(0, i - GRADE_WINDOW)
      const fwd = Math.min(n - 1, i + GRADE_WINDOW)
      const eBack = ele[back]
      const eFwd = ele[fwd]
      if (!Number.isFinite(eBack) || !Number.isFinite(eFwd)) { grade[i] = 0; continue }
      const hDist = dist[fwd] - dist[back]
      if (hDist < 1) { grade[i] = 0; continue }
      const g = ((eFwd - eBack) / hDist) * 100
      grade[i] = Math.max(-60, Math.min(60, g))
    }
  }

  return { n, dist, segmentDist, elapsedSec, segmentTime, grade }
}
