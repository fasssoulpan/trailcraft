/**
 * Real terrain elevation sampling for a drawn/planned Track that has no
 * `ele` column at all (P2 toolbox addition, "补全高程" -- ToolboxPanel.tsx).
 *
 * This module is only ever reached via a dynamic `import()` from
 * `ui/ToolboxPanel.tsx`, same boundary every other Cesium-touching module in
 * this app uses (see `cesium/viewer.ts`'s own file comment) -- Cesium must
 * never enter the main bundle just because a drawn route *might* get its
 * elevation filled in.
 *
 * The actual "point → height" mapping back onto a Track (including the
 * partial-failure case) lives in `core/toolbox/elevation.ts`, kept free of
 * any Cesium import so it's unit-testable with a fake heights array. This
 * file's only job is producing that plain `(number | undefined)[]` from a
 * real terrain provider.
 *
 * `sampleTerrainMostDetailed(terrainProvider, positions, rejectOnTileFail?)`
 * signature verified against the installed cesium@1.144.0 typings
 * (`node_modules/cesium/Source/Cesium.d.ts`, the `sampleTerrainMostDetailed`
 * declaration) -- it takes a bare `TerrainProvider`, not a `Viewer`, so this
 * module never needs to construct one.
 */
import {
  ArcGISTiledElevationTerrainProvider,
  Cartographic,
  CesiumTerrainProvider,
  EllipsoidTerrainProvider,
  sampleTerrainMostDetailed,
} from './runtime'
import type { Cartographic as CesiumCartographic, TerrainProvider } from 'cesium'
import type { Track } from '../core/model/track'
import { ESRI_TERRAIN_URL, maptilerTerrainUrl, selectTerrain, type TerrainSource } from './terrainSelection'

export interface TerrainSampleOutcome {
  /** heights[i] corresponds to track.points.{lon,lat}[i]. `undefined` means
   * sampling failed or returned no data for that point -- see
   * `core/toolbox/elevation.ts` for why this must never be coerced to 0. */
  heights: (number | undefined)[]
  /** Which terrain source actually served the request -- surfaced so the UI
   * can disclose "~30m Esri DEM" per the P0 acceptance record's distinction
   * between DEM-derived planning elevation and a device's recorded
   * barometric elevation (docs/P0-验收记录.md §五). Absent when nothing
   * could be reached at all (`error` is set instead). */
  source?: TerrainSource
  /** Set when the request failed outright: no reachable terrain (network
   * down, both MapTiler and Esri failed) or the only fallback left was the
   * flat ellipsoid, which carries no real elevation data at all. Every entry
   * in `heights` is `undefined` in that case too -- this just adds a
   * human-readable reason for the UI to show. */
  error?: string
}

export interface SampleTrackElevationOptions {
  /** Overrides `import.meta.env.VITE_MAPTILER_API_KEY`, for tests -- mirrors `viewer.ts#CreateViewerOptions`. */
  mapTilerKey?: string
}

/**
 * Samples real terrain elevation for every point of `track`, via the same
 * MapTiler → Esri WorldElevation3D → flat-ellipsoid fallback chain
 * `createViewer` (viewer.ts) uses for 巡游模式's globe -- so "补全高程"
 * reports the same terrain source the flythrough camera would actually fly
 * over, not some independently-chosen provider.
 *
 * A batched, single round-trip per call (`sampleTerrainMostDetailed` itself
 * batches internally by tile) -- callers should show their own "in
 * progress" indication around this call, since a long drawn route can mean
 * a non-trivial number of tile requests.
 */
export async function sampleTrackElevation(
  track: Track,
  opts?: SampleTrackElevationOptions,
): Promise<TerrainSampleOutcome> {
  const mapTilerKey = opts?.mapTilerKey ?? import.meta.env.VITE_MAPTILER_API_KEY
  const hasMapTilerKey = !!mapTilerKey
  const n = track.points.lon.length

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

  // The ellipsoid fallback is a flat sphere with no real elevation data --
  // `selectTerrain` only ever falls all the way through to it when both
  // MapTiler (if configured) and the free Esri terrain failed, i.e. terrain
  // is genuinely unreachable right now. Sampling it would "succeed" and
  // return a height for every point, which is exactly the fabricated-data
  // trap this feature exists to avoid -- treat it as total failure instead.
  if (terrain.source === 'ellipsoid') {
    return {
      heights: new Array(n).fill(undefined),
      error: '地形服务当前不可达（已回退到无高程数据的平面地形），未获取到任何真实高程数据，轨迹保持不带高程',
    }
  }

  const { lon, lat } = track.points
  // Seeded to NaN, not left at Cartographic.fromDegrees' implicit 0 default:
  // sampleTerrainMostDetailed's own doSampling() silently skips a position
  // that falls outside the terrain provider's tiling scheme entirely
  // (verified by reading node_modules/cesium's own doSampling source) --
  // such a position's .height is never touched at all, so without this seed
  // it would read back as a fabricated 0m instead of "not sampled". Explicit
  // tile-request failures (rejectOnTileFail left at its default `false`) are
  // set to `undefined` by Cesium itself either way; both cases collapse to
  // the same "not finite -> undefined" check below.
  const cartographics = new Array<CesiumCartographic>(n)
  for (let i = 0; i < n; i++) cartographics[i] = Cartographic.fromDegrees(lon[i], lat[i], NaN)

  let sampled: CesiumCartographic[]
  try {
    sampled = await sampleTerrainMostDetailed(terrain.provider, cartographics)
  } catch (err) {
    return {
      heights: new Array(n).fill(undefined),
      source: terrain.source,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const heights = sampled.map((c) => (Number.isFinite(c.height) ? c.height : undefined))
  return { heights, source: terrain.source }
}
