/**
 * Renders P0 `Track`s into a Cesium `Viewer`'s entity collection for
 * TrailCraft's 3D flythrough mode (P1 §3.1/§3.2, milestone N2).
 *
 * This is the "untestable in Node" half of the bridge -- it touches real
 * Cesium classes (`Entity`, `PolylineGlowMaterialProperty`, `Cartesian3`,
 * ...), which need a real WebGL-capable environment. Per the milestone
 * brief, Cesium entity construction is deliberately NOT unit-tested here;
 * all the logic that *can* be tested in Node (decimation, height fallback,
 * timeline synthesis) lives in `trackGeometry.ts` and stays thin here --
 * this file is mostly plumbing that calls it.
 *
 * Mirrors `src/map/trackLayer.ts`'s `syncTrackLayers` contract as closely
 * as Cesium's API allows: add entities for new tracks, update changed ones
 * in place, remove entities for tracks no longer present, and memoise
 * expensive per-track geometry in a `WeakMap` keyed on the immutable
 * `Track` object (churn from hover/camera movement re-renders React but
 * never touches the Track objects themselves, so the cache survives that).
 */
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Color,
  ConstantProperty,
  HeadingPitchRange,
  HeightReference,
  LabelStyle,
  NearFarScalar,
  PolylineGlowMaterialProperty,
  VerticalOrigin,
  Math as CesiumMath,
  type Entity,
  type Viewer,
} from 'cesium'
import type { Track } from '../core/model/track'
import { buildPositionArray, synthesizeTimeline, RENDER_MAX_3D } from './trackGeometry'
import { TRACK_PALETTE, DEFAULT_LINE_WIDTH } from '../core/model/trackStyle'

// ---- Geometry memoisation -------------------------------------------------

interface TrackGeometry {
  /** Ground positions for every render point, same order as trackGeometry's `idx`. */
  positions: Cartesian3[]
  /** Full-precision index of each render position (see trackGeometry.ts). */
  idx: Uint32Array
  /** Per-render-point playback time in seconds from start (N3 will consume this). */
  times: number[]
  syntheticTimeline: boolean
  startPos: Cartesian3
  finishPos: Cartesian3
}

// Keyed on the Track object itself (not its id): P0's Track is immutable --
// any edit (toolbox op, or even just a color/lineWidth style tweak in
// appStore's updateTrackStyle) produces a brand-new object -- so identity
// change is exactly the right cache-invalidation signal, and this is the
// same convention trackLayer.ts's `renderCopyCache` already established for
// the 2D view.
const geometryCache = new WeakMap<Track, TrackGeometry>()

function getGeometry(track: Track): TrackGeometry {
  const cached = geometryCache.get(track)
  if (cached) return cached
  const { flat, idx } = buildPositionArray(track, RENDER_MAX_3D)
  const { times, synthetic } = synthesizeTimeline(track, idx)
  const positions = Cartesian3.fromDegreesArrayHeights(flat)
  const geometry: TrackGeometry = {
    positions,
    idx,
    times,
    syntheticTimeline: synthetic,
    // decimateIndices always keeps the first and last point (see
    // core/toolbox/decimate.ts), so positions[0]/[last] are the track's
    // actual, full-precision start/finish -- no separate lookup needed.
    startPos: positions[0],
    finishPos: positions[positions.length - 1],
  }
  geometryCache.set(track, geometry)
  return geometry
}

// ---- Styling ---------------------------------------------------------------

// Reuses the CP marker palette's aid/danger colours (src/map/trackLayer.ts's
// CP_KIND_COLORS) rather than inventing a new green/red -- keeps the app's
// total colour vocabulary small and these two already read as
// "safe/good" (aid=green) and "watch out/end" (danger=red) elsewhere in the
// UI.
const START_COLOR = '#16a34a'
const FINISH_COLOR = '#dc2626'

/** Opacity applied to every track except the active one, once something IS
 * active -- mirrors trackLayer.ts's `syncTrackLayers` exactly (0.45), so the
 * two views read consistently when a user switches between 规划/巡游 modes. */
const INACTIVE_OPACITY = 0.45
const ACTIVE_WIDTH_BONUS = 1.5

function trackStyle(track: Track, index: number, activeTrackId: string | undefined) {
  const color = track.meta.color ?? TRACK_PALETTE[index % TRACK_PALETTE.length]
  const baseWidth = track.meta.lineWidth ?? DEFAULT_LINE_WIDTH
  const isActive = track.id === activeTrackId
  const opacity = activeTrackId === undefined || isActive ? 1 : INACTIVE_OPACITY
  const width = isActive ? baseWidth + ACTIVE_WIDTH_BONUS : baseWidth
  return { color, opacity, width, isActive }
}

function applyLineStyle(line: Entity, color: string, opacity: number, width: number): void {
  if (!line.polyline) return
  line.polyline.width = new ConstantProperty(width)
  line.polyline.material = new PolylineGlowMaterialProperty({
    glowPower: 0.25,
    color: Color.fromCssColorString(color).withAlpha(opacity),
  })
}

// ---- Entity ids --------------------------------------------------------

function lineId(trackId: string): string {
  return `trk-line-${trackId}`
}
function startId(trackId: string): string {
  return `trk-start-${trackId}`
}
function finishId(trackId: string): string {
  return `trk-finish-${trackId}`
}

/**
 * Builds a start/finish point-plus-label entity. Labels use
 * FILL_AND_OUTLINE with a black outline (matching the reference
 * implementation's approach) so 起点/终点 stay legible over both the
 * satellite imagery and the flat/ellipsoid fallback -- a plain fill would
 * wash out against bright imagery the way the 2D CP markers' plain color
 * fills never have to worry about (2D markers sit on a light OSM basemap,
 * not imagery).
 */
function buildMarkerEntity(id: string, position: Cartesian3, color: string, text: string): Entity.ConstructorOptions {
  return {
    id,
    position,
    point: {
      pixelSize: 12,
      color: Color.fromCssColorString(color),
      outlineColor: Color.WHITE,
      outlineWidth: 2,
      heightReference: HeightReference.CLAMP_TO_GROUND,
      scaleByDistance: new NearFarScalar(500, 1.0, 50_000, 0.4),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text,
      font: 'bold 14px sans-serif',
      fillColor: Color.fromCssColorString(color),
      outlineColor: Color.BLACK,
      outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: VerticalOrigin.BOTTOM,
      pixelOffset: new Cartesian2(0, -18),
      scaleByDistance: new NearFarScalar(500, 1.0, 50_000, 0.3),
      heightReference: HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  }
}

// ---- Sync state --------------------------------------------------------

interface TrackEntityGroup {
  /** The Track object these entities were built from -- compared by
   * reference to detect "this track's data or style-relevant meta changed
   * and the entities need rebuilding" vs. "nothing changed, only
   * activeTrackId or index did". */
  track: Track
  line: Entity
  start: Entity
  finish: Entity
}

const knownEntities = new WeakMap<Viewer, Map<string, TrackEntityGroup>>()

// Camera-fit request queued for a viewer, analogous to trackLayer.ts's
// `pendingFit`/`tryPendingFit`. See `flyToTrack`'s doc comment for why this
// exists for Cesium too, not just MapLibre.
const pendingFlyTo = new WeakMap<Viewer, string>()

function removeGroup(viewer: Viewer, group: TrackEntityGroup): void {
  viewer.entities.remove(group.line)
  viewer.entities.remove(group.start)
  viewer.entities.remove(group.finish)
}

/**
 * Adds/updates/removes one polyline + start/finish marker pair per track in
 * `viewer`'s entity collection, mirroring `trackLayer.ts`'s
 * `syncTrackLayers` contract:
 * - Tracks no longer in `tracks` have their entities removed.
 * - A track whose object reference hasn't changed since the last sync only
 *   gets its style (colour/width/opacity, driven by `activeTrackId`)
 *   refreshed in place -- no geometry rebuild, no entity churn.
 * - A new track, or one whose reference changed (any edit, since Track is
 *   immutable), gets its geometry rebuilt from scratch via
 *   `trackGeometry.ts` (through the `WeakMap` cache above, so repeated
 *   syncs of the *same* new object are still cheap) and its entities
 *   replaced.
 * - The most recently added track is queued for a camera fly-to via
 *   `pendingFlyTo`, matching the 2D view's "fit the newest track" behaviour
 *   documented on `trackLayer.ts`'s `pendingFit`.
 */
export function syncTrackEntities(viewer: Viewer, tracks: Track[], activeTrackId?: string): void {
  let known = knownEntities.get(viewer)
  if (!known) {
    known = new Map()
    knownEntities.set(viewer, known)
  }

  const currentIds = new Set(tracks.map((t) => t.id))
  for (const [id, group] of known) {
    if (currentIds.has(id)) continue
    removeGroup(viewer, group)
    known.delete(id)
  }

  let newestTrackId: string | undefined
  tracks.forEach((track, i) => {
    const { color, opacity, width } = trackStyle(track, i, activeTrackId)
    const existing = known!.get(track.id)

    if (existing && existing.track === track) {
      applyLineStyle(existing.line, color, opacity, width)
      return
    }

    if (existing) removeGroup(viewer, existing)

    const geometry = getGeometry(track)
    const line = viewer.entities.add({
      id: lineId(track.id),
      polyline: {
        positions: geometry.positions,
        clampToGround: true,
        width,
        material: new PolylineGlowMaterialProperty({
          glowPower: 0.25,
          color: Color.fromCssColorString(color).withAlpha(opacity),
        }),
      },
    })
    const start = viewer.entities.add(buildMarkerEntity(startId(track.id), geometry.startPos, START_COLOR, '起点'))
    const finish = viewer.entities.add(buildMarkerEntity(finishId(track.id), geometry.finishPos, FINISH_COLOR, '终点'))

    known!.set(track.id, { track, line, start, finish })
    if (!existing) newestTrackId = track.id
  })

  if (newestTrackId) pendingFlyTo.set(viewer, newestTrackId)
  tryPendingFlyTo(viewer, tracks)
}

// ---- Camera framing -----------------------------------------------------

/** Minimum canvas dimension (device px) below which a fly-to isn't
 * attempted -- mirrors trackLayer.ts's `MIN_USABLE_PX` guard for the
 * MapLibre case. See `flyToTrack`'s doc comment for why Cesium needs the
 * same guard. */
const MIN_USABLE_PX = 2

function canvasUsable(viewer: Viewer): boolean {
  const canvas = viewer.canvas
  return canvas.clientWidth >= MIN_USABLE_PX && canvas.clientHeight >= MIN_USABLE_PX
}

function doFlyTo(viewer: Viewer, track: Track): void {
  const geometry = getGeometry(track)
  if (geometry.positions.length === 0) return
  const sphere = BoundingSphere.fromPoints(geometry.positions)
  // A single-point (or near-coincident-points) track collapses to
  // `sphere.radius === 0`; floor the offset distance so the camera doesn't
  // end up sitting exactly on top of the point.
  const range = Math.max(sphere.radius * 2.2, 300)
  viewer.camera.flyToBoundingSphere(sphere, {
    duration: 1.5,
    offset: new HeadingPitchRange(0, CesiumMath.toRadians(-45), range),
  })
}

/**
 * Retries whichever track is currently owed a camera fly-to (queued by
 * `syncTrackEntities` for a newly added track, or by `flyToTrack` below for
 * a manual 定位 click), once `viewer`'s canvas actually has a usable size.
 *
 * Why this exists at all, mirroring trackLayer.ts's `tryPendingFit`:
 * Cesium's `CesiumWidget` render loop re-measures its canvas and
 * self-corrects on its own on every frame it *does* render -- but
 * `viewer.ts` constructs the Viewer with `requestRenderMode: true`, so no
 * frame renders at all until something requests one, and `camera.flyTo`/
 * `flyToBoundingSphere` compute their destination from the *current*
 * frustum aspect ratio derived from canvas width/height right when called.
 * Calling it the instant a track first appears -- e.g. from
 * `syncTrackEntities`, itself called from a mount-time effect -- can race
 * the container's flex layout the exact same way `MapLibreMap.fitBounds`
 * does in `trackLayer.ts` (see that file's `fitCamera` comment): the
 * `app-layout__map` div both views mount into has no guaranteed non-zero
 * size on the very first layout pass. Deferring the retry to whenever the
 * container's `ResizeObserver` next fires (see `FlyView.tsx`) covers that
 * window the same way `MapView.tsx` already does for the 2D case.
 */
export function tryPendingFlyTo(viewer: Viewer, tracks: Track[]): void {
  const trackId = pendingFlyTo.get(viewer)
  if (!trackId) return
  if (!canvasUsable(viewer)) return
  const track = tracks.find((t) => t.id === trackId)
  if (!track) {
    pendingFlyTo.delete(viewer) // removed before it ever got its fly-to
    return
  }
  doFlyTo(viewer, track)
  pendingFlyTo.delete(viewer)
}

/**
 * Frames `track` in `viewer`'s camera. Backs the same "定位" (locate)
 * button `TrackList` already drives in 2D via `trackLayer.ts`'s
 * `locateTrack` -- `FlyView.tsx` wires appStore's `locateRequest` to this
 * function so the control works identically in flythrough mode.
 *
 * If the canvas isn't usable yet (see `tryPendingFlyTo`'s comment), queues
 * the request instead of flying immediately -- the queued request also
 * naturally coalesces with (replaces) the "newest track" auto-fit request
 * `syncTrackEntities` may have already queued, which is fine: only the
 * most recent fly-to request ever needs to win.
 */
export function flyToTrack(viewer: Viewer, track: Track): void {
  if (!canvasUsable(viewer)) {
    pendingFlyTo.set(viewer, track.id)
    return
  }
  doFlyTo(viewer, track)
}
