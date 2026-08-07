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
  ArcGISTiledElevationTerrainProvider,
  Cartesian3,
  CesiumTerrainProvider,
  EllipsoidTerrainProvider,
  ScreenSpaceEventType,
  UrlTemplateImageryProvider,
  Viewer,
  type TerrainProvider,
} from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import {
  ESRI_TERRAIN_URL,
  maptilerTerrainUrl,
  selectImagery,
  selectTerrain,
  type ImagerySource,
  type TerrainSource,
} from './terrainSelection'

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

export interface CesiumViewerHandle {
  viewer: Viewer
  providers: ProviderReport
  /**
   * Fully disposes the Viewer (WebGL context, event listeners, DOM).
   * Idempotent -- safe to call twice, which React 18 StrictMode's
   * double-invoked effects make a real possibility (see MapView.tsx's own
   * mount/unmount effect for the established pattern this mirrors).
   */
  destroy: () => void
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

  const terrain = await selectTerrain<TerrainProvider>({
    hasMapTilerKey,
    loadMapTiler: () =>
      CesiumTerrainProvider.fromUrl(maptilerTerrainUrl(mapTilerKey!), {
        requestWaterMask: false,
        requestVertexNormals: false,
      }),
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

        requestRenderMode: true,
        scene3DOnly: true,
        shadows: false,
      }),
    ),
  )

  viewer.imageryLayers.addImageryProvider(
    new UrlTemplateImageryProvider({
      url: imagery.url,
      credit: imagery.credit,
      minimumLevel: 0,
      maximumLevel: 20,
    }),
  )

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

  let destroyed = false
  const destroy = () => {
    if (destroyed) return
    destroyed = true
    if (!viewer.isDestroyed()) viewer.destroy()
  }

  return {
    viewer,
    providers: { terrain: terrain.source, imagery: imagery.source },
    destroy,
  }
}
