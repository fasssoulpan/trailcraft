import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  clamp,
  loadLayoutSizes,
  saveLayoutSizes,
  DEFAULT_LAYOUT_SIZES,
  SIDEBAR_COLLAPSED_WIDTH,
  type LayoutSizes,
} from '../../src/state/layout'

describe('clamp', () => {
  it('passes values already inside the range through unchanged', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })
  it('floors to min', () => {
    expect(clamp(-5, 0, 10)).toBe(0)
  })
  it('ceils to max', () => {
    expect(clamp(15, 0, 10)).toBe(10)
  })
  it('stays sane when max < min (degenerate container) by preferring min', () => {
    expect(clamp(5, 20, 10)).toBe(20)
  })
})

// vite.config.ts runs tests with `environment: 'node'` (see e.g.
// tests/core/projectToolbarImport.test.ts's comment on the same
// constraint) -- there is no `localStorage` global here, same situation
// state/persist.ts is in for IndexedDB. loadLayoutSizes/saveLayoutSizes
// must not throw in that environment; they should just fall back to
// defaults / silently no-op, exactly like persist.ts does for IndexedDB
// failures.
describe('layout size persistence (no localStorage in this environment)', () => {
  it('loadLayoutSizes falls back to defaults without throwing', () => {
    expect(loadLayoutSizes()).toEqual(DEFAULT_LAYOUT_SIZES)
  })

  it('saveLayoutSizes does not throw', () => {
    expect(() =>
      saveLayoutSizes({ sidebarWidth: 400, profileHeight: 300, sidebarCollapsed: false, profileCollapsed: false }),
    ).not.toThrow()
  })

  it('DEFAULT_LAYOUT_SIZES starts both panes expanded', () => {
    expect(DEFAULT_LAYOUT_SIZES.sidebarCollapsed).toBe(false)
    expect(DEFAULT_LAYOUT_SIZES.profileCollapsed).toBe(false)
  })
})

// The suite above deliberately runs with no localStorage global at all,
// matching the real Node test environment every persistence module in this
// app (layout.ts/mode.ts/basemapPref.ts/layerPrefs.ts) has to tolerate --
// see that describe block's own comment. That's enough to prove
// load/saveLayoutSizes don't throw, but it can only ever exercise the
// catch-all fallback branch, never the actual tolerant-parsing logic inside
// the try. This block stubs a minimal in-memory localStorage (scoped to
// just these tests via beforeEach/afterEach, so every other test file keeps
// running with no localStorage present) to verify that parsing logic
// itself -- in particular, that a value written by a pre-collapse build of
// the app (no sidebarCollapsed/profileCollapsed keys at all) still loads,
// with both flags defaulting to false exactly like an unparsable value
// would.
describe('loadLayoutSizes tolerant parsing (stubbed localStorage)', () => {
  const STORAGE_KEY = 'trailcraft:layout:v1' // mirrors layout.ts's private STORAGE_KEY
  let store: Record<string, string>

  beforeEach(() => {
    store = {}
    ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (key: string) => (key in store ? store[key] : null),
      setItem: (key: string, value: string) => {
        store[key] = value
      },
      removeItem: (key: string) => {
        delete store[key]
      },
      clear: () => {
        store = {}
      },
      key: () => null,
      length: 0,
    } as Storage
  })

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage
  })

  it('loads a pre-collapse stored value (no sidebarCollapsed/profileCollapsed keys), defaulting both to false', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sidebarWidth: 400, profileHeight: 300 }))
    expect(loadLayoutSizes()).toEqual({
      sidebarWidth: 400,
      profileHeight: 300,
      sidebarCollapsed: false,
      profileCollapsed: false,
    })
  })

  it('falls back to false when a stored collapsed flag is not a boolean', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sidebarWidth: 400, profileHeight: 300, sidebarCollapsed: 'yes', profileCollapsed: 1 }),
    )
    const loaded = loadLayoutSizes()
    expect(loaded.sidebarCollapsed).toBe(false)
    expect(loaded.profileCollapsed).toBe(false)
  })

  it('round-trips collapsed flags through save then load', () => {
    const sizes: LayoutSizes = { sidebarWidth: 250, profileHeight: 150, sidebarCollapsed: true, profileCollapsed: true }
    saveLayoutSizes(sizes)
    expect(loadLayoutSizes()).toEqual(sizes)
  })
})

describe('SIDEBAR_COLLAPSED_WIDTH', () => {
  it('is a small positive strip width, well under a usable sidebar', () => {
    expect(SIDEBAR_COLLAPSED_WIDTH).toBeGreaterThan(0)
    expect(SIDEBAR_COLLAPSED_WIDTH).toBeLessThan(100)
  })
})
