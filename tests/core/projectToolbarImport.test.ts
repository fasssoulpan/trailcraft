import { describe, it, expect } from 'vitest'

/**
 * ProjectToolbar.tsx pulls in persist.ts (IndexedDB) and touches
 * `window.confirm`/`window` inside its event handlers -- neither IndexedDB
 * nor a DOM `window` exists in this project's Node test environment (see
 * vite.config.ts: `environment: 'node'`), and there's no @testing-library
 * render harness wired up here to actually mount the component. What we can
 * and must verify without either of those: importing the module (and
 * therefore persist.ts transitively) doesn't throw -- persist.ts defers
 * opening the IndexedDB connection to the first real call (see its own
 * top-of-file comment), and none of ProjectToolbar's `window.*` usages run
 * at module-evaluation time, only inside handlers triggered by user
 * interaction.
 */
describe('ProjectToolbar module', () => {
  it('is importable in an environment without IndexedDB or window', async () => {
    const mod = await import('../../src/ui/ProjectToolbar')
    expect(typeof mod.ProjectToolbar).toBe('function')
  })
})
