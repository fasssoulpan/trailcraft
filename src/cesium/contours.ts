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
 *
 * ---- Elevation labels ----
 * The material above is a fragment shader; it tints pixels near a multiple
 * of the spacing and produces no geometry, so there is nothing on it to
 * attach a number to. The labels are therefore found independently: sample a
 * grid of terrain heights over the current view, hand it to
 * `contourLabels.ts` (pure, tested) to locate where the surface crosses each
 * level, and draw those as a `LabelCollection`.
 *
 * The grid comes from `Globe#getHeight`, which is a synchronous lookup
 * against already-resident terrain tiles -- no network round trip, same call
 * `heightAboveGroundM` below already makes. Unresolved samples come back
 * `undefined` and are carried through as NaN rather than as 0, which would
 * invent a sea-level contour across any tile that had not loaded yet.
 *
 * Labels hang off `camera.changed`, the same signal as the material, and are
 * rate-limited rather than tied to `moveEnd`. `moveEnd` alone looked like the
 * cheaper hook, but Cesium only fires it for user-driven camera motion and
 * for `flyTo`-style animations -- the flythrough engine drives the camera
 * with `camera.setView()` every tick (`flythrough.ts`), which fires
 * `changed` but never `moveEnd`. Labels bound to `moveEnd` would therefore
 * have frozen at whatever was on screen before playback started and stayed
 * wrong for the entire flight, which is precisely when they matter.
 *
 * The rate limit is what keeps that affordable: unlike the material, labels
 * depend on the view *rectangle*, so they cannot be skipped just because the
 * spacing band is unchanged, and re-sampling a grid on every 5%-of-scene step
 * would be the per-frame rebuild the milestone brief warns against.
 */
import {
  Cartesian3,
  Cartographic,
  Color,
  LabelCollection,
  LabelStyle,
  Material,
  VerticalOrigin,
  type Viewer,
} from 'cesium'
import { contourLabelPlacements, type ContourHeightGrid } from './contourLabels'
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
  const carto = viewer.camera.positionCartographic
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
 * Terrain samples per axis for the label grid. 40x40 = 1,600 synchronous
 * `getHeight` lookups, rate-limited as described above. Raising this finds shorter
 * contour fragments but costs quadratically; it is well past the point where
 * the thinning in `contourLabels.ts` is what actually limits how many labels
 * survive, so a denser grid mostly buys nothing visible.
 */
const LABEL_GRID_STEPS = 40

/** Metres above the surface, so a label is not z-fought into the terrain. */
const LABEL_HEIGHT_OFFSET_M = 4

/**
 * Floor on how often the label grid may be re-sampled. At roughly three
 * rebuilds a second the numbers stay current through a flythrough without
 * the 1,600-lookup sweep landing on consecutive frames.
 */
const LABEL_REFRESH_MIN_INTERVAL_MS = 320

const DEG = 180 / Math.PI

/**
 * Samples terrain heights across the current view. Returns undefined when
 * the camera is not looking at the globe at all, or when the view wraps the
 * antimeridian -- `computeViewRectangle` reports that as `east < west`, and
 * the label grid's plain linear interpolation between west and east would
 * silently place every label on the wrong side of the planet. A trail route
 * spanning 180 degrees of longitude is not a case worth the extra branch, so
 * labels simply stand down there.
 */
function sampleHeightGrid(viewer: Viewer): ContourHeightGrid | undefined {
  const rect = viewer.camera.computeViewRectangle()
  if (!rect || rect.east <= rect.west || rect.north <= rect.south) return undefined

  const heights = new Float64Array(LABEL_GRID_STEPS * LABEL_GRID_STEPS)
  const lonStep = (rect.east - rect.west) / (LABEL_GRID_STEPS - 1)
  const latStep = (rect.north - rect.south) / (LABEL_GRID_STEPS - 1)
  const scratch = new Cartographic()

  for (let r = 0; r < LABEL_GRID_STEPS; r++) {
    scratch.latitude = rect.south + r * latStep
    for (let c = 0; c < LABEL_GRID_STEPS; c++) {
      scratch.longitude = rect.west + c * lonStep
      const h = viewer.scene.globe.getHeight(scratch)
      // NaN, not 0: an unloaded tile has no height, and zero would draw a
      // spurious sea-level contour straight through the middle of a range.
      heights[r * LABEL_GRID_STEPS + c] = h === undefined ? Number.NaN : h
    }
  }

  return {
    heights,
    rows: LABEL_GRID_STEPS,
    cols: LABEL_GRID_STEPS,
    west: rect.west * DEG,
    south: rect.south * DEG,
    east: rect.east * DEG,
    north: rect.north * DEG,
  }
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
  // Created lazily: a viewer that never turns contours on should not carry a
  // primitive at all, and FlyView attaches this handle on every viewer.
  let labels: LabelCollection | undefined

  function clearLabels(): void {
    if (!labels) return
    labels.removeAll()
    viewer.scene.requestRender()
  }

  /**
   * Re-derives the elevation labels for the current view. Always called
   * after `refresh` so `appliedSpacing` is the spacing the material is
   * actually drawing -- the numbers have to name the lines that are on
   * screen, not the ones a different zoom band would have drawn.
   */
  let lastLabelBuildMs = Number.NEGATIVE_INFINITY

  function refreshLabels(force: boolean): void {
    if (viewer.isDestroyed()) return
    if (!enabled || appliedSpacing === undefined) {
      clearLabels()
      return
    }

    // `force` is for state changes the user just made (toggling the layer,
    // switching basemap): those must land immediately, throttle or not.
    const now = performance.now()
    if (!force && now - lastLabelBuildMs < LABEL_REFRESH_MIN_INTERVAL_MS) return
    lastLabelBuildMs = now

    const grid = sampleHeightGrid(viewer)
    if (!grid) {
      clearLabels()
      return
    }

    const placements = contourLabelPlacements(grid, appliedSpacing)
    // Held in a local so TypeScript can narrow it: `labels` is a closure
    // variable, so it widens back to `| undefined` across the calls below.
    const collection = (labels ??= viewer.scene.primitives.add(new LabelCollection()))
    collection.removeAll()

    const preset = contourPresetForStyle(style)
    const fill = Color.fromCssColorString(preset.colorCss)
    // The contour colour is tuned to sit on imagery as a hairline; as text it
    // needs a hard outline behind it or it disappears over anything busy.
    // Satellite contours are near-white, so they get a dark halo; the plan
    // preset is a dark brown over a light basemap and gets a light one.
    const outline = style === 'satellite' ? Color.BLACK.withAlpha(0.85) : Color.WHITE.withAlpha(0.9)

    for (const p of placements) {
      collection.add({
        position: Cartesian3.fromDegrees(p.lon, p.lat, p.elevationM + LABEL_HEIGHT_OFFSET_M),
        // Bare number, no unit: the convention on every printed topographic
        // map, and repeating "m" 30 times is noise at this density.
        text: String(Math.round(p.elevationM)),
        font: p.index ? 'bold 13px sans-serif' : '11px sans-serif',
        fillColor: fill,
        outlineColor: outline,
        outlineWidth: 2,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.CENTER,
        // `disableDepthTestDistance` is left at its default of 0, i.e. depth
        // testing stays on, so a label behind a ridge is hidden by the ridge
        // instead of floating over it. That occlusion is what makes the
        // numbers read as lying on the terrain rather than on the screen.
      })
    }

    viewer.scene.requestRender()
  }

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

  const listener = () => {
    refresh(false)
    refreshLabels(false)
  }
  viewer.camera.changed.addEventListener(listener)
  viewer.camera.moveEnd.addEventListener(listener)
  viewer.camera.percentageChanged = Math.min(viewer.camera.percentageChanged, CONTOUR_CAMERA_PERCENTAGE_CHANGED)

  return {
    setEnabled(next) {
      if (enabled === next) return
      enabled = next
      refresh(true)
      refreshLabels(true)
    },
    setBasemapStyle(next) {
      if (style === next) return
      style = next
      refresh(true)
      // Not just a recolour: the outline colour flips with the preset, so the
      // existing labels would be light-on-light after a switch to plan view.
      refreshLabels(true)
    },
    destroy() {
      if (viewer.isDestroyed()) return
      viewer.camera.changed.removeEventListener(listener)
      viewer.camera.moveEnd.removeEventListener(listener)
      if (labels) {
        // `remove` destroys the primitive; dropping the reference without it
        // would leak the collection's GPU resources for the viewer's life.
        viewer.scene.primitives.remove(labels)
        labels = undefined
      }
      if (viewer.scene.globe.material) {
        viewer.scene.globe.material = undefined
        viewer.scene.requestRender()
      }
    },
  }
}
