import { describe, it, expect } from 'vitest'
import { wgs84ToGcj02, gcj02ToWgs84, gcj02ToBd09, bd09ToGcj02, outOfChina, convertTrackArrays } from '../../src/core/crs/transform'
import { haversine } from '../../src/core/geo/distance'

describe('gcj02 transforms', () => {
  it('Beijing offset magnitude within 100~1000m', () => {
    const [glon, glat] = wgs84ToGcj02(116.3913, 39.9075)
    const d = haversine(116.3913, 39.9075, glon, glat)
    expect(d).toBeGreaterThan(100)
    expect(d).toBeLessThan(1000)
  })
  it('round-trip residual < 0.5m (iterative inverse)', () => {
    for (const [lon, lat] of [[116.39, 39.91], [102.7, 25.0], [87.6, 43.8], [121.47, 31.23]]) {
      const [glon, glat] = wgs84ToGcj02(lon, lat)
      const [wlon, wlat] = gcj02ToWgs84(glon, glat)
      expect(haversine(lon, lat, wlon, wlat)).toBeLessThan(0.5)
    }
  })
  it('identity outside China', () => {
    expect(outOfChina(-122.4, 37.8)).toBe(true)
    expect(wgs84ToGcj02(-122.4, 37.8)).toEqual([-122.4, 37.8])
  })
})

describe('bd09 transforms', () => {
  it('bd09 round-trip via gcj02 < 0.5m', () => {
    const [blon, blat] = gcj02ToBd09(116.40, 39.91)
    const [glon, glat] = bd09ToGcj02(blon, blat)
    expect(haversine(116.40, 39.91, glon, glat)).toBeLessThan(0.5)
  })
  it('gcj02ToBd09 identity outside China', () => {
    expect(gcj02ToBd09(-122.4, 37.8)).toEqual([-122.4, 37.8])
  })
  it('bd09ToGcj02 identity outside China', () => {
    expect(bd09ToGcj02(-122.4, 37.8)).toEqual([-122.4, 37.8])
  })
})

describe('convertTrackArrays bd09<->wgs84 compound paths', () => {
  it('bd09>wgs84 leaves a San Francisco coordinate unchanged', () => {
    const lon = Float64Array.from([-122.4])
    const lat = Float64Array.from([37.8])
    const { lon: l2, lat: l2lat } = convertTrackArrays(lon, lat, 'bd09', 'wgs84')
    expect(l2[0]).toBe(-122.4)
    expect(l2lat[0]).toBe(37.8)
  })

  it('bd09>wgs84>bd09 round-trip residual < 0.5m on a Chinese coordinate', () => {
    const lon = Float64Array.from([116.40])
    const lat = Float64Array.from([39.91])
    const step1 = convertTrackArrays(lon, lat, 'bd09', 'wgs84')
    const step2 = convertTrackArrays(step1.lon, step1.lat, 'wgs84', 'bd09')
    expect(haversine(lon[0], lat[0], step2.lon[0], step2.lat[0])).toBeLessThan(0.5)
  })

  it('wgs84>bd09>wgs84 round-trip residual < 0.5m on a Chinese coordinate', () => {
    const lon = Float64Array.from([116.40])
    const lat = Float64Array.from([39.91])
    const step1 = convertTrackArrays(lon, lat, 'wgs84', 'bd09')
    const step2 = convertTrackArrays(step1.lon, step1.lat, 'bd09', 'wgs84')
    expect(haversine(lon[0], lat[0], step2.lon[0], step2.lat[0])).toBeLessThan(0.5)
  })

  it('wgs84>bd09 shifts a Chinese coordinate by a plausible amount (100-2000m)', () => {
    // Compound shift = gcj02 offset (100-1000m) + bd09's own ~0.006 deg offset,
    // so the combined magnitude is larger than either leg alone.
    const lon = Float64Array.from([116.40])
    const lat = Float64Array.from([39.91])
    const { lon: blon, lat: blat } = convertTrackArrays(lon, lat, 'wgs84', 'bd09')
    const d = haversine(lon[0], lat[0], blon[0], blat[0])
    expect(d).toBeGreaterThan(100)
    expect(d).toBeLessThan(2000)
  })
})

describe('convertTrackArrays', () => {
  it('converts arrays and leaves inputs untouched', () => {
    const lon = Float64Array.from([116.40])
    const lat = Float64Array.from([39.91])
    const { lon: l2 } = convertTrackArrays(lon, lat, 'gcj02', 'wgs84')
    expect(l2[0]).not.toBe(116.40)
    expect(lon[0]).toBe(116.40) // 原数组不可变
  })

  it('same-crs conversion returns equal values in a new array (not the same reference)', () => {
    const lon = Float64Array.from([116.40, 121.47])
    const lat = Float64Array.from([39.91, 31.23])
    const result = convertTrackArrays(lon, lat, 'wgs84', 'wgs84')
    expect(result.lon).not.toBe(lon)
    expect(result.lat).not.toBe(lat)
    expect(Array.from(result.lon)).toEqual(Array.from(lon))
    expect(Array.from(result.lat)).toEqual(Array.from(lat))
  })

  it('unsupported pair throws', () => {
    const lon = Float64Array.from([116.40])
    const lat = Float64Array.from([39.91])
    expect(() => convertTrackArrays(lon, lat, 'wgs84' as any, 'martian' as any)).toThrow()
  })
})
