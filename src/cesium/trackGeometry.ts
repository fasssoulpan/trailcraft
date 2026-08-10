/**
 * Pure bridge from P0's columnar `Track` model to the flat arrays Cesium's
 * geometry constructors want. Deliberately free of any `cesium` import (see
 * `viewer.ts`'s file-level comment for why the `cesium` package itself must
 * stay out of anything that should be unit-testable in Node) -- this module
 * accepts and returns plain numbers/arrays only, so it runs under Vitest's
 * `node` environment with no WebGL/DOM involved.
 *
 * `src/map/trackLayer.ts`'s `renderCopy` is the 2D analogue: decimate to a
 * render cap, memoise per immutable `Track`. This module intentionally does
 * NOT memoise -- `src/cesium/trackEntities.ts` (commit 2) owns the
 * `WeakMap` cache, since it's the caller that knows when geometry actually
 * needs rebuilding.
 */
import type { Track } from '../core/model/track'
import { decimateIndices } from '../core/toolbox/decimate'

/**
 * Render cap for the 3D scene: higher than 2D's `RENDER_MAX` (4000, see
 * `trackLayer.ts`) because the flythrough camera gets close enough to the
 * ground that 2D's cap would read as visibly faceted, per the P1 plan §3.2.
 */
export const RENDER_MAX_3D = 8000

/**
 * Height (metres, ellipsoidal) substituted for a render point whose `ele`
 * is missing -- either the whole column is absent (common for planning
 * tracks with no barometer/DEM sample) or this one point's value is NaN.
 *
 * Chosen as a plain `0` rather than e.g. interpolating from neighbouring
 * points: the polyline itself is rendered `clampToGround: true` in commit 2,
 * so this value never affects where the line actually appears on screen --
 * it only matters for consumers that read raw heights directly (the moving
 * entity path in N3, camera framing math). `0` is a safe, honest "unknown"
 * that never produces a visually implausible spike, unlike e.g. carrying
 * forward the last valid elevation across a long NaN run.
 */
export const FALLBACK_HEIGHT_M = 0

export interface PositionArrayResult {
  /** `[lon, lat, height, lon, lat, height, ...]`, ready for
   * `Cartesian3.fromDegreesArrayHeights`. Length is always `idx.length * 3`. */
  flat: number[]
  /** `idx[i]` is the full-precision `track.points` index that render
   * position `i` (i.e. `flat[i*3..i*3+2]`) maps back to. */
  idx: Uint32Array
}

/**
 * Decimates `track` to at most `maxPoints` render vertices and expands them
 * into a flat `[lon, lat, height, ...]` array, reading directly from the
 * columnar `Float64Array`/`Float32Array` storage -- no intermediate
 * per-point objects, which is the entire point of keeping P0's columnar
 * model (a 330k-point object array runs 5-10x the memory under V8, per the
 * P1 plan §3.2).
 */
export function buildPositionArray(track: Track, maxPoints: number): PositionArrayResult {
  const { lon, lat, ele } = track.points
  const idx = decimateIndices(lon.length, maxPoints)
  const flat: number[] = new Array(idx.length * 3)
  for (let i = 0; i < idx.length; i++) {
    const p = idx[i]
    const rawEle = ele ? ele[p] : undefined
    const height = rawEle !== undefined && Number.isFinite(rawEle) ? rawEle : FALLBACK_HEIGHT_M
    flat[i * 3] = lon[p]
    flat[i * 3 + 1] = lat[p]
    flat[i * 3 + 2] = height
  }
  return { flat, idx }
}

export interface TimelineResult {
  /** Per-render-point time, in seconds elapsed since the first render
   * point. Same length/order as the `idx` used to derive it. Strictly
   * increasing (`times[i] > times[i-1]`) and `times[0] === 0`. */
  times: number[]
  /** True when `track.points.time` was absent entirely and the timeline was
   * synthesized from `cumDist` instead of real recorded timestamps -- the
   * UI (N4) should tell the user playback speed/duration are approximate. */
  synthetic: boolean
}

/**
 * Smallest gap enforced between two consecutive output times, in seconds.
 * COROS exports (and GPS tracks generally) routinely contain consecutive
 * points sharing the exact same recorded timestamp (1Hz+ logging with a
 * paused/duplicated sample) -- Cesium's `SampledPositionProperty` requires
 * its sample times to be strictly increasing, so a non-increasing raw
 * timestamp is bumped forward by this amount instead of being used as-is.
 * 1ms is small enough to be visually and physically meaningless during
 * playback, while still guaranteeing strict monotonicity regardless of how
 * many consecutive duplicates appear in a row.
 */
const MIN_TIME_STEP_S = 0.001

/**
 * Constant pace (m/s) assumed when synthesizing a timeline for a track with
 * no recorded timestamps at all -- common for planning-only routes exported
 * by Chinese platforms (the reference implementation does not handle this
 * case; see the P1 plan §3.2/§5). 2.5 m/s is roughly 6:40/km, a plausible
 * moderate trail-running pace accounting for elevation gain; it only needs
 * to produce a sensible flythrough duration; it is not a claim about the
 * runner's actual pace.
 */
const SYNTHETIC_SPEED_MPS = 2.5

/**
 * Builds a per-render-point timeline for `track`, for the render points
 * selected by `idx` (as returned by `buildPositionArray` -- callers must
 * pass the same `idx` used to build the corresponding position array, so
 * times and positions line up 1:1).
 *
 * - When `track.points.time` exists, converts each render point's epoch-ms
 *   timestamp to seconds-since-first-point, de-duplicating/repairing
 *   non-increasing steps per `MIN_TIME_STEP_S` above.
 * - When `track.points.time` is absent entirely, synthesizes a
 *   constant-speed timeline from `track.points.cumDist` (falling back to
 *   render-point spacing if `cumDist` itself is somehow also missing, which
 *   should not happen for any track that has gone through the P0 import
 *   pipeline -- see `core/pipeline/import.ts`).
 */
export function synthesizeTimeline(track: Track, idx: Uint32Array): TimelineResult {
  const { time, cumDist } = track.points

  const times: number[] = new Array(idx.length)
  let prev = -Infinity

  if (time && time.length > 0) {
    const t0 = time[idx[0]]
    for (let i = 0; i < idx.length; i++) {
      let t = (time[idx[i]] - t0) / 1000
      if (t <= prev) t = prev + MIN_TIME_STEP_S
      times[i] = t
      prev = t
    }
    return { times, synthetic: false }
  }

  for (let i = 0; i < idx.length; i++) {
    const dist = cumDist ? cumDist[idx[i]] : idx[i] - idx[0]
    let t = dist / SYNTHETIC_SPEED_MPS
    if (t <= prev) t = prev + MIN_TIME_STEP_S
    times[i] = t
    prev = t
  }
  return { times, synthetic: true }
}
