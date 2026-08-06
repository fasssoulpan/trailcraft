import { describe, it, expect } from 'vitest'
import { haversine, computeCumDist, locateByDist } from '../../src/core/geo/distance'

describe('haversine', () => {
  it('1 degree lat ≈ 111.2km', () => {
    expect(haversine(116, 39, 116, 40)).toBeCloseTo(111195, -3) // ±500m
  })
  it('zero distance', () => expect(haversine(116, 39, 116, 39)).toBe(0))
})

describe('computeCumDist', () => {
  it('monotonic cumulative distance', () => {
    const lon = Float64Array.from([116, 116, 116]); const lat = Float64Array.from([39, 39.01, 39.02])
    const cum = computeCumDist(lon, lat)
    expect(cum[0]).toBe(0)
    expect(cum[2]).toBeGreaterThan(cum[1])
    expect(cum[2]).toBeCloseTo(2 * cum[1], 0)
  })
})

describe('locateByDist', () => {
  it('binary-search index by distance', () => {
    const cum = Float64Array.from([0, 100, 200, 300])
    expect(locateByDist(cum, 150)).toBe(1)   // 落在 [1,2) 段
    expect(locateByDist(cum, 0)).toBe(0)
    expect(locateByDist(cum, 999)).toBe(2)   // 末段起点
  })
})
