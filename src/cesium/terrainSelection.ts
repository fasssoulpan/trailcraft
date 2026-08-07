/**
 * Pure terrain/imagery provider *selection* logic, deliberately factored out
 * of `viewer.ts` and kept free of any `cesium` import.
 *
 * Two reasons:
 *  - `createViewer` (viewer.ts) wires this decision to real network calls
 *    (`CesiumTerrainProvider.fromUrl`, `ArcGISTiledElevationTerrainProvider
 *    .fromUrl`) and a real Cesium `Viewer`/WebGL context. None of that is
 *    something a unit test should touch -- Cesium's package does DOM/WebGL
 *    feature probing that doesn't play well with Vitest's `node` test
 *    environment (see vite.config.ts's `test.environment`), and hitting a
 *    real terrain endpoint would make the suite flaky and slow.
 *  - The actual *decision* -- which of MapTiler / Esri / flat ellipsoid
 *    ends up in front of the user, given "key present", "key absent", and
 *    "the chosen provider's fetch throws" -- is exactly the kind of branchy
 *    logic that's easy to get wrong (see the P1 plan's requirement that a
 *    silent flat-terrain downgrade must be visible to the user, not just
 *    look like broken rendering) and cheap to test in isolation once it
 *    doesn't depend on any of the above.
 *
 * `selectTerrain` takes the network calls as injected callbacks so tests
 * can make any of them resolve or reject without a real Cesium type in
 * sight; `createViewer` supplies the real ones.
 */

export type TerrainSource = 'maptiler' | 'esri' | 'ellipsoid'
export type ImagerySource = 'maptiler' | 'esri'

export interface TerrainSelectionResult<T> {
  provider: T
  source: TerrainSource
}

export interface TerrainSelectionOptions<T> {
  /** Whether a MapTiler API key is configured. Absence is the normal case -- MapTiler is opt-in, never required. */
  hasMapTilerKey: boolean
  /** Attempts the MapTiler quantized-mesh terrain. Only called when `hasMapTilerKey` is true. */
  loadMapTiler: () => Promise<T>
  /** Attempts the free, no-registration Esri WorldElevation3D terrain. This is the default path. */
  loadEsri: () => Promise<T>
  /** Synchronous flat-terrain fallback. Must never throw -- EllipsoidTerrainProvider's constructor does no I/O. */
  createEllipsoid: () => T
}

/**
 * Terrain provider fallback chain, in priority order:
 *   1. MapTiler quantized-mesh -- only attempted if a key is configured;
 *      any failure (bad/expired key, network) falls through rather than
 *      surfacing an error, since Esri is a fully valid terrain on its own.
 *   2. Esri WorldElevation3D -- free, no registration, always attempted
 *      next (or first, if no MapTiler key).
 *   3. EllipsoidTerrainProvider -- flat fallback, the last resort that
 *      cannot itself fail.
 *
 * The caller (createViewer) is responsible for surfacing `source` to the
 * user: a silent downgrade to flat terrain must not look like broken
 * rendering.
 */
export async function selectTerrain<T>(opts: TerrainSelectionOptions<T>): Promise<TerrainSelectionResult<T>> {
  if (opts.hasMapTilerKey) {
    try {
      return { provider: await opts.loadMapTiler(), source: 'maptiler' }
    } catch {
      // fall through to Esri
    }
  }
  try {
    return { provider: await opts.loadEsri(), source: 'esri' }
  } catch {
    return { provider: opts.createEllipsoid(), source: 'ellipsoid' }
  }
}

export interface ImagerySelectionResult {
  url: string
  credit: string
  source: ImagerySource
}

// Esri's tile URL template order is {z}/{y}/{x} -- NOT the usual {z}/{x}/{y}
// that most XYZ tile schemes (including this app's own OSM basemap in
// map/MapView.tsx) use. Getting this wrong silently renders scrambled
// imagery rather than failing loudly, so it's worth this explicit callout.
const ESRI_IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const ESRI_IMAGERY_CREDIT = 'Esri, Maxar, Earthstar Geographics'
const ESRI_TERRAIN_URL = 'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer'

export function maptilerTerrainUrl(key: string): string {
  return `https://api.maptiler.com/tiles/terrain-quantized-mesh-v2/?key=${key}`
}

export function maptilerImageryUrl(key: string): string {
  return `https://api.maptiler.com/maps/satellite/{z}/{x}/{y}.jpg?key=${key}`
}

/**
 * Imagery has no network-validated fallback step the way terrain does:
 * `UrlTemplateImageryProvider` never fails at construction time -- bad
 * tiles surface later, per-tile, at render time (the existing MapView/OSM
 * basemap already has to handle that same failure mode). So this is a
 * plain synchronous decision, not an async attempt chain: MapTiler satellite
 * if a key is configured, else Esri World Imagery (free, no key).
 */
export function selectImagery(mapTilerKey: string | undefined): ImagerySelectionResult {
  if (mapTilerKey) {
    return { url: maptilerImageryUrl(mapTilerKey), credit: 'MapTiler', source: 'maptiler' }
  }
  return { url: ESRI_IMAGERY_URL, credit: ESRI_IMAGERY_CREDIT, source: 'esri' }
}

export { ESRI_IMAGERY_URL, ESRI_IMAGERY_CREDIT, ESRI_TERRAIN_URL }
