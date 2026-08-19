/**
 * Basemap style ("3D 卫星图" / "二维平面图", P1 §3.5, milestone N6 commit 1)
 * is a UI preference, exactly like `mode.ts`'s 规划/巡游 mode and
 * `layout.ts`'s splitter sizes: it's "this device's last-used display
 * choice", not project data and not an undo-able edit. Persisted to
 * localStorage with every access wrapped in try/catch, same reasoning as
 * both of those modules (localStorage doesn't exist in the Node test
 * environment).
 *
 * Persisted **per mode** -- planning (MapLibre) and flythrough (Cesium)
 * remember their own choice independently (two separate storage keys, not
 * one shared value) -- per the milestone brief's explicit acceptance
 * criterion. A user who prefers the plain 2D OSM style while planning a
 * route but wants the satellite+terrain look while flying through it
 * shouldn't have one choice clobber the other.
 */

export type BasemapStyle = 'satellite' | 'plan'
export type BasemapScope = 'plan' | 'fly'

export const DEFAULT_BASEMAP_STYLE: BasemapStyle = 'satellite'

const STORAGE_KEYS: Record<BasemapScope, string> = {
  plan: 'trailcraft:basemap:plan:v1',
  fly: 'trailcraft:basemap:fly:v1',
}

function isBasemapStyle(v: unknown): v is BasemapStyle {
  return v === 'satellite' || v === 'plan'
}

/** Reads the persisted basemap style for `scope`, falling back to
 * `DEFAULT_BASEMAP_STYLE` whenever localStorage is unavailable, empty, or
 * holds anything other than exactly 'satellite'/'plan'. */
export function loadBasemapStyle(scope: BasemapScope): BasemapStyle {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[scope])
    return isBasemapStyle(raw) ? raw : DEFAULT_BASEMAP_STYLE
  } catch {
    return DEFAULT_BASEMAP_STYLE
  }
}

export function saveBasemapStyle(scope: BasemapScope, style: BasemapStyle): void {
  try {
    localStorage.setItem(STORAGE_KEYS[scope], style)
  } catch {
    // Quota errors / privacy-mode / no localStorage at all: losing the
    // preference is harmless, the default just applies again on next load.
  }
}
