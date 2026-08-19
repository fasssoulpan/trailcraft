/**
 * Pure, mileage-parameterised camera path maths for the flythrough engine
 * (P1 §3.3, milestone N3 commit 1).
 *
 * Deliberately free of any `cesium` import, mirroring `trackGeometry.ts`'s
 * rule for the same reason -- everything here must run under Vitest's
 * `node` environment with no WebGL/DOM involved, so it can be unit-tested
 * with plain numbers.
 *
 * The plan (P1 方案 §3.3) mandates that the camera path be parameterised by
 * **mileage along the track, not frame index or elapsed time**. Two reasons,
 * both load-bearing:
 *
 * 1. Playback speed changes (1x-20x) must not alter *where* the camera goes
 *    at a given point in the journey -- only how fast real time maps to
 *    mileage. A time-parameterised path (e.g. Cesium's
 *    `SampledPositionProperty` interpolating over Julian dates, as the
 *    reference implementation does) technically already satisfies this too,
 *    but mileage is the more direct, more obviously-correct parameter for
 *    "where is the camera right now" and sidesteps Hermite-over-time
 *    interpolation artifacts entirely.
 * 2. P2's deterministic frame-by-frame renderer needs to reproduce the exact
 *    same path at a different frame rate -- it wants to ask "what does the
 *    camera look like at mileage X" directly, without simulating through
 *    Cesium `Clock` ticks or `JulianDate` arithmetic at all. Every function
 *    in this module is a pure `(path, mileage) -> value` mapping for exactly
 *    that reason.
 *
 * `flythrough.ts` (commit 2) is the "untestable in Node" half that owns a
 * real Cesium `Viewer`/`Entity`/`Clock` and calls into this module every
 * frame; this module never reaches back into Cesium.
 */
import { locateByDist } from '../core/geo/distance'

// ---- Track path -------------------------------------------------------

export interface TrackPathPoint {
  lon: number
  lat: number
  /** Metres, ellipsoidal -- same convention as `trackGeometry.ts`'s
   * `FALLBACK_HEIGHT_M` (0 for points with no recorded elevation). */
  height: number
}

/**
 * Precomputed, immutable camera path: a decimated sequence of track points
 * (typically `trackGeometry.ts`'s render points) each tagged with its
 * cumulative mileage along the track. Every function below samples this
 * structure by mileage -- nothing here re-derives mileage from geometry, so
 * building one of these correctly (mileage strictly non-decreasing, same
 * length as `points`, `mileage[0] === 0`) is entirely the caller's
 * responsibility, enforced by `buildCameraPath`.
 */
export interface CameraPath {
  points: TrackPathPoint[]
  /** Cumulative mileage (metres) at `points[i]`, same length/order.
   * Non-decreasing; `mileage[0] === 0` for a non-empty path. */
  mileage: Float64Array
  /** `mileage[mileage.length - 1]`, or 0 for an empty/single-point path. */
  totalMileage: number
}

/**
 * Builds a `CameraPath` from parallel `points`/`mileage` arrays (as
 * `flythrough.ts` derives from `trackGeometry.ts`'s render `idx` and the
 * source `Track`'s `points.cumDist`). Throws on a length mismatch -- a
 * caller bug, not a runtime data condition worth degrading gracefully for.
 *
 * A zero-length (`points.length === 0`) or single-point path is accepted,
 * not rejected: `sampleAtMileage` below handles both without dividing by
 * zero (see its own doc comment), so there is no reason to make every
 * caller special-case "track not loaded yet" before it can even construct
 * a path.
 */
export function buildCameraPath(points: TrackPathPoint[], mileage: ArrayLike<number>): CameraPath {
  if (points.length !== mileage.length) {
    throw new Error(`buildCameraPath: points.length=${points.length} !== mileage.length=${mileage.length}`)
  }
  const m = Float64Array.from(mileage)
  const totalMileage = m.length > 0 ? m[m.length - 1] : 0
  return { points, mileage: m, totalMileage }
}

// ---- Progress <-> mileage ----------------------------------------------

/** Clamps a 0..1 progress value, treating `NaN` as 0 (defensive -- e.g. a
 * `0/0` upstream from a zero-length track computing its own progress). */
export function clampProgress(progress: number): number {
  if (Number.isNaN(progress)) return 0
  return Math.min(1, Math.max(0, progress))
}

/** Clamps a mileage value into `[0, totalMileage]`. */
export function clampMileage(mileageM: number, totalMileage: number): number {
  if (Number.isNaN(mileageM)) return 0
  return Math.min(totalMileage, Math.max(0, mileageM))
}

/** progress (0..1) -> mileage (metres). Clamps `progress` first, so this
 * never returns a value outside `[0, path.totalMileage]`. */
export function progressToMileage(path: CameraPath, progress: number): number {
  return clampProgress(progress) * path.totalMileage
}

/** mileage (metres) -> progress (0..1). A zero-length path (`totalMileage
 * === 0`) always reports progress 0 rather than `0/0 = NaN` -- there is no
 * meaningful "how far along" a path with no length. */
export function mileageToProgress(path: CameraPath, mileageM: number): number {
  if (path.totalMileage <= 0) return 0
  return clampMileage(mileageM, path.totalMileage) / path.totalMileage
}

// ---- Position/heading sampling -----------------------------------------

export interface PathSample {
  position: TrackPathPoint
  /** Forward azimuth (degrees, 0-360, 0 = north) of the bracketing segment
   * -- i.e. the direction of travel at this point. Constant across a single
   * render segment (changes at vertices), not smoothed across the turn --
   * fine at up to `RENDER_MAX_3D` (8000) render points, matching the
   * reference implementation's own per-segment heading. `0` for a
   * single-point path (no direction is defined). */
  headingDeg: number
  /** Index of the bracketing render point at or before this sample (into
   * `path.points`/`path.mileage`). `-1` for an empty path. */
  renderIndex: number
  /** Interpolation fraction (0..1) from `path.points[renderIndex]` toward
   * `path.points[renderIndex + 1]`. `0` when the path has fewer than 2
   * points, or when the sample lands exactly on `renderIndex`. */
  t: number
}

const EMPTY_SAMPLE: PathSample = { position: { lon: 0, lat: 0, height: 0 }, headingDeg: 0, renderIndex: -1, t: 0 }

function lerpPoint(a: TrackPathPoint, b: TrackPathPoint, t: number): TrackPathPoint {
  return {
    lon: a.lon + (b.lon - a.lon) * t,
    lat: a.lat + (b.lat - a.lat) * t,
    height: a.height + (b.height - a.height) * t,
  }
}

/**
 * Samples `path` at `mileageM` (clamped into `[0, path.totalMileage]`),
 * interpolating between the two bracketing render points rather than
 * snapping to the nearest one -- snapping produces visible stepping on a
 * decimated (up to 8000-point) path, per the milestone brief.
 *
 * - Empty path (`points.length === 0`): returns a fixed degenerate sample
 *   (`renderIndex: -1`) instead of throwing or dividing by zero -- callers
 *   that always sample once per frame should not need a try/catch for a
 *   track that hasn't finished loading.
 * - Single-point path: returns that point verbatim, heading 0 (no direction
 *   is defined for a single point), `t: 0`.
 * - Degenerate segment (two consecutive render points at the same mileage,
 *   e.g. a paused GPS sample): `t` falls back to 0 instead of `0/0`.
 */
export function sampleAtMileage(path: CameraPath, mileageM: number): PathSample {
  const n = path.points.length
  if (n === 0) return EMPTY_SAMPLE
  if (n === 1) return { position: path.points[0], headingDeg: 0, renderIndex: 0, t: 0 }

  const clamped = clampMileage(mileageM, path.totalMileage)
  // locateByDist returns the lower-bracket index `i` such that
  // mileage[i] <= clamped <= mileage[i+1] (already clamping out-of-range
  // distances to the first/last segment) -- exactly the bracket this needs,
  // and it's the same battle-tested bisection `core/geo/distance.ts` already
  // uses for CP anchoring, rather than a second hand-rolled binary search.
  const i = locateByDist(path.mileage, clamped)
  const span = path.mileage[i + 1] - path.mileage[i]
  const t = span > 0 ? (clamped - path.mileage[i]) / span : 0
  const p0 = path.points[i]
  const p1 = path.points[i + 1]
  return {
    position: lerpPoint(p0, p1, t),
    headingDeg: bearingDegrees(p0, p1),
    renderIndex: i,
    t,
  }
}

/**
 * Maps a `sampleAtMileage` result back to a full-precision index into the
 * source `Track.points` -- the index P0's statistics modules (and N4's HUD)
 * actually key off, as opposed to the decimated render-point index
 * `sampleAtMileage` itself works in.
 *
 * `idxMap` is `trackGeometry.ts`'s `buildPositionArray().idx` (render index
 * -> full-precision index). Rounds `t` toward whichever full-precision index
 * is nearer, rather than always flooring to `idxMap[renderIndex]` -- a
 * decimated segment can span thousands of full-precision points, and
 * flooring would make the reported point index visibly lag a full segment
 * behind the camera for most of the segment's traversal.
 */
export function fullPrecisionIndex(idxMap: ArrayLike<number>, renderIndex: number, t: number): number {
  const n = idxMap.length
  if (n === 0) return 0
  const lo = Math.min(Math.max(renderIndex, 0), n - 1)
  const hi = Math.min(lo + 1, n - 1)
  const a = idxMap[lo]
  const b = idxMap[hi]
  return Math.round(a + (b - a) * t)
}

// ---- Bearing ------------------------------------------------------------

function normalizeBearing(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/**
 * Forward azimuth (degrees, 0-360, 0 = north, 90 = east) from `a` to `b`.
 * Standard great-circle bearing formula (ported from the reference
 * implementation's `utils/geo.js#bearing`, which takes lat/lng in that
 * order -- this version takes `{lon, lat}` points instead, matching this
 * codebase's `lon`-first convention everywhere else, e.g.
 * `trackGeometry.ts`'s flat `[lon, lat, height, ...]` layout).
 *
 * Correctly wraps across the antimeridian (e.g. lon 179 -> lon -179 reports
 * ~90 degrees/east, the short way across the date line) for free: the
 * longitude difference is never normalised to [-180, 180] before use, but
 * `sin`/`cos` are inherently 360-degree periodic, so an unnormalised
 * difference like -358 degrees produces the identical result as +2 degrees.
 */
export function bearingDegrees(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180

  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return normalizeBearing((Math.atan2(y, x) * 180) / Math.PI)
}

// ---- Follow-camera offset -----------------------------------------------

export interface FollowCameraConfig {
  /** Horizontal distance (m) behind the moving point, measured along the
   * reverse of the direction of travel. */
  distanceBehindM: number
  /** Vertical height (m) added above the moving point's (ground-clamped,
   * see `flythrough.ts`) height. */
  heightAboveM: number
  /** Camera pitch in degrees; negative tilts the camera downward toward the
   * point (matches Cesium's `HeadingPitchRange`/`camera.setView` convention:
   * 0 = level with the local horizon, -90 = straight down). Orientation
   * only -- does not affect the computed position. */
  pitchDeg: number
}

/** Reasonable third-person chase-cam defaults, in the same ballpark as the
 * reference implementation's `FLYTHROUGH_CONFIG` (`CAMERA_RANGE: 300`,
 * `CAMERA_PITCH: -25`) decomposed into separate horizontal/vertical
 * components instead of a single range+pitch pair -- this module computes
 * an actual lon/lat/height rather than handing Cesium a
 * `HeadingPitchRange` to resolve itself (see `flythrough.ts` for why:
 * P2's deterministic renderer needs the resolved numbers directly). */
export const DEFAULT_FOLLOW_CAMERA_CONFIG: FollowCameraConfig = {
  distanceBehindM: 120,
  heightAboveM: 55,
  pitchDeg: -18,
}

const EARTH_RADIUS_M = 6371008.8

function metresToDegLat(m: number): number {
  return (m / EARTH_RADIUS_M) * (180 / Math.PI)
}

function metresToDegLon(m: number, atLatDeg: number): number {
  const cosLat = Math.cos((atLatDeg * Math.PI) / 180)
  // Guards the (never realistic for trail routes, but cheap to guard)
  // near-pole case where cos(lat) -> 0 and metres-per-degree-longitude
  // blows up -- floors the divisor's magnitude instead of letting the
  // offset go to +/-Infinity.
  const safeCos = Math.abs(cosLat) < 1e-9 ? Math.sign(cosLat || 1) * 1e-9 : cosLat
  return (m / (EARTH_RADIUS_M * safeCos)) * (180 / Math.PI)
}

export interface CameraPose {
  position: TrackPathPoint
  headingDeg: number
  pitchDeg: number
}

/**
 * Given the moving point's position and direction of travel, computes the
 * FOLLOW-mode camera's own position and orientation: behind the point
 * (opposite the heading) and above it, looking along the direction of
 * travel.
 *
 * Uses a flat-earth (equirectangular) approximation to convert the
 * metre-scale east/north offset into a lon/lat delta -- accurate enough at
 * the 30-300m chase-camera distances this is used for (a fraction of a
 * percent of the sphere's radius); a full ellipsoidal/geodesic offset would
 * cost real complexity for a difference that's invisible at this scale, and
 * `flythrough.ts` is free to re-derive the exact Cesium `Cartesian3` from
 * these lon/lat/height numbers however it likes.
 */
export function followCameraOffset(
  point: TrackPathPoint,
  headingDeg: number,
  config: FollowCameraConfig,
): CameraPose {
  const behindHeadingDeg = normalizeBearing(headingDeg + 180)
  const behindHeadingRad = (behindHeadingDeg * Math.PI) / 180
  const eastM = config.distanceBehindM * Math.sin(behindHeadingRad)
  const northM = config.distanceBehindM * Math.cos(behindHeadingRad)

  return {
    position: {
      lon: point.lon + metresToDegLon(eastM, point.lat),
      lat: point.lat + metresToDegLat(northM),
      height: point.height + config.heightAboveM,
    },
    headingDeg: normalizeBearing(headingDeg),
    pitchDeg: config.pitchDeg,
  }
}

// ---- Speed handling -------------------------------------------------------

/**
 * Converts a playback multiplier (1x-20x) and elapsed real (wall-clock)
 * time into a mileage delta, at a given base speed (the track's own
 * average pace, "1x" -- see `averageSpeedMps`). Always >= 0 for
 * non-negative inputs, so accumulating this every frame produces a
 * monotonically non-decreasing mileage -- which is the whole point of
 * parameterising the path by mileage rather than by frame index: this
 * function is the *only* place playback speed enters the picture, and
 * nothing else in this module depends on time at all.
 */
export function speedToMileageDelta(multiplier: number, elapsedRealSeconds: number, baseSpeedMps: number): number {
  if (multiplier <= 0 || elapsedRealSeconds <= 0 || baseSpeedMps <= 0) return 0
  return multiplier * baseSpeedMps * elapsedRealSeconds
}

/**
 * "1x" base playback speed for a track: its own average pace, so that 1x
 * playback takes roughly the track's recorded (or synthesized, see
 * `trackGeometry.ts#synthesizeTimeline`) duration to traverse end-to-end,
 * and 10x takes a tenth of that. Falls back to `fallbackMps` (rather than
 * `0`, which would freeze playback entirely) when `totalDurationSeconds`
 * is non-positive -- a single-point or zero-duration track has no
 * meaningful pace of its own to derive one from.
 */
export function averageSpeedMps(totalMileageM: number, totalDurationSeconds: number, fallbackMps: number): number {
  if (totalDurationSeconds <= 0) return fallbackMps
  return totalMileageM / totalDurationSeconds
}
