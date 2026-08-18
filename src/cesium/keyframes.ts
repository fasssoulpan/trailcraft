/**
 * Pure, mileage-keyed camera keyframe track (方案 V2.1 §5.5, milestone P3-R3
 * commit 1) -- the data structure a hand-edited keyframe timeline and
 * `cameraTemplates.ts`'s generated shots both produce, and the single
 * function (`sampleCameraAt`) both `cesium/flythrough.ts`'s live playback and
 * `cesium/deterministicRenderer.ts`'s frame-by-frame export resolve the
 * camera through -- see `flythrough.ts`'s own doc comment for exactly how
 * it wires this in once (inside `applyFrame`, shared by both).
 *
 * Deliberately free of any `cesium` import, same rule `cameraPath.ts`
 * documents for itself: everything here is a pure `(track, mileage) ->
 * value` mapping, testable under Vitest's `node` environment with plain
 * numbers, no WebGL/DOM involved.
 *
 * ---- Why keyed by mileage, not time or frame index ----
 * Exactly `cameraPath.ts`'s own reasoning (see that file's header comment):
 * a keyframe at "32km into the route" must mean the same physical spot on
 * the ground regardless of playback speed, frame rate, or whether the
 * camera got there via live playback or the deterministic exporter. Keying
 * by time or frame index would make that untrue.
 *
 * ---- Interpolation choice, per property ----
 * `distanceBehindM` / `heightAboveM` / `pitchDeg` / `fovDeg` /
 * `speedMultiplier` (all plain numbers, no wraparound): **smoothstep**
 * (`3t^2 - 2t^3`), not linear and not Catmull-Rom.
 *   - Linear was rejected: a linear ramp has a *constant* rate of change
 *     mid-segment that changes discontinuously at every keyframe boundary
 *     (the rate just before a keyframe and just after it are, in general,
 *     different) -- that discontinuity in the value's *derivative* is
 *     exactly the "visible corner" the brief warns about: the camera's
 *     dolly/climb/zoom speed visibly snaps to a new rate every time it
 *     crosses a keyframe.
 *   - Catmull-Rom was rejected: it can overshoot past the values at the
 *     bracketing keyframes when neighbouring keyframes pull the tangent
 *     past them. For camera placement that is not a cosmetic wobble --an
 *     overshot `heightAboveM` can dip the camera through the terrain
 *     between two moderate keyframes if their neighbours are extreme, and
 *     an overshot `fovDeg` can briefly exceed a sane lens range. It also
 *     needs 4 points (two neighbours beyond the bracket), which complicates
 *     the "before the first / after the last" edge behaviour this module
 *     needs to keep simple (hold, not extrapolate).
 *   - Smoothstep's `3t^2 - 2t^3` has zero derivative at both `t=0` and
 *     `t=1`: every segment eases in from, and eases out to, zero rate of
 *     change. Two segments meeting at a shared keyframe therefore both
 *     have rate zero right at the boundary, which removes the visible
 *     "corner" without any risk of overshoot (the interpolated value is
 *     always between the two endpoint values, monotonically, for
 *     monotonic inputs) and without needing more than the two bracketing
 *     keyframes.
 *
 * `headingOffsetDeg` (circular, degrees): the same smoothstep easing curve,
 * but applied to the **shortest signed angular delta** between the two
 * bracketing values rather than to the raw numbers -- see
 * `shortestAngleDeltaDeg` below. A naive numeric lerp from 350 to 10 would
 * sweep through 180 (the *long* way, 340 degrees of rotation); the shortest
 * delta between 350 and 10 is +20 (350 -> 360/0 -> 10), so this interpolates
 * that way instead, and the reverse direction (10 -> 350) correctly sweeps
 * -20 (through 0 the other way), never the 340-degree spin.
 *
 * ---- Ties: two keyframes at the same mileage ----
 * Not rejected as invalid (a user can legitimately drag one keyframe onto
 * another mid-edit, or a template's own generated keyframes can abut an
 * existing one exactly). Resolved deliberately as **last-one-wins**: when
 * building the resolved sample track (`resolveOrder` below), keyframes
 * sharing an exact mileage collapse to just the last one in stably-sorted
 * order (i.e. the last one in the *original* array, since
 * `Array.prototype.sort` is a stable sort per the ES2019+ spec this
 * codebase already targets) -- matching ordinary keyframe-editor UX where
 * whatever you dropped there most recently is what takes effect. This
 * collapse happens only inside sampling; the editing helpers below never
 * silently drop a keyframe a caller explicitly inserted (see their own doc
 * comments).
 *
 * ---- Empty track ----
 * `sampleCameraAt([], mileageM)` always returns `DEFAULT_CAMERA_CONFIG`,
 * whose distance/height/pitch numbers are `cameraPath.ts`'s own
 * `DEFAULT_FOLLOW_CAMERA_CONFIG` and whose `fovDeg` is Cesium's own
 * `PerspectiveFrustum` default (60 degrees -- verified against the
 * installed `cesium` build's `Camera` constructor, which sets
 * `frustum.fov = Math.toRadians(60)`). A project with no camera track is
 * therefore bit-for-bit the existing flythrough behaviour, unchanged --
 * the acceptance bar the brief states explicitly.
 */
import { DEFAULT_FOLLOW_CAMERA_CONFIG } from './cameraPath'

/** The camera parameters resolved at one mileage -- either copied straight
 * from a single keyframe, or interpolated between two. */
export interface CameraKeyframeConfig {
  /** Horizontal distance (m) behind the moving point -- same meaning as
   * `cameraPath.ts#FollowCameraConfig.distanceBehindM`. */
  distanceBehindM: number
  /** Vertical height (m) above the moving point -- same meaning as
   * `FollowCameraConfig.heightAboveM`. */
  heightAboveM: number
  /** Camera pitch in degrees -- same meaning/sign convention as
   * `FollowCameraConfig.pitchDeg` (negative tilts down toward the point). */
  pitchDeg: number
  /**
   * Degrees added to the path's own direction-of-travel heading before
   * `flythrough.ts` computes the follow offset -- `0` reproduces today's
   * plain chase-cam (directly behind, facing forward). A non-zero offset
   * swings the camera's "clock position" around the moving point while it
   * keeps looking straight at that point (see `flythrough.ts`'s own doc
   * comment for why `followCameraOffset`'s existing maths already makes
   * this a true look-at camera at any offset, not just at 0) -- this is
   * what the finish-line orbit template (`cameraTemplates.ts`) sweeps
   * through 360 degrees to fake an orbit within a mileage-parameterised
   * model. Deliberately relative to the path's own heading rather than an
   * absolute compass heading: an absolute heading would swing awkwardly
   * relative to the runner every time the route curves, which a
   * route-agnostic template must not assume anything about.
   */
  headingOffsetDeg: number
  /** Camera vertical field of view, in degrees. */
  fovDeg: number
  /**
   * Multiplies the *live-playback* speed only (see `flythrough.ts`'s
   * `handleTick`) -- deliberately NOT consumed by the deterministic
   * exporter's `frameSchedule.ts#FrameScheduleConfig.speedMps`, which stays
   * a single constant for the whole export. `frameSchedule.ts`'s whole
   * reason to exist is a *closed-form* `mileage(frameIndex)` function
   * (frame N's mileage must not depend on how the export got there) --
   * making speed vary with mileage would turn that into an integral of a
   * piecewise curve, a materially bigger change than this milestone's
   * brief lists (only `keyframes.ts`/`cameraTemplates.ts`/the UI). The
   * exported video still visits the exact same camera FRAMING at every
   * mileage as the live preview (both resolve through this same
   * `sampleCameraAt`, which is what "导出与预览镜头一致" asks for) -- it just
   * paces through mileage on the export's own uniform schedule rather than
   * dwelling extra real seconds during a "slow-mo" keyframe. See this
   * repo's P3-R3 report for this being a deliberate, documented scope call.
   */
  speedMultiplier: number
}

/** One keyframe: a `CameraKeyframeConfig` anchored at a specific mileage. */
export interface CameraKeyframe extends CameraKeyframeConfig {
  id: string
  /** Metres along the track this keyframe is anchored to. Never negative in
   * a well-formed track (see `moveKeyframe`'s own clamp), but `sampleCameraAt`
   * tolerates whatever it's given regardless (see its own doc comment). */
  mileageM: number
}

/** A camera track is just an ordered-by-convention list of keyframes --
 * "ordered by convention" because every function in this module tolerates
 * (and internally re-sorts) an out-of-order input; see each function's own
 * doc comment. Readonly because every editing helper below returns a new
 * array rather than mutating its input. */
export type CameraTrack = readonly CameraKeyframe[]

/** Cesium's own `PerspectiveFrustum` default field of view, verified
 * against the installed `cesium` build's `Camera` constructor
 * (`this.frustum.fov = Math.toRadians(60)`) rather than assumed from
 * memory -- see this file's header comment for why matching it exactly is
 * what makes an empty/default keyframe track a true no-op. */
export const DEFAULT_FOV_DEG = 60

/** The resolved config an empty (or fully-default) camera track produces --
 * distance/height/pitch copied from `cameraPath.ts`'s own
 * `DEFAULT_FOLLOW_CAMERA_CONFIG` (single source of truth, not a re-typed
 * copy that could drift), heading offset 0, Cesium's own default FOV, and a
 * 1x speed multiplier (no-op). */
export const DEFAULT_CAMERA_CONFIG: CameraKeyframeConfig = {
  distanceBehindM: DEFAULT_FOLLOW_CAMERA_CONFIG.distanceBehindM,
  heightAboveM: DEFAULT_FOLLOW_CAMERA_CONFIG.heightAboveM,
  pitchDeg: DEFAULT_FOLLOW_CAMERA_CONFIG.pitchDeg,
  headingOffsetDeg: 0,
  fovDeg: DEFAULT_FOV_DEG,
  speedMultiplier: 1,
}

// ---- Interpolation primitives ---------------------------------------------

/** Hermite ease: 0 at t<=0, 1 at t>=1, zero derivative at both ends. See
 * this file's header comment for why this (not linear, not Catmull-Rom) was
 * chosen for every numeric camera property. */
function smoothstep01(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * smoothstep01(t)
}

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** Shortest signed delta (degrees, in `(-180, 180]`) from `a` to `b` going
 * around the circle -- e.g. `shortestAngleDeltaDeg(350, 10) === 20` (the
 * short way, through 0), `shortestAngleDeltaDeg(10, 350) === -20` (the short
 * way the other direction), never the 340-degree long way either
 * direction. */
function shortestAngleDeltaDeg(a: number, b: number): number {
  return (((b - a + 180) % 360) + 360) % 360 - 180
}

function lerpAngleDeg(a: number, b: number, t: number): number {
  return normalizeDeg(a + shortestAngleDeltaDeg(a, b) * smoothstep01(t))
}

function lerpConfig(a: CameraKeyframeConfig, b: CameraKeyframeConfig, t: number): CameraKeyframeConfig {
  return {
    distanceBehindM: lerpNumber(a.distanceBehindM, b.distanceBehindM, t),
    heightAboveM: lerpNumber(a.heightAboveM, b.heightAboveM, t),
    pitchDeg: lerpNumber(a.pitchDeg, b.pitchDeg, t),
    headingOffsetDeg: lerpAngleDeg(a.headingOffsetDeg, b.headingOffsetDeg, t),
    fovDeg: lerpNumber(a.fovDeg, b.fovDeg, t),
    speedMultiplier: lerpNumber(a.speedMultiplier, b.speedMultiplier, t),
  }
}

function extractConfig(kf: CameraKeyframe): CameraKeyframeConfig {
  const { distanceBehindM, heightAboveM, pitchDeg, headingOffsetDeg, fovDeg, speedMultiplier } = kf
  return { distanceBehindM, heightAboveM, pitchDeg, headingOffsetDeg, fovDeg, speedMultiplier }
}

/**
 * Stably sorts by mileage, then collapses any run of keyframes sharing the
 * exact same mileage down to just the last one in that stable order (see
 * this file's header comment, "Ties" section) -- the result is always
 * strictly increasing in `mileageM`, which is what lets `sampleCameraAt`'s
 * bracket search below stay a simple, un-special-cased scan.
 */
function resolveOrder(track: CameraTrack): CameraKeyframe[] {
  const sorted = [...track].sort((a, b) => a.mileageM - b.mileageM)
  const result: CameraKeyframe[] = []
  for (const kf of sorted) {
    if (result.length > 0 && result[result.length - 1].mileageM === kf.mileageM) {
      result[result.length - 1] = kf // later keyframe at this exact mileage wins
    } else {
      result.push(kf)
    }
  }
  return result
}

/**
 * Resolves the camera configuration at `mileageM` by interpolating (or
 * holding, before the first/after the last keyframe) across `track`.
 *
 * - Empty track: `DEFAULT_CAMERA_CONFIG` (see this file's header comment --
 *   this is the "existing projects keep working unchanged" guarantee).
 * - Single-keyframe track: that keyframe's own config, for every mileage
 *   (no second point to interpolate toward).
 * - `mileageM` at or before the first keyframe, or at or after the last:
 *   holds that end keyframe's config rather than extrapolating -- a
 *   keyframe track describes a specific composed sequence, not an infinite
 *   curve.
 * - Otherwise: smoothstep-interpolates between the two bracketing
 *   keyframes (see this file's header comment for the per-property
 *   rationale).
 *
 * `track` does not need to be pre-sorted or de-duplicated by the caller --
 * this re-derives that order every call via `resolveOrder` (see its own
 * doc comment for the exact tie-break rule), so a track built by naive
 * appends (as the editing helpers below produce) is always sampled
 * correctly regardless of insertion order.
 */
export function sampleCameraAt(track: CameraTrack, mileageM: number): CameraKeyframeConfig {
  if (track.length === 0) return DEFAULT_CAMERA_CONFIG
  const ordered = resolveOrder(track)
  if (ordered.length === 1) return extractConfig(ordered[0])

  const m = Number.isFinite(mileageM) ? mileageM : 0
  if (m <= ordered[0].mileageM) return extractConfig(ordered[0])
  const lastKf = ordered[ordered.length - 1]
  if (m >= lastKf.mileageM) return extractConfig(lastKf)

  let i = 0
  for (let k = 0; k < ordered.length - 1; k++) {
    if (ordered[k].mileageM <= m) i = k
    else break
  }
  const a = ordered[i]
  const b = ordered[i + 1]
  const span = b.mileageM - a.mileageM
  // Defensive only -- resolveOrder guarantees strictly increasing mileage,
  // so this should be unreachable, but mirrors cameraPath.ts's own
  // `span > 0 ? ... : 0` guard rather than trusting that invariant blindly.
  if (span <= 0) return extractConfig(b)
  const t = (m - a.mileageM) / span
  return lerpConfig(extractConfig(a), extractConfig(b), t)
}

// ---- Editing helpers --------------------------------------------------------
//
// All four are pure: none mutate `track` or any keyframe inside it, all
// return a fresh array. None generate ids -- callers (this codebase's
// `state/appStore.ts` action, matching how it calls `core/model/track.ts#newId`
// for every other id it mints) own that, keeping this module free of any
// hidden `Date.now()`/counter side effect a "pure" module test shouldn't
// have to account for.

function sanitizeMileage(mileageM: number): number {
  return Number.isFinite(mileageM) ? Math.max(0, mileageM) : 0
}

/** Appends `keyframe` and re-sorts by mileage (stable, so a keyframe
 * inserted at the same mileage as an existing one sorts after it -- see
 * `resolveOrder`'s tie-break rule for what that means at sample time). */
export function insertKeyframe(track: CameraTrack, keyframe: CameraKeyframe): CameraTrack {
  const next = [...track, { ...keyframe, mileageM: sanitizeMileage(keyframe.mileageM) }]
  return next.sort((a, b) => a.mileageM - b.mileageM)
}

/** Changes `id`'s mileage and re-sorts. A no-op (returns `track`'s own
 * elements, but still a new array) if `id` isn't found. */
export function moveKeyframe(track: CameraTrack, id: string, newMileageM: number): CameraTrack {
  const next = track.map((k) => (k.id === id ? { ...k, mileageM: sanitizeMileage(newMileageM) } : k))
  return next.sort((a, b) => a.mileageM - b.mileageM)
}

/** Merges `patch` into `id`'s own config fields (never its `mileageM` --
 * use `moveKeyframe` for that). A no-op if `id` isn't found. */
export function updateKeyframe(track: CameraTrack, id: string, patch: Partial<CameraKeyframeConfig>): CameraTrack {
  return track.map((k) => (k.id === id ? { ...k, ...patch } : k))
}

/** Removes `id`. A no-op if `id` isn't found. */
export function deleteKeyframe(track: CameraTrack, id: string): CameraTrack {
  return track.filter((k) => k.id !== id)
}
