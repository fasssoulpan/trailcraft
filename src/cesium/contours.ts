/**
 * Cesium contour-line overlay (P1 §3.6, milestone N6 commit 3), applied to
 * the globe via `Globe#material`.
 *
 * ---- Which Cesium API this uses ----
 * Checked against the actually-installed `cesium` package (1.144.0, see
 * `node_modules/cesium/Source/Cesium.d.ts`) before writing anything here:
 * Cesium ships a built-in `'ElevationContour'` fabric material type
 * (`Material.ElevationContourType`, documented uniforms `color`/`spacing`/
 * `width` -- see that file's own `Material` class doc comment), constructed
 * the same way any other built-in material is, via
 * `Material.fromType('ElevationContour', { color, spacing, width })`. No
 * fallback to `createElevationBandMaterial` (elevation-band colouring) was
 * needed -- the real contour-line material is present and directly usable in
 * this version, so that's what's wired up below.
 *
 * ---- Updating spacing as the camera moves ----
 * Hooked to `viewer.camera.changed`/`moveEnd`, NOT to every rendered frame --
 * per the milestone brief's explicit callout against rebuilding a material
 * every frame. `refresh()` below only actually reassigns
 * `viewer.scene.globe.material` when the *computed* spacing or the current
 * basemap style preset has changed since the last time it ran; a `changed`/
 * `moveEnd` firing that doesn't cross a `contourSpacing.ts` band boundary (or
 * change the preset) is a cheap no-op. `camera.percentageChanged` is lowered
 * from Cesium's 50%-of-scene default so `changed` actually fires while
 * zooming through a single band, not only after a huge camera move.
 *
 * `viewer.ts` constructs the Viewer with `requestRenderMode: true`, so every
 * material (re)assignment below is paired with an explicit
 * `scene.requestRender()` -- without it, the new material would sit applied
 * but unpainted until something else happened to trigger a repaint.
 */
import { Color, Material, type Cartographic, type Viewer } from 'cesium'
import { contourSpacingForCameraHeight } from './contourSpacing'
import { contourPresetForStyle } from './contourPreset'
import type { BasemapStyle } from '../state/basemapPref'

export interface ContourHandle {
  setEnabled(enabled: boolean): void
  setBasemapStyle(style: BasemapStyle): void
  destroy(): void
}

// Lower than Cesium's own default (0.5 -- see Camera#percentageChanged's own
// doc comment) so `camera.changed` fires granularly enough to catch a normal
// zoom crossing a contourSpacing.ts band boundary, while still nowhere near
// "every frame" (that's what the brief explicitly warns against).
const CONTOUR_CAMERA_PERCENTAGE_CHANGED = 0.05

function heightAboveGroundM(viewer: Viewer): number {
  const carto: Cartographic = viewer.camera.positionCartographic
  // Scene.globe.getHeight is a synchronous lookup against terrain tiles
  // already resident for the currently-rendered area (no network round
  // trip) -- same technique flythrough.ts's effectiveGroundHeightM already
  // uses for the same reason. Falls back to raw camera height above the
  // ellipsoid (never undefined/NaN) when no tile is resident yet, which
  // contourSpacingForCameraHeight treats safely either way.
  const groundH = viewer.scene.globe.getHeight(carto)
  return groundH !== undefined ? carto.height - groundH : carto.height
}

/**
 * Wires the contour overlay to a live `Viewer`. Starts disabled --
 * `layerPrefs.ts`'s `contoursEnabled` default is `false`, and this handle
 * mirrors whatever the caller (`FlyView.tsx`) tells it via `setEnabled`/
 * `setBasemapStyle`, it does not read the store itself.
 */
export function attachContours(viewer: Viewer, initialStyle: BasemapStyle): ContourHandle {
  let enabled = false
  let style = initialStyle
  let appliedSpacing: number | undefined
  let appliedStyle: BasemapStyle | undefined

  function refresh(force: boolean): void {
    if (viewer.isDestroyed()) return

    if (!enabled) {
      if (viewer.scene.globe.material) {
        viewer.scene.globe.material = undefined
        viewer.scene.requestRender()
      }
      return
    }

    const spacing = contourSpacingForCameraHeight(heightAboveGroundM(viewer))
    if (!force && spacing === appliedSpacing && style === appliedStyle) return

    appliedSpacing = spacing
    appliedStyle = style
    const preset = contourPresetForStyle(style)
    viewer.scene.globe.material = Material.fromType('ElevationContour', {
      color: Color.fromCssColorString(preset.colorCss).withAlpha(preset.alpha),
      spacing,
      width: preset.widthPx,
    })
    viewer.scene.requestRender()
  }

  const listener = () => refresh(false)
  viewer.camera.changed.addEventListener(listener)
  viewer.camera.moveEnd.addEventListener(listener)
  viewer.camera.percentageChanged = Math.min(viewer.camera.percentageChanged, CONTOUR_CAMERA_PERCENTAGE_CHANGED)

  return {
    setEnabled(next) {
      if (enabled === next) return
      enabled = next
      refresh(true)
    },
    setBasemapStyle(next) {
      if (style === next) return
      style = next
      refresh(true)
    },
    destroy() {
      if (viewer.isDestroyed()) return
      viewer.camera.changed.removeEventListener(listener)
      viewer.camera.moveEnd.removeEventListener(listener)
      if (viewer.scene.globe.material) {
        viewer.scene.globe.material = undefined
        viewer.scene.requestRender()
      }
    },
  }
}
