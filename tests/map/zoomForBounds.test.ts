import { describe, it, expect } from 'vitest'
import { LngLatBounds } from 'maplibre-gl'
import { zoomForBounds } from '../../src/map/trackLayer'

// A modest bounding box roughly the size of a real trail run (~a few km
// across), centered away from the poles/antimeridian so the Web Mercator
// latitude-fraction math (see zoomForBounds' own comment) behaves nicely.
function bbox(halfExtentDeg: number): LngLatBounds {
  return new LngLatBounds(
    [116 - halfExtentDeg, 39.9 - halfExtentDeg],
    [116 + halfExtentDeg, 39.9 + halfExtentDeg],
  )
}

describe('zoomForBounds', () => {
  it('doubling the container size (same bounds) yields roughly one more zoom level', () => {
    const bounds = bbox(0.05)
    const z1 = zoomForBounds(bounds, 800, 600)
    const z2 = zoomForBounds(bounds, 1600, 1200)
    expect(z2 - z1).toBeCloseTo(1, 1)
  })

  it('doubling the bounds extent (same container) yields roughly one less zoom level', () => {
    const small = bbox(0.05)
    const big = bbox(0.1) // double the width/height span
    const z1 = zoomForBounds(small, 800, 600)
    const z2 = zoomForBounds(big, 800, 600)
    expect(z1 - z2).toBeCloseTo(1, 1)
  })

  it('a bounds spanning a known extent at a known size produces a zoom that would actually fit it', () => {
    // At the returned zoom, the bounds' longitude span (in world-fraction
    // terms) should occupy no more than the container's own width fraction
    // -- i.e. the same "fraction of the world" relationship zoomForBounds is
    // built from (see its doc comment) holds in reverse.
    const width = 800
    const height = 600
    const bounds = bbox(0.05)
    const z = zoomForBounds(bounds, width, height)

    const WORLD_PX = 256
    const lngFraction = (bounds.getEast() - bounds.getWest()) / 360
    const worldPxAtZ = WORLD_PX * 2 ** z
    const boundsPxAtZ = worldPxAtZ * lngFraction
    // Fits within (up to floating point slack): the bounds' rendered width
    // at zoom z is no bigger than the container itself.
    expect(boundsPxAtZ).toBeLessThanOrEqual(width + 1e-6)
  })

  it('clamps to the [0, 20] range and stays finite for a zero-extent (single-point) bounds', () => {
    const point: [number, number] = [116, 39.9]
    const bounds = new LngLatBounds(point, point)
    const z = zoomForBounds(bounds, 800, 600)
    // A single point has no extent to fit around, so the fallback tiny
    // divisor (see zoomForBounds' comment) drives the computed zoom far past
    // the max and it clamps there -- deterministically 20, never NaN/Infinity.
    expect(Number.isFinite(z)).toBe(true)
    expect(z).toBe(20)
  })

  it('clamps to the [0, 20] range for a huge (near-global) bounds', () => {
    const bounds = new LngLatBounds([-179, -85], [179, 85])
    const z = zoomForBounds(bounds, 800, 600)
    expect(Number.isFinite(z)).toBe(true)
    expect(z).toBeGreaterThanOrEqual(0)
    expect(z).toBeLessThanOrEqual(20)
  })

  it('very small containers still produce a finite, in-range zoom', () => {
    const bounds = bbox(0.05)
    const z = zoomForBounds(bounds, 2, 2)
    expect(Number.isFinite(z)).toBe(true)
    expect(z).toBeGreaterThanOrEqual(0)
    expect(z).toBeLessThanOrEqual(20)
  })

  it('never returns NaN or a value outside [0, 20] across a range of container sizes', () => {
    const bounds = bbox(0.02)
    for (const size of [1, 2, 10, 100, 1000, 10000]) {
      const z = zoomForBounds(bounds, size, size)
      expect(Number.isNaN(z)).toBe(false)
      expect(z).toBeGreaterThanOrEqual(0)
      expect(z).toBeLessThanOrEqual(20)
    }
  })
})
