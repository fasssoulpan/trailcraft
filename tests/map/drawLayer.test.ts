import { describe, it, expect } from 'vitest'
import { nearestDrawVertexIndex } from '../../src/map/trackLayer'
import type { Vertex } from '../../src/core/toolbox/draw'

// Pure hit-test logic only -- no real MapLibre Map instance needed (same
// rationale as zoomForBounds.test.ts alongside this file: syncDrawLayer/
// clearDrawLayer themselves need a live Map and are exercised manually/by
// the app, not here).

const VERTICES: Vertex[] = [
  [0, 0],
  [0.01, 0], // ~1.1km east
  [0.01, 0.01],
]

describe('nearestDrawVertexIndex', () => {
  it('returns the closest vertex within range', () => {
    expect(nearestDrawVertexIndex(VERTICES, 0.0001, 0.0001, 50)).toBe(0)
    expect(nearestDrawVertexIndex(VERTICES, 0.0099, 0.0001, 50)).toBe(1)
  })

  it('returns undefined when nothing is within maxDistanceM', () => {
    expect(nearestDrawVertexIndex(VERTICES, 5, 5, 50)).toBeUndefined()
  })

  it('returns undefined for an empty vertex list', () => {
    expect(nearestDrawVertexIndex([], 0, 0, 1000)).toBeUndefined()
  })

  it('picks the strictly nearest of two candidates both within range', () => {
    // Point just east of vertex 1 (index 1) but still within range of both 1 and 2.
    const idx = nearestDrawVertexIndex(VERTICES, 0.0101, 0.001, 2000)
    expect(idx).toBe(1)
  })
})
