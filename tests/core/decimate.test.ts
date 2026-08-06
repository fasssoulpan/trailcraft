import { describe, it, expect } from 'vitest'
import { decimateIndices } from '../../src/core/toolbox/decimate'

function assertStrictlyIncreasing(arr: Uint32Array) {
  for (let i = 1; i < arr.length; i++) expect(arr[i]).toBeGreaterThan(arr[i - 1])
}

describe('decimateIndices', () => {
  it('n <= maxPoints returns the identity index array', () => {
    expect(Array.from(decimateIndices(5, 5))).toEqual([0, 1, 2, 3, 4])
    expect(Array.from(decimateIndices(3, 5))).toEqual([0, 1, 2])
    expect(Array.from(decimateIndices(1, 5))).toEqual([0])
  })

  it('n=10, maxPoints=5 yields 5 strictly-increasing indices spanning 0..9', () => {
    const idx = decimateIndices(10, 5)
    expect(idx.length).toBe(5)
    assertStrictlyIncreasing(idx)
    expect(idx[0]).toBe(0)
    expect(idx[idx.length - 1]).toBe(9)
  })

  it('large case: n=330062, maxPoints=4000 yields exactly 4000 strictly-increasing indices', () => {
    const n = 330062
    const maxPoints = 4000
    const idx = decimateIndices(n, maxPoints)
    expect(idx.length).toBe(maxPoints)
    assertStrictlyIncreasing(idx)
    expect(idx[0]).toBe(0)
    expect(idx[idx.length - 1]).toBe(n - 1)
  })

  it('maxPoints <= 0 is a caller bug and throws rather than silently misbehaving', () => {
    expect(() => decimateIndices(10, 0)).toThrow()
    expect(() => decimateIndices(10, -1)).toThrow()
  })

  it('maxPoints === 1 with n > 1: cannot satisfy both "length <= maxPoints" and '
    + '"first & last included" at once, so first/last inclusion wins and length is 2', () => {
    const idx = decimateIndices(10, 1)
    expect(Array.from(idx)).toEqual([0, 9])
  })

  it('maxPoints === 1 with n <= 1 stays identity (no conflict)', () => {
    expect(Array.from(decimateIndices(1, 1))).toEqual([0])
    expect(Array.from(decimateIndices(0, 1))).toEqual([])
  })

  it('n === 0 returns an empty array', () => {
    expect(Array.from(decimateIndices(0, 4000))).toEqual([])
  })
})
