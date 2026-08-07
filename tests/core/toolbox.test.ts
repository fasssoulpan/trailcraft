import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist, haversine } from '../../src/core/geo/distance'
import { splitAt, joinTracks, reverseTrack, removeAnomalies, simplifyTrack } from '../../src/core/toolbox/ops'

function mk(lon: number[], lat: number[], ele?: number[], time?: number[]) {
  const t = createTrack({ lon, lat, ele, time }, { name: 't', format: 'gpx', fileName: 't.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

/** Same as `mk`, but with an explicit color/lineWidth on meta -- used by the
 * "derived tracks inherit styling" tests below, where the point is
 * specifically to check what happens to those two fields across an op. */
function mkStyled(lon: number[], lat: number[], color: string, lineWidth: number) {
  const t = createTrack({ lon, lat }, { name: 't', format: 'gpx', fileName: 't.gpx', color, lineWidth })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

describe('splitAt', () => {
  it('splits a 4-point track at index 2 into lengths 3 and 2, boundary point shared', () => {
    const t = mk([0, 1, 2, 3], [0, 0, 0, 0])
    const [a, b] = splitAt(t, 2)
    expect(a.points.lon.length).toBe(3)
    expect(b.points.lon.length).toBe(2)
    expect(a.points.lon[2]).toBe(2)
    expect(b.points.lon[0]).toBe(2)
    expect(a.points.lat[2]).toBe(b.points.lat[0])
  })

  it('does not mutate the source track', () => {
    const t = mk([0, 1, 2, 3], [0, 0, 0, 0])
    const before = Array.from(t.points.lon)
    splitAt(t, 2)
    expect(t.points.lon.length).toBe(4)
    expect(Array.from(t.points.lon)).toEqual(before)
  })

  it('throws for out-of-range indices', () => {
    const t = mk([0, 1, 2, 3], [0, 0, 0, 0])
    expect(() => splitAt(t, 0)).toThrow()
    expect(() => splitAt(t, 3)).toThrow() // n-1
    expect(() => splitAt(t, -1)).toThrow()
    expect(() => splitAt(t, 4)).toThrow() // beyond end
  })
})

describe('joinTracks', () => {
  it('concatenates two 2-point tracks to 4 with a recomputed monotonic cumDist', () => {
    const t1 = mk([0, 1], [0, 0])
    const t2 = mk([2, 3], [0, 0])
    const joined = joinTracks([t1, t2])
    expect(joined.points.lon.length).toBe(4)
    expect(Array.from(joined.points.lon)).toEqual([0, 1, 2, 3])
    const cum = joined.points.cumDist!
    expect(cum[0]).toBe(0)
    for (let i = 1; i < cum.length; i++) expect(cum[i]).toBeGreaterThan(cum[i - 1])
  })

  it('throws when fewer than 2 inputs', () => {
    const t1 = mk([0, 1], [0, 0])
    expect(() => joinTracks([])).toThrow()
    expect(() => joinTracks([t1])).toThrow()
  })

  it('preserves ele/time when present', () => {
    const t1 = mk([0, 1], [0, 0], [10, 20], [0, 1000])
    const t2 = mk([2, 3], [0, 0], [30, 40], [2000, 3000])
    const joined = joinTracks([t1, t2])
    expect(Array.from(joined.points.ele!)).toEqual([10, 20, 30, 40])
    expect(Array.from(joined.points.time!)).toEqual([0, 1000, 2000, 3000])
  })

  it('does not mutate the source tracks', () => {
    const t1 = mk([0, 1], [0, 0])
    const t2 = mk([2, 3], [0, 0])
    const before1 = Array.from(t1.points.lon)
    joinTracks([t1, t2])
    expect(Array.from(t1.points.lon)).toEqual(before1)
  })
})

describe('reverseTrack', () => {
  it('reverses lon/lat/ele arrays', () => {
    const t = mk([0, 1, 2], [0, 10, 20], [100, 200, 300])
    const r = reverseTrack(t)
    expect(Array.from(r.points.lon)).toEqual([2, 1, 0])
    expect(Array.from(r.points.lat)).toEqual([20, 10, 0])
    expect(Array.from(r.points.ele!)).toEqual([300, 200, 100])
  })

  it('does not mutate the source track', () => {
    const t = mk([0, 1, 2], [0, 10, 20])
    const before = Array.from(t.points.lon)
    reverseTrack(t)
    expect(Array.from(t.points.lon)).toEqual(before)
  })
})

describe('removeAnomalies', () => {
  it('drops a single point that jumps ~500m away in a 1Hz ~2m/step track, keeps the rest', () => {
    const dLat = 2 / 111320 // ~2m per step
    const jumpLat = 500 / 111320 // ~500m jump
    const lat = [0, dLat, 2 * dLat + jumpLat, 3 * dLat, 4 * dLat]
    const lon = [0, 0, 0, 0, 0]
    const time = [0, 1000, 2000, 3000, 4000]
    const t = mk(lon, lat, undefined, time)
    const cleaned = removeAnomalies(t)
    expect(cleaned.points.lon.length).toBe(4)
    // the anomalous point's latitude value must not appear in the output
    expect(Array.from(cleaned.points.lat)).not.toContain(lat[2])
  })

  it('dt=0 teleport (identical timestamp, large distance) is dropped', () => {
    const t = mk([0, 0], [0, 500 / 111320], undefined, [0, 0])
    const cleaned = removeAnomalies(t)
    expect(cleaned.points.lon.length).toBe(1)
  })

  it('dt=0 harmless duplicate (identical timestamp, negligible distance) is kept', () => {
    const t = mk([0, 0], [0, 0.5 / 111320], undefined, [0, 0]) // ~0.5m apart
    const cleaned = removeAnomalies(t)
    expect(cleaned.points.lon.length).toBe(2)
  })

  it('track with no time column is returned unchanged (speed unknowable)', () => {
    const t = mk([0, 10, 0.0001], [0, 10, 0]) // wild jump but no time
    const cleaned = removeAnomalies(t)
    expect(cleaned.points.lon.length).toBe(3)
  })

  it('does not mutate the source track', () => {
    const dLat = 2 / 111320
    const t = mk([0, 0, 0], [0, dLat, 2 * dLat], undefined, [0, 1000, 2000])
    const before = Array.from(t.points.lon)
    removeAnomalies(t)
    expect(Array.from(t.points.lon)).toEqual(before)
  })
})

describe('simplifyTrack', () => {
  it('collapses a straight line of 4 collinear points to its 2 endpoints', () => {
    const t = mk([0, 0.0001, 0.0002, 0.0003], [0, 0, 0, 0])
    const s = simplifyTrack(t, 1)
    expect(s.points.lon.length).toBe(2)
    expect(s.points.lon[0]).toBe(0)
    expect(s.points.lon[1]).toBe(0.0003)
  })

  it('keeps a real corner at a tolerance below its deviation', () => {
    // p0=(0,0) -> p2=(0.001,0) is the baseline (lat=0 throughout);
    // p1 deviates perpendicular to that line by roughly 11m.
    const t = mk([0, 0.0005, 0.001], [0, 0.0001, 0])
    const deviationApprox = 11 // metres, see comment above
    const s = simplifyTrack(t, deviationApprox - 5)
    expect(s.points.lon.length).toBe(3)
  })

  it('removes the corner when tolerance exceeds its deviation', () => {
    const t = mk([0, 0.0005, 0.001], [0, 0.0001, 0])
    const s = simplifyTrack(t, 50)
    expect(s.points.lon.length).toBe(2)
  })

  it('tolerance 0 keeps everything', () => {
    const t = mk([0, 0.0005, 0.001], [0, 0.0001, 0])
    const s = simplifyTrack(t, 0)
    expect(s.points.lon.length).toBe(3)
  })

  it('always keeps first and last points', () => {
    const t = mk([0, 0.0005, 0.001], [0, 0.0001, 0])
    const s = simplifyTrack(t, 1e9)
    expect(s.points.lon[0]).toBe(t.points.lon[0])
    expect(s.points.lon[s.points.lon.length - 1]).toBe(t.points.lon[t.points.lon.length - 1])
  })

  it('does not mutate the source track', () => {
    const t = mk([0, 0.0005, 0.001], [0, 0.0001, 0])
    const before = Array.from(t.points.lon)
    simplifyTrack(t, 1)
    expect(Array.from(t.points.lon)).toEqual(before)
  })
})

describe('immutability sweep and fresh ids', () => {
  const ops: Array<[string, (t: Track) => Track]> = [
    ['reverseTrack', (t) => reverseTrack(t)],
    ['removeAnomalies', (t) => removeAnomalies(t)],
    ['simplifyTrack', (t) => simplifyTrack(t, 1)],
  ]
  for (const [name, op] of ops) {
    it(`${name}: source untouched, new id`, () => {
      const t = mk([0, 0.0001, 0.0002, 0.0003], [0, 0, 0, 0], undefined, [0, 1000, 2000, 3000])
      const before = Array.from(t.points.lon)
      const result = op(t)
      expect(Array.from(t.points.lon)).toEqual(before)
      expect(result.id).not.toBe(t.id)
    })
  }

  it('splitAt: source untouched, new ids', () => {
    const t = mk([0, 1, 2, 3], [0, 0, 0, 0])
    const before = Array.from(t.points.lon)
    const [a, b] = splitAt(t, 2)
    expect(Array.from(t.points.lon)).toEqual(before)
    expect(a.id).not.toBe(t.id)
    expect(b.id).not.toBe(t.id)
    expect(a.id).not.toBe(b.id)
  })

  it('joinTracks: sources untouched, new id', () => {
    const t1 = mk([0, 1], [0, 0])
    const t2 = mk([2, 3], [0, 0])
    const before1 = Array.from(t1.points.lon)
    const before2 = Array.from(t2.points.lon)
    const joined = joinTracks([t1, t2])
    expect(Array.from(t1.points.lon)).toEqual(before1)
    expect(Array.from(t2.points.lon)).toEqual(before2)
    expect(joined.id).not.toBe(t1.id)
    expect(joined.id).not.toBe(t2.id)
  })
})

// Track.meta.color/lineWidth are presentation attributes (see
// core/model/trackStyle.ts), stored on Track.meta specifically so that
// every op below -- which derives its new Track's meta via
// `{ ...src.meta, name: ... }` (splitAt/reverseTrack/removeAnomalies/
// simplifyTrack via `derive()`, joinTracks separately but the same
// pattern) -- carries them forward automatically, without each op needing
// its own explicit color/lineWidth-copying logic. A regression here (e.g.
// someone rewriting an op to build meta from scratch instead of spreading
// src.meta) would silently revert every derived track back to whatever
// palette default trackLayer.ts falls back to, which is exactly the "check
// derived tracks don't lose their styling" risk this covers.
describe('toolbox ops preserve per-track colour/lineWidth (Track.meta) across derivation', () => {
  it('splitAt: both halves inherit the source track\'s colour and width', () => {
    const t = mkStyled([0, 1, 2, 3], [0, 0, 0, 0], '#ff00ff', 6)
    const [a, b] = splitAt(t, 2)
    expect(a.meta.color).toBe('#ff00ff')
    expect(a.meta.lineWidth).toBe(6)
    expect(b.meta.color).toBe('#ff00ff')
    expect(b.meta.lineWidth).toBe(6)
  })

  it('reverseTrack: the reversed track inherits colour and width', () => {
    const t = mkStyled([0, 1, 2], [0, 10, 20], '#00ffff', 4)
    const r = reverseTrack(t)
    expect(r.meta.color).toBe('#00ffff')
    expect(r.meta.lineWidth).toBe(4)
  })

  it('removeAnomalies: the cleaned track inherits colour and width', () => {
    const t = mkStyled([0, 0.0001, 0.0002, 0.0003], [0, 0, 0, 0], '#112233', 3.5)
    const cleaned = removeAnomalies(t)
    expect(cleaned.meta.color).toBe('#112233')
    expect(cleaned.meta.lineWidth).toBe(3.5)
  })

  it('simplifyTrack: the simplified track inherits colour and width', () => {
    const t = mkStyled([0, 0.0001, 0.0002, 0.0003], [0, 0, 0, 0], '#445566', 7)
    const simplified = simplifyTrack(t, 1)
    expect(simplified.meta.color).toBe('#445566')
    expect(simplified.meta.lineWidth).toBe(7)
  })

  it('joinTracks: the joined track inherits the FIRST source track\'s colour and width', () => {
    const t1 = mkStyled([0, 1], [0, 0], '#abcdef', 8)
    const t2 = mkStyled([2, 3], [0, 0], '#fedcba', 1)
    const joined = joinTracks([t1, t2])
    expect(joined.meta.color).toBe('#abcdef')
    expect(joined.meta.lineWidth).toBe(8)
  })
})
