import { describe, it, expect } from 'vitest'
import type { Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import {
  buildPositionArray,
  synthesizeTimeline,
  RENDER_MAX_3D,
  FALLBACK_HEIGHT_M,
} from '../../src/cesium/trackGeometry'

function makeTrack(overrides: Partial<Track['points']> & { lon: number[]; lat: number[] }): Track {
  const lon = Float64Array.from(overrides.lon)
  const lat = Float64Array.from(overrides.lat)
  return {
    id: 'trk_test',
    meta: { name: 'test', format: 'gpx', fileName: 'test.gpx' },
    crs: 'wgs84',
    originalCrs: 'wgs84',
    points: {
      lon,
      lat,
      ele: overrides.ele,
      time: overrides.time,
      hr: overrides.hr,
      cumDist: overrides.cumDist ?? computeCumDist(lon, lat),
    },
  }
}

function syntheticLargeTrack(n: number): Track {
  const lon: number[] = new Array(n)
  const lat: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    lon[i] = 116 + i * 0.0001
    lat[i] = 39 + i * 0.0001
  }
  return makeTrack({ lon, lat })
}

describe('buildPositionArray', () => {
  it('flat array layout: [lon, lat, height, ...], length = idx.length * 3', () => {
    const t = makeTrack({ lon: [116.1, 116.2, 116.3], lat: [39.1, 39.2, 39.3], ele: Float32Array.from([100, 110, 120]) })
    const { flat, idx } = buildPositionArray(t, 10)
    expect(idx.length).toBe(3)
    expect(flat.length).toBe(9)
    expect(flat).toEqual([116.1, 39.1, 100, 116.2, 39.2, 110, 116.3, 39.3, 120])
  })

  it('idx stays within track bounds and strictly increasing', () => {
    const t = syntheticLargeTrack(1000)
    const { idx } = buildPositionArray(t, 100)
    expect(idx.length).toBe(100)
    for (let i = 0; i < idx.length; i++) {
      expect(idx[i]).toBeGreaterThanOrEqual(0)
      expect(idx[i]).toBeLessThan(1000)
    }
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1])
    expect(idx[0]).toBe(0)
    expect(idx[idx.length - 1]).toBe(999)
  })

  it('330k-point synthetic track decimates to exactly RENDER_MAX_3D points', () => {
    const t = syntheticLargeTrack(330_000)
    const { idx, flat } = buildPositionArray(t, RENDER_MAX_3D)
    expect(idx.length).toBe(RENDER_MAX_3D)
    expect(flat.length).toBe(RENDER_MAX_3D * 3)
  })

  it('whole ele column absent -> every render point gets FALLBACK_HEIGHT_M', () => {
    const t = makeTrack({ lon: [116.1, 116.2], lat: [39.1, 39.2] })
    const { flat } = buildPositionArray(t, 10)
    expect(flat[2]).toBe(FALLBACK_HEIGHT_M)
    expect(flat[5]).toBe(FALLBACK_HEIGHT_M)
  })

  it('single NaN ele value only affects that point, not the whole track', () => {
    const t = makeTrack({
      lon: [116.1, 116.2, 116.3],
      lat: [39.1, 39.2, 39.3],
      ele: Float32Array.from([100, NaN, 120]),
    })
    const { flat } = buildPositionArray(t, 10)
    expect(flat[2]).toBe(100)
    expect(flat[5]).toBe(FALLBACK_HEIGHT_M)
    expect(flat[8]).toBe(120)
  })

  it('single-point track produces a length-3 flat array', () => {
    const t = makeTrack({ lon: [116.1], lat: [39.1], ele: Float32Array.from([50]) })
    const { flat, idx } = buildPositionArray(t, 10)
    expect(idx.length).toBe(1)
    expect(flat).toEqual([116.1, 39.1, 50])
  })

  it('two-point track produces both points, unreduced by decimation', () => {
    const t = makeTrack({ lon: [116.1, 116.2], lat: [39.1, 39.2] })
    const { flat, idx } = buildPositionArray(t, 10)
    expect(idx.length).toBe(2)
    expect(flat.length).toBe(6)
  })
})

describe('synthesizeTimeline', () => {
  it('uses points.time when present, converting epoch ms to seconds-from-start', () => {
    const t = makeTrack({
      lon: [116.1, 116.2, 116.3],
      lat: [39.1, 39.2, 39.3],
      time: Float64Array.from([1_000_000, 1_002_000, 1_005_000]),
    })
    const idx = Uint32Array.from([0, 1, 2])
    const { times, synthetic } = synthesizeTimeline(t, idx)
    expect(synthetic).toBe(false)
    expect(times).toEqual([0, 2, 5])
  })

  it('duplicate consecutive timestamps are bumped to stay strictly increasing', () => {
    const t = makeTrack({
      lon: [116.1, 116.2, 116.3, 116.4],
      lat: [39.1, 39.2, 39.3, 39.4],
      time: Float64Array.from([1000, 1000, 1000, 2000]),
    })
    const idx = Uint32Array.from([0, 1, 2, 3])
    const { times } = synthesizeTimeline(t, idx)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])
    expect(times[0]).toBe(0)
    expect(times[3]).toBeCloseTo(1) // (2000-1000)/1000
  })

  it('many consecutive duplicates still yield strictly increasing output', () => {
    const n = 50
    const time = new Float64Array(n).fill(5000)
    time[n - 1] = 6000
    const lon = new Array(n).fill(0).map((_, i) => 116 + i * 0.001)
    const lat = new Array(n).fill(0).map((_, i) => 39 + i * 0.001)
    const t = makeTrack({ lon, lat, time })
    const idx = decimateIdentity(n)
    const { times } = synthesizeTimeline(t, idx)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])
  })

  it('absent time column synthesizes a strictly increasing timeline proportional to distance', () => {
    const lon = [116.0, 116.01, 116.02, 116.05]
    const lat = [39.0, 39.0, 39.0, 39.0]
    const t = makeTrack({ lon, lat })
    const idx = Uint32Array.from([0, 1, 2, 3])
    const { times, synthetic } = synthesizeTimeline(t, idx)
    expect(synthetic).toBe(true)
    expect(times[0]).toBe(0)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])

    const cumDist = t.points.cumDist!
    // proportional to distance: ratio time/dist constant across all non-zero-distance points
    const ratios = times.slice(1).map((time, i) => time / cumDist[idx[i + 1]])
    for (const r of ratios) expect(r).toBeCloseTo(ratios[0], 5)
  })

  it('absent time and absent cumDist still produces a strictly increasing timeline', () => {
    const t: Track = {
      id: 'trk_no_cumdist',
      meta: { name: 'x', format: 'gpx', fileName: 'x.gpx' },
      crs: 'wgs84',
      originalCrs: 'wgs84',
      points: { lon: Float64Array.from([1, 2, 3]), lat: Float64Array.from([1, 2, 3]) },
    }
    const idx = Uint32Array.from([0, 1, 2])
    const { times, synthetic } = synthesizeTimeline(t, idx)
    expect(synthetic).toBe(true)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])
  })

  it('single-point track yields a single time of 0', () => {
    const t = makeTrack({ lon: [116.1], lat: [39.1], time: Float64Array.from([123456]) })
    const idx = Uint32Array.from([0])
    const { times } = synthesizeTimeline(t, idx)
    expect(times).toEqual([0])
  })

  it('two-point degenerate track (no time) yields strictly increasing timeline', () => {
    const t = makeTrack({ lon: [116.1, 116.2], lat: [39.1, 39.1] })
    const idx = Uint32Array.from([0, 1])
    const { times } = synthesizeTimeline(t, idx)
    expect(times[0]).toBe(0)
    expect(times[1]).toBeGreaterThan(0)
  })
})

function decimateIdentity(n: number): Uint32Array {
  return Uint32Array.from({ length: n }, (_, i) => i)
}
