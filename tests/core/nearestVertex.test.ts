import { describe, it, expect } from 'vitest'
import { nearestVertex } from '../../src/core/geo/nearestVertex'
import { haversine } from '../../src/core/geo/distance'

describe('nearestVertex', () => {
  it('finds the index and distance of the closest point, ignoring any monotonic ordering', () => {
    const lon = Float64Array.from([116, 116.001, 116.002, 116.003])
    const lat = Float64Array.from([39.9, 39.9, 39.9, 39.9])
    const r = nearestVertex(lon, lat, 116.0021, 39.9)
    expect(r.index).toBe(2)
    expect(r.distanceM).toBeCloseTo(haversine(116.0021, 39.9, 116.002, 39.9), 6)
  })

  it('a query exactly on a point returns distance 0', () => {
    const lon = Float64Array.from([116, 116.001])
    const lat = Float64Array.from([39.9, 39.9])
    const r = nearestVertex(lon, lat, 116.001, 39.9)
    expect(r.index).toBe(1)
    expect(r.distanceM).toBe(0)
  })

  it('single-point track does not throw and returns index 0', () => {
    const lon = Float64Array.from([116])
    const lat = Float64Array.from([39.9])
    expect(() => nearestVertex(lon, lat, 0, 0)).not.toThrow()
    expect(nearestVertex(lon, lat, 0, 0).index).toBe(0)
  })
})
