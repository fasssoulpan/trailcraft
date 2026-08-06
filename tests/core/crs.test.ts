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
