/**
 * Cesium-side projection for the distance-radar overlay (P1 §3.7, milestone
 * N6 commit 4): "where is the centre and what is the scale", kept
 * deliberately separate from `overlay/radarRender.ts`'s ring geometry/
 * labelling and `overlay/radarMath.ts`'s ring-distance ladder -- per the
 * milestone brief's own open question (concentric range rings vs. a
 * "distance to next checkpoint" indicator), this is the one piece of the
 * whole feature that would need to change if that pivots, and it should be
 * cheap to swap out without touching the other two.
 *
 * Everything here is a real Cesium value import, so this module only ever
 * loads through the same dynamic `import()` boundary as `viewer.ts`/
 * `flythrough.ts`/`contours.ts` (see `ui/FlyView.tsx`) -- `ui/RadarOverlay.tsx`
 * itself only imports the plain-number `RadarProjection` result *type* from
 * here, never a value, so it stays out of the main bundle. This mirrors the
 * exact reasoning `ui/HudOverlay.tsx`/`ui/CheckpointCard.tsx` already
 * document for their own `FlythroughProgressInfo` type-only imports.
 */
import { Cartesian2, Cartesian3, SceneTransforms } from './runtime'
import type { Scene, Viewer } from 'cesium'
import { FLYTHROUGH_MARKER_ENTITY_ID } from './flythrough'

/**
 * `Scene#pixelRatio` is a real runtime getter (verified in
 * node_modules/cesium/Build/Cesium/Cesium.js: `this._pixelRatio`, defaulting
 * to 1 and set from `options.pixelRatio`/`devicePixelRatio`) that this
 * version's shipped `Cesium.d.ts` simply doesn't declare -- every one of
 * `getPixelDimensions`'s own JSDoc examples pass `scene.pixelRatio` as this
 * exact argument, so this is a typings gap, not a real API absence. Narrowed
 * locally rather than reaching for a blanket `as any`.
 */
type SceneWithPixelRatio = Scene & { readonly pixelRatio: number }

export interface RadarProjection {
  /** Screen-space centre, css pixels. */
  centerX: number
  centerY: number
  /** Ground scale at the marker's current distance from the camera. */
  metersPerPixel: number
  /** Camera heading, radians, clockwise from north (Cesium's own
   * `camera.heading` convention). */
  headingRad: number
}

/**
 * Projects the live flythrough marker entity to screen coordinates and
 * derives the current ground scale, or `undefined` when there's nothing
 * meaningful to draw (no active flythrough, the marker hasn't been
 * positioned yet, or it's currently behind the camera -- see the dot-product
 * guard below).
 */
export function projectRadarCenter(viewer: Viewer): RadarProjection | undefined {
  const marker = viewer.entities.getById(FLYTHROUGH_MARKER_ENTITY_ID)
  const position = marker?.position?.getValue(viewer.clock.currentTime)
  if (!position) return undefined

  const camera = viewer.camera

  // `SceneTransforms.worldToWindowCoordinates` projects using simple
  // perspective math with no "is this point actually in front of the
  // camera" check of its own -- a point behind the camera can still project
  // to *some* window coordinate, which would draw the radar in a
  // nonsensical spot (or even back inside the visible canvas) in ORBIT/FREE
  // camera modes where the marker can end up behind the viewer. Guard with
  // the sign of the dot product between the camera's forward direction and
  // the vector to the marker; only project when that's positive.
  const toMarker = Cartesian3.subtract(position, camera.positionWC, new Cartesian3())
  if (Cartesian3.dot(camera.directionWC, toMarker) <= 0) return undefined

  // Cesium 1.144's SceneTransforms exposes `worldToWindowCoordinates` (not
  // `wgs84ToWindowCoordinates`, which some earlier releases used) -- checked
  // directly against node_modules/cesium/Source/Cesium.d.ts rather than
  // assumed, since this exact method has been renamed across Cesium
  // releases.
  const screenPos = SceneTransforms.worldToWindowCoordinates(viewer.scene, position)
  if (!screenPos) return undefined

  const distanceM = Cartesian3.distance(camera.positionWC, position)
  const pixelDims = camera.frustum.getPixelDimensions(
    viewer.scene.drawingBufferWidth,
    viewer.scene.drawingBufferHeight,
    distanceM,
    (viewer.scene as SceneWithPixelRatio).pixelRatio,
    new Cartesian2(),
  )

  return {
    centerX: screenPos.x,
    centerY: screenPos.y,
    metersPerPixel: pixelDims.x,
    headingRad: camera.heading,
  }
}
