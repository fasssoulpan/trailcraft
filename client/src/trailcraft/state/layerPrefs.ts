/**
 * Contour-layer / distance-radar on-off toggles (P1 §3.6/§3.7, milestone N6
 * commits 2-3). Same "device UI preference, not project data" category as
 * `basemapPref.ts`/`mode.ts`/`layout.ts` -- persisted to localStorage as a
 * single small blob rather than per-mode: unlike the basemap style, there is
 * no meaningful "planning mode's contour preference" (contours are Cesium-
 * only, see `cesium/contours.ts`'s doc comment), and radar's on/off state is
 * one user intent ("show me a distance radar") that should carry across a
 * mode switch rather than being asked twice.
 *
 * Both default to off: these are opt-in overlays (extra GPU/CPU work and
 * extra visual clutter on top of the base scene), not something every
 * session should silently start with enabled.
 */

export interface LayerPrefs {
  contoursEnabled: boolean
  radarEnabled: boolean
}

const STORAGE_KEY = 'trailcraft:layers:v1'

export const DEFAULT_LAYER_PREFS: LayerPrefs = { contoursEnabled: false, radarEnabled: false }

export function loadLayerPrefs(): LayerPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_LAYER_PREFS }
    const parsed = JSON.parse(raw) as Partial<LayerPrefs>
    return {
      contoursEnabled: typeof parsed.contoursEnabled === 'boolean' ? parsed.contoursEnabled : DEFAULT_LAYER_PREFS.contoursEnabled,
      radarEnabled: typeof parsed.radarEnabled === 'boolean' ? parsed.radarEnabled : DEFAULT_LAYER_PREFS.radarEnabled,
    }
  } catch {
    return { ...DEFAULT_LAYER_PREFS }
  }
}

export function saveLayerPrefs(prefs: LayerPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Quota errors / privacy-mode / no localStorage at all: losing the
    // preference is harmless, defaults just apply again on next load.
  }
}
