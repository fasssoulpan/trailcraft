import { describe, it, expect } from 'vitest'
import { clamp, loadLayoutSizes, saveLayoutSizes, DEFAULT_LAYOUT_SIZES } from '../../src/state/layout'

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
    expect(() => saveLayoutSizes({ sidebarWidth: 400, profileHeight: 300 })).not.toThrow()
  })
})
