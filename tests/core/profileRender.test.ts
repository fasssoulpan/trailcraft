import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import { buildProfileData, xToIndex, indexToX } from '../../src/profile/profileRender'

const WIDTH = 500

function makeTrack(opts: { lon?: number[]; lat?: number[]; ele?: number[]; noEle?: boolean } = {}): Track {
  const lon = opts.lon ?? [116.0, 116.01, 116.02, 116.03, 116.04]
  const lat = opts.lat ?? [39.0, 39.0, 39.0, 39.0, 39.0]
  const ele = opts.noEle ? undefined : (opts.ele ?? [100, 150, 200, 150, 100])
  return createTrack({ lon, lat, ele }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
}

function withCumDist(t: Track): Track {
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

describe('buildProfileData', () => {
  it('decimates to maxPoints and computes min/max ignoring NaN gaps', () => {
    const t = withCumDist(makeTrack())
    const p = buildProfileData(t, 2000)
    expect(p).toBeDefined()
    expect(p!.dist.length).toBe(5) // n=5 <= maxPoints, identity decimation
    expect(p!.ele.length).toBe(5)
    expect(p!.idx.length).toBe(5)
    expect(Array.from(p!.idx)).toEqual([0, 1, 2, 3, 4])
    expect(p!.minEle).toBeCloseTo(100)
    expect(p!.maxEle).toBeCloseTo(200)
    expect(p!.totalDist).toBeCloseTo(t.points.cumDist![4])
    expect(p!.totalDist).toBeGreaterThan(0)
  })

  it('honors maxPoints decimation for larger tracks', () => {
    const n = 20
    const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.001)
    const lat = Array.from({ length: n }, () => 39)
    const ele = Array.from({ length: n }, (_, i) => 100 + i)
    const t = withCumDist(makeTrack({ lon, lat, ele }))
    const p = buildProfileData(t, 5)
    expect(p).toBeDefined()
    expect(p!.dist.length).toBe(5)
    expect(p!.idx[0]).toBe(0)
    expect(p!.idx[p!.idx.length - 1]).toBe(n - 1)
  })

  it('returns undefined when the track has no elevation column at all', () => {
    const t = withCumDist(makeTrack({ noEle: true }))
    expect(buildProfileData(t)).toBeUndefined()
  })

  it('returns undefined when the track has elevation but no cumDist', () => {
    const t = makeTrack() // cumDist intentionally left unset
    expect(buildProfileData(t)).toBeUndefined()
  })

  it('all-NaN elevation column: min/max collapse to 0 (documented), not +-Infinity', () => {
    const t = withCumDist(makeTrack({ ele: [NaN, NaN, NaN, NaN, NaN] }))
    const p = buildProfileData(t)
    expect(p).toBeDefined()
    expect(p!.minEle).toBe(0)
    expect(p!.maxEle).toBe(0)
    expect(Number.isFinite(p!.minEle)).toBe(true)
    expect(Number.isFinite(p!.maxEle)).toBe(true)
  })

  it('zero-distance (stationary/coincident-point) track: totalDist is 0, no crash', () => {
    const lon = [116, 116, 116, 116, 116]
    const lat = [39, 39, 39, 39, 39]
    const t = withCumDist(makeTrack({ lon, lat }))
    const p = buildProfileData(t)
    expect(p).toBeDefined()
    expect(p!.totalDist).toBe(0)
  })
})

describe('xToIndex / indexToX', () => {
  it('xToIndex(width/2) lands near the middle of the track', () => {
    const t = withCumDist(makeTrack())
    const p = buildProfileData(t)!
    const mid = xToIndex(p, WIDTH / 2, WIDTH)
    expect(mid).toBeGreaterThanOrEqual(1)
    expect(mid).toBeLessThanOrEqual(3)
  })

  it('xToIndex and indexToX are mutually inverse within +-1 index', () => {
    const t = withCumDist(makeTrack())
    const p = buildProfileData(t)!
    for (const i of [0, 1, 2, 3, 4]) {
      const x = indexToX(t, p, i, WIDTH)
      const back = xToIndex(p, x, WIDTH)
      expect(Math.abs(back - i)).toBeLessThanOrEqual(1)
    }
  })

  it('mutual inverse holds under decimation too (n=20, maxPoints=5)', () => {
    const n = 20
    const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.001)
    const lat = Array.from({ length: n }, () => 39)
    const ele = Array.from({ length: n }, (_, i) => 100 + i)
    const t = withCumDist(makeTrack({ lon, lat, ele }))
    const p = buildProfileData(t, 5)!
    for (const i of [0, 5, 10, 15, 19]) {
      const x = indexToX(t, p, i, WIDTH)
      const back = xToIndex(p, x, WIDTH)
      // decimated to 5 samples from 20 points => up to a few points of slop per segment
      expect(Math.abs(back - i)).toBeLessThanOrEqual(4)
    }
  })

  it('xToIndex clamps out-of-range x to [0, width]', () => {
    const t = withCumDist(makeTrack())
    const p = buildProfileData(t)!
    expect(xToIndex(p, -100, WIDTH)).toBe(xToIndex(p, 0, WIDTH))
    expect(xToIndex(p, WIDTH + 999, WIDTH)).toBe(xToIndex(p, WIDTH, WIDTH))
  })

  it('zero-distance track: xToIndex/indexToX do not produce NaN', () => {
    const lon = [116, 116, 116, 116, 116]
    const lat = [39, 39, 39, 39, 39]
    const t = withCumDist(makeTrack({ lon, lat }))
    const p = buildProfileData(t)!
    const idx = xToIndex(p, WIDTH / 2, WIDTH)
    expect(Number.isNaN(idx)).toBe(false)
    const x = indexToX(t, p, 2, WIDTH)
    expect(Number.isNaN(x)).toBe(false)
  })

  it('indexToX clamps out-of-range index', () => {
    const t = withCumDist(makeTrack())
    const p = buildProfileData(t)!
    expect(indexToX(t, p, -5, WIDTH)).toBe(indexToX(t, p, 0, WIDTH))
    expect(indexToX(t, p, 999, WIDTH)).toBe(indexToX(t, p, 4, WIDTH))
  })
})
