/**
 * Pure MapLibre style-spec *selection* for the planning-mode basemap (P1
 * §3.5, milestone N6 commit 2) -- kept free of MapView.tsx's own
 * `import 'maplibre-gl/dist/maplibre-gl.css'` side-effect import (only a
 * type-only `StyleSpecification` import from `maplibre-gl` itself), so this
 * can be unit-tested in the Node test environment (see vite.config.ts's
 * `test.environment`) the same way `cesium/terrainSelection.ts`/
 * `cesium/contourSpacing.ts` are kept free of any real `cesium` import for
 * their own tests.
 *
 * `OSM_STYLE` itself stays the canonical export MapView.tsx already had
 * (re-exported from there too, for anything that still imports it from that
 * path) -- this file only adds the new Esri satellite style alongside it and
 * the pure "which style for which BasemapStyle" decision.
 *
 * `ESRI_IMAGERY_URL`/`ESRI_IMAGERY_CREDIT` are re-exported from
 * `cesium/terrainSelection.ts` rather than retyped here, per the milestone
 * brief: the Esri tile URL template order is `{z}/{y}/{x}`, not the usual
 * `{z}/{x}/{y}`, and that file already carries the explicit callout. Whether
 * that plugs directly into MapLibre needs its own check, though -- MapLibre's
 * raster source `{y}` placeholder must mean the same tile row Esri expects.
 * It does: MapLibre's raster source defaults to `scheme: 'xyz'`, the standard
 * "slippy map" addressing where y=0 is the northernmost row and y increases
 * southward. Cesium's `UrlTemplateImageryProvider` (used with this exact
 * template in `cesium/viewer.ts`, already verified working) defaults to the
 * same non-flipped addressing via its default `WebMercatorTilingScheme`. Both
 * consumers therefore agree on what `{y}` means, so the identical template
 * plugs into MapLibre's `tiles` array with no re-flipping (e.g. no
 * `scheme: 'tms'`) needed.
 */
import type { StyleSpecification } from 'maplibre-gl'
import { ESRI_IMAGERY_URL, ESRI_IMAGERY_CREDIT } from '../cesium/terrainSelection'
import type { BasemapStyle } from '../state/basemapPref'

export const OSM_SOURCE_ID = 'osm'
export const ESRI_SATELLITE_SOURCE_ID = 'esri-satellite'

/** OSM's required attribution string -- pulled out to a named export so
 * `core/export/webPage.ts` (P3-R4, the self-contained interactive page
 * export, which raster-tiles the same OSM server directly from a small
 * inline script rather than through MapLibre) can credit the exact same
 * text instead of re-typing a string that could silently drift from this
 * one. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors'

export const OSM_TILE_URL_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

/**
 * Raster OSM basemap style. OpenStreetMap's own tile CDN
 * (tile.openstreetmap.org) is slow/unreliable to reach from mainland China,
 * which is TrailCraft's target market, so this is expected to become a
 * user- or env-configurable URL in a later task rather than staying
 * hardcoded.
 */
export const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    [OSM_SOURCE_ID]: {
      type: 'raster',
      tiles: [OSM_TILE_URL_TEMPLATE],
      tileSize: 256,
      attribution: OSM_ATTRIBUTION,
    },
  },
  layers: [{ id: OSM_SOURCE_ID, type: 'raster', source: OSM_SOURCE_ID }],
}

/**
 * Esri World Imagery raster basemap style -- the planning-mode counterpart
 * to `cesium/viewer.ts`'s satellite imagery layer, free/keyless like that
 * one. `attribution` here is what actually surfaces the required credit:
 * MapLibre's `Map` constructs a default `AttributionControl` unless
 * `attributionControl: false` is passed (MapView.tsx never passes that), and
 * that control reads every active source's own `attribution` string.
 */
export const ESRI_SATELLITE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    [ESRI_SATELLITE_SOURCE_ID]: {
      type: 'raster',
      tiles: [ESRI_IMAGERY_URL],
      tileSize: 256,
      attribution: ESRI_IMAGERY_CREDIT,
    },
  },
  layers: [{ id: ESRI_SATELLITE_SOURCE_ID, type: 'raster', source: ESRI_SATELLITE_SOURCE_ID }],
}

/** Every raster basemap source id this app ever registers -- MapView.tsx's
 * tile-error listener checks membership against this rather than a single
 * hardcoded id, now that there are two basemap styles to watch. */
export const ALL_RASTER_SOURCE_IDS: readonly string[] = [OSM_SOURCE_ID, ESRI_SATELLITE_SOURCE_ID]

export function styleSpecForBasemap(style: BasemapStyle): StyleSpecification {
  return style === 'satellite' ? ESRI_SATELLITE_STYLE : OSM_STYLE
}
