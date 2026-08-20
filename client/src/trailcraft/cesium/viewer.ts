/**
 * Cesium `Viewer` creation for TrailCraft's 3D flythrough mode (P1 §3.1).
 *
 * This module is only ever reached via a dynamic `import()` from
 * `src/ui/FlyView.tsx` once the user switches into 巡游模式 -- see that
 * file for the lazy-loading boundary. Nothing in here is imported
 * statically from anywhere else in the app, so `cesium` (several MB) never
 * enters the main bundle (verified in the N1 commit-1 chore).
 *
 * The terrain/imagery provider *selection decision* itself lives in
 * `terrainSelection.ts`, kept free of any `cesium` import so it can be unit
 * tested without a real network or a real Cesium Viewer -- this file just
 * wires that decision to the real Cesium provider classes and a real
 * WebGL-backed Viewer.
 */
import {
  ArcGisMapServerImageryProvider,
  ArcGISTiledElevationTerrainProvider,
  Cartesian3,
  CesiumTerrainProvider,
  EllipsoidTerrainProvider,
  GridImageryProvider,
  ImageryLayer,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  Viewer,
} from './runtime'
import type { TerrainProvider, Viewer as CesiumViewer } from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import {
  ESRI_STREET_CREDIT,
  ESRI_STREET_URL,
  ESRI_STREET_SERVICE_URL,
  ESRI_TERRAIN_URL,
  maptilerTerrainUrl,
  selectImagery,
  selectTerrain,
  type ImagerySource,
  type TerrainSource,
  ESRI_IMAGERY_SERVICE_URL,
} from './terrainSelection'
import { terrainProviderForStyle } from './basemap'
import { DEFAULT_BASEMAP_STYLE, type BasemapStyle } from '../state/basemapPref'

// Cesium resolves its own worker/asset URLs relative to this global at
// runtime (see buildModuleUrl.js in the Cesium source) -- vite.config.ts's
// `define` sets the *build-time* constant `CESIUM_BASE_URL`; this line is
// what actually publishes it to the one place Cesium looks for it. Must run
// before any Cesium code that touches a worker/asset path (terrain/imagery
// construction below), so it's set at module top-level, not inside
// `createViewer`.
declare global {
  interface Window {
    CESIUM_BASE_URL?: string
  }
}
window.CESIUM_BASE_URL = CESIUM_BASE_URL

// Roughly the center of China, matching MapView.tsx's 2D default camera
// (src/map/MapView.tsx's DEFAULT_CENTER) so switching modes doesn't jump
// the view before any track has been loaded.
const DEFAULT_CENTER = { lon: 104.0, lat: 35.0, height: 8_000_000 }

/**
 * Which terrain/imagery source actually ended up in use. Surfaced to the
 * UI (commit 3's corner badge) so a silent downgrade to flat terrain reads
 * as "no free 3D terrain reachable right now" rather than looking like
 * broken rendering.
 */
export interface ProviderReport {
  terrain: TerrainSource
  imagery: ImagerySource
}

export interface CreateViewerOptions {
  /** Overrides `import.meta.env.VITE_MAPTILER_API_KEY`, for tests. */
  mapTilerKey?: string
}

/**
 * Cesium-side basemap-style switching surface (P1 §3.5, milestone N6
 * commit 1), handed back from `createViewer` so `FlyView.tsx` never has to
 * reach into Cesium internals itself. Both terrain providers and both
 * imagery layers are constructed once, up front, in `createViewer` --
 * `setStyle` only ever flips `viewer.terrainProvider`/`ImageryLayer#show`,
 * never rebuilds anything, which is what lets switching preserve camera
 * position and an in-progress flythrough (this milestone's explicit
 * acceptance criterion).
 */
export interface CesiumBasemapHandle {
  /**
   * Applies `style`: swaps which of the two pre-built imagery layers is
   * visible and, if the terrain provider actually needs to change,
   * reassigns `viewer.terrainProvider` (which triggers a real terrain
   * re-request) and reports the resulting brief loading window via
   * `onLoadingChange`. A no-op re-application of the already-active style
   * does NOT touch `terrainProvider` at all, so it never flashes the
   * loading indicator for nothing.
   */
  setStyle: (style: BasemapStyle, onLoadingChange?: (loading: boolean) => void) => void
  /** The attribution line for whichever imagery `style` would show --
   * Esri (either layer) and MapTiler both require visible attribution;
   * `viewer.ts`'s own Cesium credit container is deliberately detached
   * (see `creditContainer` below), so the UI renders this text itself. */
  creditFor: (style: BasemapStyle) => string
}

export interface CesiumViewerHandle {
  viewer: CesiumViewer
  providers: ProviderReport
  basemap: CesiumBasemapHandle
  /**
   * Fully disposes the Viewer (WebGL context, event listeners, DOM).
   * Idempotent -- safe to call twice, which React 18 StrictMode's
   * double-invoked effects make a real possibility (see MapView.tsx's own
   * mount/unmount effect for the established pattern this mirrors).
   */
  destroy: () => void
}

// How long to wait for the globe's terrain tile queue to drain after a
// terrainProvider swap before giving up on the "brief loading indication"
// the milestone brief calls for and clearing it unconditionally -- a safety
// net in case `tileLoadProgressEvent` never reports back to 0 (e.g. the new
// provider is unreachable), so the UI can't get stuck showing "reloading
// terrain…" forever.
const TERRAIN_SETTLE_TIMEOUT_MS = 4_000

/**
 * Waits for the globe's terrain tile-load queue to drain (or the timeout
 * above, whichever comes first) and calls `onSettled` exactly once.
 * Replacing `terrainProvider` at runtime -- what `setStyle` above does --
 * discards every previously-loaded terrain tile and triggers a full
 * re-request; this is what lets the caller show a transient loading
 * indication instead of leaving the scene looking frozen/broken while that
 * happens, per the milestone brief's explicit callout.
 */
function waitForTerrainSettle(viewer: CesiumViewer, onSettled: () => void): void {
  let settled = false
  const finish = () => {
    if (settled) return
    settled = true
    viewer.scene.globe.tileLoadProgressEvent.removeEventListener(listener)
    clearTimeout(timeoutId)
    onSettled()
  }
  const listener = (pendingTiles: number) => {
    if (pendingTiles === 0) finish()
  }
  viewer.scene.globe.tileLoadProgressEvent.addEventListener(listener)
  const timeoutId = setTimeout(finish, TERRAIN_SETTLE_TIMEOUT_MS)
}

/**
 * Temporarily filters `console.warn`/`console.error` calls that mention
 * Cesium ion (matched as a whole word, so it doesn't also swallow unrelated
 * messages like "version" or "collision" that merely contain the substring
 * "ion") while `fn` runs.
 *
 * TrailCraft never sets `Ion.defaultAccessToken` and never requests an
 * Ion-hosted asset -- `baseLayer` is explicitly disabled below and terrain
 * always comes from `selectTerrain`'s Esri/MapTiler/ellipsoid chain, never
 * `createWorldTerrain()` -- so under normal operation this should have
 * nothing to filter. It exists purely as a defensive net against Cesium's
 * own internal default-credential check during Viewer construction, per
 * the brief: no ion token is ever added to silence it.
 */
async function withSuppressedIonWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const ionWord = /\bion\b/i
  const original = { warn: console.warn, error: console.error }
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && ionWord.test(args[0])) return
    original.warn(...args)
  }
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && ionWord.test(args[0])) return
    original.error(...args)
  }
  try {
    return await fn()
  } finally {
    console.warn = original.warn
    console.error = original.error
  }
}

/**
 * Creates a Cesium Viewer in `container`, running the terrain/imagery
 * fallback chain described in terrainSelection.ts. Resolves once the
 * Viewer itself exists and both providers are attached -- callers do not
 * need to wait for any further Cesium "ready" event.
 */
export async function createViewer(container: HTMLElement, opts?: CreateViewerOptions): Promise<CesiumViewerHandle> {
  const mapTilerKey = opts?.mapTilerKey ?? import.meta.env.VITE_MAPTILER_API_KEY
  const hasMapTilerKey = !!mapTilerKey

  // Cesium now starts without its decorative skybox textures, so the existing
  // MapTiler → Esri → flat fallback chain can be used again for actual terrain
  // without a static-image failure taking down the whole flythrough.
  const terrain = await selectTerrain<TerrainProvider>({
    hasMapTilerKey,
    loadMapTiler: () => CesiumTerrainProvider.fromUrl(maptilerTerrainUrl(mapTilerKey!), { requestWaterMask: false, requestVertexNormals: false }),
    loadEsri: () => ArcGISTiledElevationTerrainProvider.fromUrl(ESRI_TERRAIN_URL),
    createEllipsoid: () => new EllipsoidTerrainProvider(),
  })

  const imagery = selectImagery(hasMapTilerKey ? mapTilerKey : undefined)

  const viewer = await withSuppressedIonWarnings(() =>
    Promise.resolve(
      new Viewer(container, {
        // Widgets that don't fit this app -- TrailCraft drives the camera
        // and track playback itself (later N1-N5 milestones), not through
        // Cesium's stock chrome.
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        selectionIndicator: false,
        navigationHelpButton: false,
        infoBox: false,
        // A detached element rather than `false`/omitted: Cesium always
        // wants somewhere to put its credit list, and giving it one that's
        // never attached to the document keeps that DOM out of the app's
        // own layout without touching Ion at all.
        creditContainer: document.createElement('div'),

        // No default Ion imagery layer (Viewer's built-in default is
        // `ImageryLayer.fromWorldImagery()`, which is Ion-hosted) -- the
        // real layer is added explicitly below from `selectImagery`'s
        // decision.
        baseLayer: false,
        terrainProvider: terrain.provider,

        // Terrain and imagery arrive asynchronously. Keep the 3D workspace
        // rendering while it is mounted so a completed remote tile request
        // cannot be stranded behind an idle request-render frame.
        requestRenderMode: false,
        scene3DOnly: true,
        // The default skybox loads six static JPEG textures from Cesium's
        // asset tree. Keep this data-focused route viewer free of decorative
        // sky textures so a failed static asset can never stop the scene.
        skyBox: false,
        skyAtmosphere: false,
        shadows: false,
      }),
    ),
  )

  // Declared here (rather than down by `destroy` below, where it would
  // otherwise naturally sit) so `basemap.setStyle`'s self-guard can close
  // over it -- `basemap.setStyle(DEFAULT_BASEMAP_STYLE)` a few lines down
  // runs synchronously during this same construction, before the `destroy`
  // closure below would normally have introduced this binding.
  let destroyed = false

  // With the default skybox disabled (it was the non-decodable static image
  // path in this deployment), the existing service-backed imagery can be
  // attached directly without blocking Viewer creation.
  viewer.imageryLayers.addImageryProvider(new GridImageryProvider({ cells: 16 }))
  const satelliteImageryLayer = viewer.imageryLayers.addImageryProvider(
    new UrlTemplateImageryProvider({ url: imagery.url, credit: imagery.credit, minimumLevel: 0, maximumLevel: 20 }),
  )
  const planImageryLayer = viewer.imageryLayers.addImageryProvider(
    new UrlTemplateImageryProvider({ url: ESRI_STREET_URL, credit: ESRI_STREET_CREDIT, minimumLevel: 0, maximumLevel: 19 }),
  )
  planImageryLayer.show = false
  let activeStyle: BasemapStyle = DEFAULT_BASEMAP_STYLE

  // Flat fallback for "二维平面图": a second, independent
  // EllipsoidTerrainProvider instance (never shared with the ellipsoid
  // `selectTerrain` may itself have already fallen back to for the "3D"
  // style -- see this constant's own doc comment on `CesiumBasemapHandle`)
  // so the two styles are always genuinely distinct providers to assign,
  // even in that degraded case.
  const flatTerrainProvider = new EllipsoidTerrainProvider()
  const basemapCredit: Record<BasemapStyle, string> = {
    satellite: imagery.credit,
    plan: ESRI_STREET_CREDIT,
  }

  const basemap: CesiumBasemapHandle = {
    setStyle: (style, onLoadingChange) => {
      if (destroyed) return
      activeStyle = style
      satelliteImageryLayer.show = style === 'satellite'
      planImageryLayer.show = style === 'plan'
      const nextTerrain = terrainProviderForStyle(style, { threeD: terrain.provider, flat: flatTerrainProvider })
      if (viewer.terrainProvider !== nextTerrain) {
        viewer.terrainProvider = nextTerrain
        onLoadingChange?.(true)
        waitForTerrainSettle(viewer, () => onLoadingChange?.(false))
      }
      viewer.scene.requestRender()
    },
    creditFor: (style) => basemapCredit[style],
  }
  // Applies the default style's imagery visibility (satellite layer already
  // shown, plan layer already hidden above) without touching
  // terrainProvider a second time or flashing the loading indicator --
  // callers apply their own persisted starting style right after
  // `createViewer` resolves (see FlyView.tsx), this call just guarantees
  // `basemap`'s internal bookkeeping matches the Viewer's actual initial
  // state even if a caller never calls `setStyle` at all.
  basemap.setStyle(DEFAULT_BASEMAP_STYLE)

  // Mount service-backed imagery after the Viewer is usable. Any failure or
  // long metadata wait leaves the grid visible rather than trapping FlyView
  // in its loading state; switching modes, track preview and camera controls
  // all remain available during that downgrade.

  const cameraController = viewer.scene.screenSpaceCameraController
  cameraController.enableCollisionDetection = false
  cameraController.enableRotate = true
  cameraController.enableZoom = true
  // The reference implementation (cyber-trail-hud) sets `enablePan` here,
  // but Cesium's actual ScreenSpaceCameraController property for
  // right-drag/middle-drag panning is `enableTranslate` -- `enablePan`
  // doesn't exist on the type at all (caught by `tsc -b`, since the
  // reference is plain JS and never had this checked).
  cameraController.enableTranslate = true
  cameraController.enableTilt = true
  // Matches the reference implementation: double-click's default "fly to
  // and track this entity" behaviour doesn't fit a flythrough app where
  // entities are trail points, not points of interest to lock onto.
  viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)

  viewer.camera.setView({
    destination: Cartesian3.fromDegrees(DEFAULT_CENTER.lon, DEFAULT_CENTER.lat, DEFAULT_CENTER.height),
  })

  // `destroyed` itself is declared further up, next to the imagery layers,
  // so `basemap.setStyle`'s self-guard can close over it.
  const destroy = () => {
    if (destroyed) return
    destroyed = true
    if (!viewer.isDestroyed()) viewer.destroy()
  }

  return {
    viewer,
    providers: { terrain: terrain.source, imagery: imagery.source },
    basemap,
    destroy,
  }
}
