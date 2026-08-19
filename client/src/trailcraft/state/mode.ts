/**
 * 规划模式 / 巡游模式(2D planning vs. 3D flythrough) is a UI setting, exactly
 * like the splitter sizes in layout.ts: it's "this device's last-used mode",
 * not project data and not an undo-able edit. Reopening the app should land
 * back in whichever mode the user was last in, so it's persisted the same
 * way -- localStorage, with every access wrapped in try/catch because
 * localStorage doesn't exist in the Node test environment (see
 * vite.config.ts's `test.environment` and layout.ts's own comment on the
 * same constraint).
 */

export type Mode = 'plan' | 'fly'

const STORAGE_KEY = 'trailcraft:mode:v1'

export const DEFAULT_MODE: Mode = 'plan'

/** Reads the persisted mode, falling back to 'plan' whenever localStorage is
 * unavailable, empty, or holds anything other than exactly 'plan'/'fly'. */
export function loadMode(): Mode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'plan' || raw === 'fly' ? raw : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

export function saveMode(mode: Mode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    // Quota errors / privacy-mode / no localStorage at all: losing the
    // preference is harmless, the default just applies again on next load.
  }
}
