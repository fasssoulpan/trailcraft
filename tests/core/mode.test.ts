import { describe, it, expect } from 'vitest'
import { DEFAULT_MODE, loadMode, saveMode } from '../../src/state/mode'

// vite.config.ts runs tests with `environment: 'node'` -- there is no
// `localStorage` global here, the same situation state/layout.ts is in (see
// tests/core/layout.test.ts). loadMode/saveMode must not throw in that
// environment; they should just fall back to the default / silently no-op.
describe('mode persistence (no localStorage in this environment)', () => {
  it('loadMode falls back to the default without throwing', () => {
    expect(loadMode()).toBe(DEFAULT_MODE)
  })

  it('DEFAULT_MODE is plan (规划模式 is where the app should land first)', () => {
    expect(DEFAULT_MODE).toBe('plan')
  })

  it('saveMode does not throw', () => {
    expect(() => saveMode('fly')).not.toThrow()
    expect(() => saveMode('plan')).not.toThrow()
  })
})
