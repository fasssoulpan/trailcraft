/**
 * Dark / light theme is a UI preference, exactly like `mode.ts`'s 规划/巡游
 * mode and `layout.ts`'s splitter sizes: it's "this device's last-used
 * display choice", not project data and not an undo-able edit. Persisted to
 * localStorage with every access wrapped in try/catch, same reasoning as
 * those modules (localStorage doesn't exist in the Node test environment).
 *
 * Dark is the default (see src/index.css's own header comment for why) --
 * `loadTheme()` only ever returns 'light' if the user (or a previous
 * session) explicitly chose it.
 */

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'trailcraft:theme:v1'

export const DEFAULT_THEME: Theme = 'dark'

/** Reads the persisted theme, falling back to 'dark' whenever localStorage
 * is unavailable, empty, or holds anything other than exactly
 * 'dark'/'light'. */
export function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'dark' || raw === 'light' ? raw : DEFAULT_THEME
  } catch {
    return DEFAULT_THEME
  }
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Quota errors / privacy-mode / no localStorage at all: losing the
    // preference is harmless, the default just applies again on next load.
  }
}

/** Stamps `data-theme` on the document root so index.css's
 * `:root[data-theme='light']` block (or the dark default) takes effect.
 * Wrapped in try/catch: called from main.tsx before the first render, and
 * this module is also imported by ThemeToggle.tsx, which tests could in
 * principle import in a DOM-less environment. */
export function applyTheme(theme: Theme): void {
  try {
    document.documentElement.setAttribute('data-theme', theme)
  } catch {
    // No `document` (non-browser test environment) -- nothing to apply.
  }
}
