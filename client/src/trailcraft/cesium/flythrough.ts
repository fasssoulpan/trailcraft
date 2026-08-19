/**
 * Flythrough camera engine (P1 §3.3, milestone N3 commit 2): three camera
 * modes (跟随 FOLLOW / 俯瞰 ORBIT / 自由 FREE), a moving marker entity, and
 * play/pause/seek/speed playback, all driven by `cameraPath.ts`'s pure
 * mileage-parameterised path.
 *
 * This is the "untestable in Node" half of N3, same rule as
 * `trackEntities.ts`/`cpEntities.ts`: it touches real Cesium classes
 * (`Entity`, `Viewer`, `Transforms`, ...) which need a real WebGL-capable
 * environment. Everything that *can* be tested in Node (interpolation,
 * bearing, follow-offset maths, speed handling) lives in `cameraPath.ts` and
 * stays thin here -- this file is mostly plumbing that calls it every tick.
 *
 * `FlythroughEngine` is a class that owns its own state -- **not** the
 * reference implementation's module-level mutable `_state` singleton (see
 * `cyber-trail-hud/src/map/flythrough.js`). A module singleton would corrupt
 * itself across two Viewer instances or a React 18 StrictMode double-mount,
 * and cannot be unit-tested at all. Every field below lives on the
 * instance; `src/ui/FlyView.tsx` (commit 3) owns exactly one instance at a
 * time and is responsible for destroying it before creating a replacement.
 */
import {
  Cartesian3,
  Cartographic,
  ConstantPositionProperty,
  HeadingPitchRange,
  HeightReference,
  Math as CesiumMath,
  Matrix4,
  NearFarScalar,
  Transforms,
  VerticalOrigin,
  type Clock,
  type Entity,
  type Viewer,
} from 'cesium'
import type { Track } from '../core/model/track'
import { buildPositionArray, synthesizeTimeline, RENDER_MAX_3D } from './trackGeometry'
import {
  buildCameraPath,
  sampleAtMileage,
  mileageToProgress,
  progressToMileage,
  fullPrecisionIndex,
  followCameraOffset,
  speedToMileageDelta,
  averageSpeedMps,
  type CameraPath,
  type TrackPathPoint,
  type PathSample,
} from './cameraPath'
/**
 * Keyframe camera track (方案 V2.1 §5.5, milestone P3-R3) -- pure, no
 * `cesium` import of its own (see its file comment), so pulling it in here
 * doesn't change what this already-Cesium-touching module drags in.
 *
 * ---- This is where "live playback and export resolve the camera
 * identically" actually gets satisfied, not asserted ----
 * `applyFrame` below (the single per-frame update this engine has) calls
 * `sampleCameraAt(this.cameraTrack, this.mileageM)` once and uses the
 * result for FOLLOW-mode placement and FOV, in BOTH of `applyFrame`'s two
 * callers: `handleTick` (live playback, driven by `viewer.clock.onTick`)
 * and `seek` (used directly by the scrubber, AND by
 * `deterministicRenderer.ts#runDeterministicRender`'s per-frame
 * `engine.seek(progress)` loop during export -- see that module's own file
 * comment). There is no second copy of this resolution logic anywhere:
 * export doesn't get its own camera-placement code path to drift out of
 * sync with preview, it drives the exact same engine instance (see
 * `ui/FlyView.tsx`'s `handleStartExport`, which hands `engineRef.current`
 * itself to `startExport`) through the same `seek`/`applyFrame`.
 */
import { sampleCameraAt, type CameraTrack, type CameraKeyframeConfig } from './keyframes'

export type CameraMode = 'follow' | 'orbit' | 'free'

// Re-exported from speedOptions.ts so the engine's bounds and the UI's ladder
// cannot drift apart -- they did once, with the UI offering 500x while this
// clamped to 20x, making the four fastest buttons no-ops.
export { MIN_SPEED, MAX_SPEED, DEFAULT_SPEED } from './speedOptions'
import { clampSpeed, DEFAULT_SPEED } from './speedOptions'

// Fallback "1x" pace (m/s) when a track's own average pace can't be derived
// (zero/degenerate duration) -- same value as trackGeometry.ts's
// SYNTHETIC_SPEED_MPS, for the same reason (a plausible moderate trail pace,
// not a claim about the actual runner).
const DEFAULT_BASE_SPEED_MPS = 2.5

const ORBIT_ANGULAR_RATE_DEG_PER_SEC = 12
const ORBIT_PITCH_DEG = -45
const ORBIT_DEFAULT_RANGE_M = 600
const ORBIT_MIN_RANGE_M = 80
const ORBIT_MAX_RANGE_M = 20_000
const ORBIT_WHEEL_ZOOM_FACTOR = 1.2

/**
 * ---- The elevation gap (see this module's other doc comments for the
 * full reasoning) ----
 *
 * `trackGeometry.ts`'s `FALLBACK_HEIGHT_M = 0` is fine for the ground-
 * clamped polyline (trackEntities.ts renders it with `clampToGround: true`,
 * so the height value never actually reaches the screen), but the
 * flythrough CAMERA needs a real number to sit at -- a camera positioned at
 * "point height (0) + 55m above" on a mountain route with no recorded
 * elevation would end up hundreds of metres *underground*, not "55m above
 * the trail".
 *
 * Chosen fix: `effectiveGroundHeightM` below, opportunistic and synchronous
 * -- NOT the accurate-but-async terrain-sampling API
 * (`Scene#sampleHeightMostDetailed`/`clampToHeightMostDetailed`), which the
 * milestone brief explicitly flags as more complexity than N3 needs. Two
 * tiers, cheapest-correct-thing-first:
 *
 * 1. If the source `Track` actually has elevation data at this point (a
 *    real GPS/barometer reading, not a substituted fallback), trust it --
 *    it's directly the height the athlete was recorded at, at zero cost.
 * 2. Otherwise, ask `Scene.globe.getHeight()` -- a synchronous lookup
 *    against terrain tiles *already resident* for the currently-rendered
 *    area (not a network round-trip; returns `undefined` only if the tile
 *    genuinely isn't loaded yet, which should be rare here since the user
 *    has necessarily already been looking at this area in 3D before
 *    starting a flythrough). When available, this is real terrain height,
 *    not a guess.
 * 3. If neither is available (fresh viewer, tile not yet resident), fall
 *    back to the point's own (possibly 0) height plus a fixed clearance
 *    constant -- not accurate, but keeps the camera from reading as
 *    "buried in the mountain" in the worst case, which is the one thing
 *    that must never happen.
 */
const ELEVATIONLESS_CLEARANCE_M = 50

function effectiveGroundHeightM(viewer: Viewer, lon: number, lat: number, pointHeightM: number, hasElevation: boolean): number {
  if (hasElevation) return pointHeightM
  const terrainH = viewer.scene.globe.getHeight(Cartographic.fromDegrees(lon, lat))
  return terrainH !== undefined ? Math.max(pointHeightM, terrainH) : pointHeightM + ELEVATIONLESS_CLEARANCE_M
}

// ---- Moving marker ------------------------------------------------------
//
// The reference implementation builds a 4-frame running-animation billboard
// from a bundled `/runner.jpg` asset (see `cyber-trail-hud/src/map/
// track-renderer.js`'s `_buildFrames`/`startRunnerAnimation`). That asset
// does not exist in this repo and the milestone brief is explicit: do not
// add a binary asset for it. Instead, a small static marker (glowing dot,
// white ring) is drawn once with the Canvas API and cached as a data URI --
// no network request, no bundled binary, no per-frame animation loop to
// manage/tear down.
const MARKER_PX = 26
const MARKER_CLEARANCE_M = 2

/** Exported so `cesium/radarProjection.ts` (milestone N6 commit 4) can look
 * up the moving marker's current position via `viewer.entities.getById`
 * without duplicating this string literal -- the radar's screen centre is
 * this entity's live projected position, not something re-derived from
 * `FlythroughProgressInfo`. */
export const FLYTHROUGH_MARKER_ENTITY_ID = 'flythrough-marker'

let markerImageCache: string | undefined

function markerImage(): string {
  if (markerImageCache !== undefined) return markerImageCache
  const canvas = document.createElement('canvas')
  canvas.width = MARKER_PX
  canvas.height = MARKER_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    markerImageCache = ''
    return markerImageCache
  }
  const cx = MARKER_PX / 2
  const cy = MARKER_PX / 2
  ctx.beginPath()
  ctx.arc(cx, cy, MARKER_PX / 2 - 1, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(56, 189, 248, 0.30)'
  ctx.fill()
  ctx.beginPath()
  ctx.arc(cx, cy, MARKER_PX / 2 - 8, 0, Math.PI * 2)
  ctx.fillStyle = '#38bdf8'
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
  markerImageCache = canvas.toDataURL('image/png')
  return markerImageCache
}

function buildMarkerEntityOptions(position: TrackPathPoint, heightReference: HeightReference): Entity.ConstructorOptions {
  return {
    id: FLYTHROUGH_MARKER_ENTITY_ID,
    position: Cartesian3.fromDegrees(position.lon, position.lat, position.height),
    billboard: {
      image: markerImage(),
      width: MARKER_PX,
      height: MARKER_PX,
      heightReference,
      verticalOrigin: VerticalOrigin.CENTER,
      scaleByDistance: new NearFarScalar(100, 1.3, 10_000, 0.5),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  }
}

// ---- Progress reporting --------------------------------------------------

export interface FlythroughProgressInfo {
  /** 0..1 along the track. */
  progress: number
  mileageM: number
  /**
   * Full-precision index into the source `Track.points` columns -- the key
   * datum N4's HUD (and P0's statistics modules generally) needs, as
   * opposed to the decimated render-point index this engine samples
   * internally.
   */
  pointIndex: number
  isPlaying: boolean
  /**
   * Wall-clock seconds a full 1x traversal takes, i.e. total mileage divided
   * by this engine's own base speed. Reported from here rather than
   * recomputed by the UI so the displayed "how long will this take" can never
   * disagree with the speed model actually driving the camera (see
   * `cameraPath.ts#averageSpeedMps`). Divide by the speed multiplier for the
   * duration at any other setting.
   */
  baseDurationSeconds: number
}

export interface FlythroughEngineOptions {
  /** Called once per rendered frame (i.e. only while playing, or once after
   * a `seek`/construction) with the latest progress -- see this module's
   * file comment for why this is a callback rather than a store field: N4's
   * HUD needs up-to-60Hz updates while playing, which does not belong in
   * Zustand (see `state/appStore.ts`'s `flythroughSpeed`/
   * `flythroughCameraMode` doc comments for the settings that DO). */
  onProgress?: (info: FlythroughProgressInfo) => void
  /** Initial keyframe camera track (方案 V2.1 §5.5, milestone P3-R3) --
   * usually `Track.meta.cameraTrack ?? []`. Defaults to empty (today's
   * plain follow-cam behaviour, unchanged -- see `keyframes.ts`'s own doc
   * comment). Changeable later via `setCameraTrack` for live-preview
   * editing without rebuilding the whole engine. */
  cameraTrack?: CameraTrack
}

// ---- Engine ---------------------------------------------------------------

/**
 * Owns one moving marker entity and drives the camera for exactly one
 * `Viewer` + `Track` pair. Playback is driven by `viewer.clock.onTick`
 * (fires once per rendered frame) purely as a "a frame just rendered, tick"
 * pulse -- elapsed real time is measured with `performance.now()`, not
 * Cesium's simulated `Clock.currentTime`/`JulianDate`, since this engine's
 * position is a pure function of accumulated *mileage*
 * (`cameraPath.ts#speedToMileageDelta`), not of any Cesium-side clock.
 *
 * Lifecycle: construct once a `Viewer` and the `Track` to fly through are
 * both available; call `destroy()` exactly once when either the track
 * changes or the owning view unmounts (`FlyView.tsx`, commit 3, does both).
 * `destroy()` is idempotent and tolerates an already-destroyed `Viewer` --
 * the same discipline `cesium/viewer.ts`'s own `destroy()` documents for
 * surviving React 18 StrictMode's double-invoked effects.
 */
export class FlythroughEngine {
  private readonly viewer: Viewer
  private readonly markerEntity: Entity
  private readonly path: CameraPath
  private readonly idx: Uint32Array
  private readonly trackEle?: Float32Array
  private readonly hasElevationColumn: boolean
  private readonly onProgress?: (info: FlythroughProgressInfo) => void

  /** True when the source track had no recorded timestamps at all and
   * `trackGeometry.ts#synthesizeTimeline` had to invent one -- surfaced so
   * commit 3's UI can tell the user playback timing/duration is an
   * estimate, not the recorded pace. */
  readonly syntheticTimeline: boolean
  readonly totalMileageM: number
  /** This track's own "1x" pace (m/s, see `cameraPath.ts#averageSpeedMps`) --
   * public for the same reason `totalMileageM` is: P2's deterministic
   * frame-by-frame renderer (`frameSchedule.ts#FrameScheduleConfig.speedMps`)
   * needs the exact metres-per-second-of-virtual-time this engine's own
   * `speedToMileageDelta` calls would use, multiplied by `getSpeed()`'s
   * current multiplier -- reading it here keeps that one number defined in
   * exactly one place instead of re-deriving it from `totalMileageM` divided
   * by `FlythroughProgressInfo.baseDurationSeconds` (which is only ever
   * available a tick late, via the `onProgress` callback). */
  readonly baseSpeedMps: number

  private playing = false
  private speedMultiplier = DEFAULT_SPEED
  private cameraMode: CameraMode = 'follow'
  /** See `FlythroughEngineOptions.cameraTrack`/`setCameraTrack`. Resolved
   * once per frame in `applyFrame`, the single place both `handleTick`
   * (live playback) and `seek` (scrubber AND the deterministic exporter's
   * per-frame loop, see this file's own top-of-file comment) end up. */
  private cameraTrack: CameraTrack = []
  private mileageM = 0
  private lastTickMs = 0
  private orbitAngleDeg = 0
  private orbitRangeM = ORBIT_DEFAULT_RANGE_M
  private destroyed = false

  private readonly tickHandler: (clock: Clock) => void
  private readonly wheelHandler: (e: WheelEvent) => void

  constructor(viewer: Viewer, track: Track, options: FlythroughEngineOptions = {}) {
    this.viewer = viewer
    this.onProgress = options.onProgress
    this.cameraTrack = options.cameraTrack ?? []

    const { flat, idx } = buildPositionArray(track, RENDER_MAX_3D)
    this.idx = idx
    this.trackEle = track.points.ele
    this.hasElevationColumn = track.points.ele !== undefined

    const { times, synthetic } = synthesizeTimeline(track, idx)
    this.syntheticTimeline = synthetic
    const totalDurationSeconds = times.length > 0 ? times[times.length - 1] : 0

    const points: TrackPathPoint[] = new Array(idx.length)
    const mileage = new Float64Array(idx.length)
    const cumDist = track.points.cumDist
    for (let i = 0; i < idx.length; i++) {
      points[i] = { lon: flat[i * 3], lat: flat[i * 3 + 1], height: flat[i * 3 + 2] }
      // cumDist should always be present post-P0-import (see
      // trackGeometry.ts#synthesizeTimeline's own comment on this) -- the
      // times-based fallback only guards a track that somehow skipped that
      // pipeline (e.g. a hand-built test fixture).
      mileage[i] = cumDist ? cumDist[idx[i]] : (times[i] ?? 0) * DEFAULT_BASE_SPEED_MPS
    }
    this.path = buildCameraPath(points, mileage)
    this.totalMileageM = this.path.totalMileage
    this.baseSpeedMps = averageSpeedMps(this.path.totalMileage, totalDurationSeconds, DEFAULT_BASE_SPEED_MPS)

    const initialSample = sampleAtMileage(this.path, 0)
    const heightReference = this.hasElevationColumn ? HeightReference.NONE : HeightReference.CLAMP_TO_GROUND
    this.markerEntity = viewer.entities.add(
      buildMarkerEntityOptions(
        { ...initialSample.position, height: this.markerAbsoluteHeight(initialSample.position) },
        heightReference,
      ),
    )

    this.tickHandler = this.handleTick.bind(this)
    viewer.clock.onTick.addEventListener(this.tickHandler)

    // Wheel interception is ORBIT-only (matching the reference
    // implementation): FOLLOW/FREE leave zoom to Cesium's own camera
    // controller. Registered once for this engine's lifetime; the mode
    // check happens inside the handler itself so no listener needs to be
    // added/removed on every mode switch.
    this.wheelHandler = (e: WheelEvent) => {
      if (this.destroyed || this.cameraMode !== 'orbit') return
      e.preventDefault()
      e.stopPropagation()
      this.adjustOrbitRange(e.deltaY > 0 ? ORBIT_WHEEL_ZOOM_FACTOR : 1 / ORBIT_WHEEL_ZOOM_FACTOR)
    }
    viewer.scene.canvas.addEventListener('wheel', this.wheelHandler, { passive: false, capture: true })

    // Render one frame at the initial (paused, mileage 0) state immediately
    // -- without this, the marker/camera would only appear once the user
    // hits play or the canvas re-renders for an unrelated reason, since
    // viewer.ts constructs with requestRenderMode: true.
    this.applyFrame()
    if (!viewer.isDestroyed()) viewer.scene.requestRender()
  }

  // ---- Playback control ---------------------------------------------------

  play(): void {
    if (this.destroyed) return
    if (this.mileageM >= this.path.totalMileage) this.mileageM = 0
    this.playing = true
    // Next tick should compute a dt of ~0, not a large gap accumulated
    // while paused (no frames were rendering, so no ticks were firing, but
    // this guards the same edge case if that ever changes).
    this.lastTickMs = 0
    // The whole point of this flag: continuous rendering only while
    // something is actually animating (see this module's file comment) --
    // restored to true by pause()/stopAtEnd()/destroy() so an idle app
    // stops burning GPU/battery the moment playback isn't advancing.
    this.viewer.scene.requestRenderMode = false
    this.viewer.scene.requestRender()
  }

  pause(): void {
    if (this.destroyed) return
    this.playing = false
    this.viewer.scene.requestRenderMode = true
    this.viewer.scene.requestRender()
  }

  togglePlay(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  /** Jumps to `progress` (0..1) along the track, applying the new camera/
   * marker position immediately even while paused (a single explicit
   * `requestRender()` covers the `requestRenderMode: true` case). */
  seek(progress: number): void {
    if (this.destroyed) return
    this.mileageM = progressToMileage(this.path, progress)
    this.lastTickMs = 0
    this.applyFrame()
    this.viewer.scene.requestRender()
  }

  setSpeed(multiplier: number): void {
    this.speedMultiplier = clampSpeed(multiplier)
  }

  setCameraMode(mode: CameraMode): void {
    if (this.destroyed) return
    this.cameraMode = mode
    if (mode === 'free') {
      // Fully release the camera back to the user, mirroring the reference
      // implementation's FREE-mode transition: drop the ENU transform
      // ORBIT/FOLLOW may have left active and stop tracking any entity.
      this.viewer.camera.lookAtTransform(Matrix4.IDENTITY)
      this.viewer.trackedEntity = undefined
    }
    if (mode === 'orbit') this.orbitAngleDeg = 0
    this.viewer.scene.requestRender()
  }

  getCameraMode(): CameraMode {
    return this.cameraMode
  }

  getSpeed(): number {
    return this.speedMultiplier
  }

  getIsPlaying(): boolean {
    return this.playing
  }

  /**
   * Replaces the keyframe camera track and re-applies the current frame
   * immediately (mirrors `seek`'s own "apply immediately, even while
   * paused" behaviour) -- so a keyframe timeline edit shows up in the live
   * viewport the instant `ui/KeyframeEditor.tsx` commits it, not just on
   * the next tick/seek. Safe to call every keystroke; `applyFrame` and one
   * `requestRender()` are cheap relative to an actual Cesium render.
   */
  setCameraTrack(track: CameraTrack): void {
    if (this.destroyed) return
    this.cameraTrack = track
    this.applyFrame()
    this.viewer.scene.requestRender()
  }

  /**
   * Fully disposes this engine: tick listener, wheel listener, marker
   * entity, and releases the camera transform/tracked-entity if this
   * engine had claimed either. Idempotent and tolerant of an
   * already-destroyed `Viewer` (the owning `FlyView.tsx` may tear down the
   * whole Viewer in the same unmount that destroys this engine, in either
   * order) -- both properties this class needs for React 18 StrictMode's
   * double-invoked effects and for a plan→fly→plan→fly mode-switch round
   * trip to never leak a listener or a stray entity.
   */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.viewer.isDestroyed()) return
    this.viewer.clock.onTick.removeEventListener(this.tickHandler)
    this.viewer.scene.canvas.removeEventListener('wheel', this.wheelHandler, true)
    if (this.viewer.entities.contains(this.markerEntity)) this.viewer.entities.remove(this.markerEntity)
    if (this.viewer.trackedEntity === this.markerEntity) this.viewer.trackedEntity = undefined
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY)
    this.viewer.scene.requestRenderMode = true
    this.viewer.scene.requestRender()
  }

  // ---- Per-frame update -----------------------------------------------------

  private handleTick(): void {
    if (this.destroyed) return
    const now = performance.now()
    const dtSec = this.lastTickMs > 0 ? Math.max(0, (now - this.lastTickMs) / 1000) : 0
    this.lastTickMs = now

    if (this.playing) {
      // The keyframe track's own speedMultiplier (resolved at the CURRENT,
      // pre-advance mileage) scales live playback the same way the user's
      // own speed chip does -- see `keyframes.ts#CameraKeyframeConfig
      // .speedMultiplier`'s doc comment for exactly why this is
      // preview-only and never reaches `frameSchedule.ts`'s export
      // schedule (a single constant speed for the whole export).
      const keyframeSpeedMultiplier = sampleCameraAt(this.cameraTrack, this.mileageM).speedMultiplier
      const delta = speedToMileageDelta(this.speedMultiplier * keyframeSpeedMultiplier, dtSec, this.baseSpeedMps)
      const next = this.mileageM + delta
      if (next >= this.path.totalMileage) {
        this.mileageM = this.path.totalMileage
        // Auto-stop at the end, mirroring how a video player pauses on
        // reaching the end rather than sitting on a frozen-but-"playing"
        // last frame -- also what puts requestRenderMode back to true
        // without the caller having to notice mileage saturated.
        this.playing = false
        this.viewer.scene.requestRenderMode = true
      } else {
        this.mileageM = next
      }
      if (this.cameraMode === 'orbit') {
        this.orbitAngleDeg = (this.orbitAngleDeg + ORBIT_ANGULAR_RATE_DEG_PER_SEC * dtSec) % 360
      }
    }

    this.applyFrame()
  }

  private markerAbsoluteHeight(position: TrackPathPoint): number {
    return this.hasElevationColumn ? position.height + MARKER_CLEARANCE_M : position.height
  }

  /** Whether the *specific* render point `sample` brackets has real
   * elevation data (not a substituted `FALLBACK_HEIGHT_M`) -- checked
   * per-sample against the source track's raw `ele` column (via `idx`)
   * rather than once for the whole track, since a track can have the
   * column present but an individual `NaN` value partway through (see
   * `trackGeometry.ts`'s `FALLBACK_HEIGHT_M` doc comment for both cases). */
  private hasElevationAt(sample: PathSample): boolean {
    if (!this.trackEle || this.idx.length === 0) return false
    const clampedRenderIndex = Math.min(Math.max(sample.renderIndex, 0), this.idx.length - 1)
    const raw = this.trackEle[this.idx[clampedRenderIndex]]
    return Number.isFinite(raw)
  }

  private applyFrame(): void {
    const sample = sampleAtMileage(this.path, this.mileageM)
    const markerCartesian = Cartesian3.fromDegrees(
      sample.position.lon,
      sample.position.lat,
      this.markerAbsoluteHeight(sample.position),
    )
    this.markerEntity.position = new ConstantPositionProperty(markerCartesian)

    // Resolved ONCE per frame, here -- see this file's own top-of-file
    // comment for why this single call site (reached by both `handleTick`
    // and `seek`, and therefore by the deterministic exporter's per-frame
    // `seek` loop too) is what makes preview and export share one camera
    // resolution path rather than two that merely "should" agree.
    const cameraConfig = sampleCameraAt(this.cameraTrack, this.mileageM)

    // FOV is a projection property, not something FOLLOW/ORBIT/FREE each
    // define their own version of -- applied unconditionally every frame
    // regardless of mode so it can never get "stuck" at a keyframe's value
    // after switching away from FOLLOW (each frame re-resolves it fresh
    // from the current mileage, same as everything else here). A no-op
    // write whenever the track is empty (`cameraConfig.fovDeg ===
    // DEFAULT_FOV_DEG === 60`, Cesium's own default -- see keyframes.ts).
    const frustum = this.viewer.camera.frustum as { fov?: number }
    if (typeof frustum.fov === 'number') frustum.fov = CesiumMath.toRadians(cameraConfig.fovDeg)

    switch (this.cameraMode) {
      case 'follow':
        this.applyFollowCamera(sample, cameraConfig)
        break
      case 'orbit':
        this.applyOrbitCamera(sample)
        break
      case 'free':
        break // camera left entirely to the user
    }

    this.onProgress?.({
      progress: mileageToProgress(this.path, this.mileageM),
      mileageM: this.mileageM,
      pointIndex: fullPrecisionIndex(this.idx, sample.renderIndex, sample.t),
      isPlaying: this.playing,
      baseDurationSeconds: this.baseSpeedMps > 0 ? this.path.totalMileage / this.baseSpeedMps : 0,
    })
  }

  /**
   * `cameraConfig` is `sampleCameraAt`'s resolved distance/height/pitch/
   * heading-offset for the current mileage -- `DEFAULT_CAMERA_CONFIG` when
   * `cameraTrack` is empty, numerically identical to the
   * `DEFAULT_FOLLOW_CAMERA_CONFIG`/`headingDeg` (no offset) this call used
   * before keyframes existed, so an empty track reproduces the exact same
   * camera as before this milestone.
   *
   * `headingOffsetDeg` is added directly to `sample.headingDeg` (the
   * unnormalised sum is fine -- `followCameraOffset` normalises internally
   * wherever it matters) BEFORE calling `followCameraOffset`, which places
   * the camera behind the point along *that* rotated heading and points it
   * back along the same heading. Because `followCameraOffset`'s position
   * and orientation are constructed from the identical heading value, the
   * point always sits exactly on the camera's forward ray by construction
   * -- i.e. this is already a true look-at-the-point camera at ANY offset,
   * not just at 0 (offset 0 is simply the plain forward-facing chase cam
   * this engine has always used). This is what lets the finish-line orbit
   * template sweep the heading offset through 360 degrees and get an
   * actual orbit-look, with no separate "look at" computation needed here.
   */
  private applyFollowCamera(sample: PathSample, cameraConfig: CameraKeyframeConfig): void {
    const hasElevation = this.hasElevationAt(sample)
    const groundHeight = effectiveGroundHeightM(
      this.viewer,
      sample.position.lon,
      sample.position.lat,
      sample.position.height,
      hasElevation,
    )
    const groundPoint: TrackPathPoint = { lon: sample.position.lon, lat: sample.position.lat, height: groundHeight }
    const positionHeadingDeg = sample.headingDeg + cameraConfig.headingOffsetDeg
    const pose = followCameraOffset(groundPoint, positionHeadingDeg, {
      distanceBehindM: cameraConfig.distanceBehindM,
      heightAboveM: cameraConfig.heightAboveM,
      pitchDeg: cameraConfig.pitchDeg,
    })
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(pose.position.lon, pose.position.lat, pose.position.height),
      orientation: {
        heading: CesiumMath.toRadians(pose.headingDeg),
        pitch: CesiumMath.toRadians(pose.pitchDeg),
        roll: 0,
      },
    })
  }

  private applyOrbitCamera(sample: PathSample): void {
    const hasElevation = this.hasElevationAt(sample)
    const groundHeight = effectiveGroundHeightM(
      this.viewer,
      sample.position.lon,
      sample.position.lat,
      sample.position.height,
      hasElevation,
    )
    const origin = Cartesian3.fromDegrees(sample.position.lon, sample.position.lat, groundHeight)
    const transform = Transforms.eastNorthUpToFixedFrame(origin)
    this.viewer.camera.lookAtTransform(
      transform,
      new HeadingPitchRange(CesiumMath.toRadians(this.orbitAngleDeg), CesiumMath.toRadians(ORBIT_PITCH_DEG), this.orbitRangeM),
    )
  }

  private adjustOrbitRange(factor: number): void {
    this.orbitRangeM = Math.max(ORBIT_MIN_RANGE_M, Math.min(ORBIT_MAX_RANGE_M, this.orbitRangeM * factor))
    if (!this.viewer.isDestroyed()) this.viewer.scene.requestRender()
  }
}
