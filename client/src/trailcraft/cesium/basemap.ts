/**
 * Cesium-side basemap style switching (P1 §3.5, milestone N6 commit 1).
 *
 * `viewer.ts` builds the real Cesium objects once at Viewer-construction
 * time (a "3D" terrain provider from the existing MapTiler/Esri/ellipsoid
 * fallback chain, a flat `EllipsoidTerrainProvider`, and two
 * `UrlTemplateImageryProvider`-backed `ImageryLayer`s -- satellite and
 * street) and keeps them alive for the Viewer's whole lifetime; switching
 * styles later never rebuilds the Viewer or re-fetches a provider, which is
 * this milestone's explicit acceptance criterion (switching must not lose
 * camera position or an in-progress flythrough).
 *
 * `terrainProviderForStyle` is the one piece of that decision simple and
 * pure enough to be worth factoring out and unit-testing on its own, same
 * split as `terrainSelection.ts`/`contourSpacing.ts`: everything else here
 * (applying the decision to a live `Viewer`/`ImageryLayer`) needs a real
 * Cesium/WebGL environment and lives in `viewer.ts` instead.
 */

import type { BasemapStyle } from '../state/basemapPref'

export interface BasemapTerrainProviders<T> {
  threeD: T
  flat: T
}

/** Which terrain provider a given basemap style should use. Generic over
 * the provider type so this can be unit-tested with plain placeholder
 * objects, with no real Cesium `TerrainProvider` in sight. */
export function terrainProviderForStyle<T>(style: BasemapStyle, providers: BasemapTerrainProviders<T>): T {
  return style === 'plan' ? providers.flat : providers.threeD
}

export type { BasemapStyle }
