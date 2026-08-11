import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import { gapFactor, calculateGAP, isHikingSegment, computeTrackGap } from '../../src/core/perf/gap'

describe('gapFactor', () => {
  it('is ~1.0 on flat ground (grade 0)', () => {
    expect(gapFactor(0)).toBeCloseTo(1.0, 1)
  })

  it('is greater than 1 on a moderate uphill (cost of climbing > flat)', () => {
    expect(gapFactor(10)).toBeGreaterThan(1.0)
  })

  it('is less than 1 on a moderate downhill (Minetti cost drops below the 0.88 floor quickly)', () => {
    expect(gapFactor(-5)).toBeLessThan(1.0)
  })

  it('never drops below the 0.88 floor even on steep, favourable downhill grades', () => {
    expect(gapFactor(-20)).toBeCloseTo(0.88, 5)
    expect(gapFactor(-45)).toBeCloseTo(0.88, 5)
  })

  it('switches to linear extrapolation above +15% and keeps climbing with grade', () => {
    const at15 = gapFactor(15)
    const at20 = gapFactor(25)
    const at30 = gapFactor(35)
    expect(at20).toBeGreaterThan(at15)
    expect(at30).toBeGreaterThan(at20)
  })

  it('caps the extrapolated factor at 5.0', () => {
    expect(gapFactor(45)).toBeLessThanOrEqual(5.0)
  })

  it('clamps input grade to [-45, 45]', () => {
    expect(gapFactor(90)).toBe(gapFactor(45))
    expect(gapFactor(-90)).toBe(gapFactor(-45))
  })
})

describe('calculateGAP', () => {
  it('returns 0 for a non-positive pace', () => {
    expect(calculateGAP(0, 5)).toBe(0)
    expect(calculateGAP(-100, 5)).toBe(0)
  })

  it('equals pace/gapFactor for a positive pace', () => {
    expect(calculateGAP(300, 10)).toBeCloseTo(300 / gapFactor(10), 6)
  })

  it('GAP on an uphill point is faster (lower sec/km) than the raw pace, correcting for climb effort', () => {
    const rawPace = 400 // sec/km
    expect(calculateGAP(rawPace, 12)).toBeLessThan(rawPace)
  })
})

describe('isHikingSegment', () => {
  it('is true for grade > 30% regardless of speed', () => {
    expect(isHikingSegment(31, 5)).toBe(true)
  })

  it('is true for grade > 20% AND speed < 0.56 m/s', () => {
    expect(isHikingSegment(25, 0.3)).toBe(true)
  })

  it('is false for grade > 20% but speed >= 0.56 m/s (still running that grade)', () => {
    expect(isHikingSegment(25, 1.0)).toBe(false)
  })

  it('is false at the grade=20 boundary itself (threshold is strictly >20)', () => {
    expect(isHikingSegment(20, 0.1)).toBe(false)
  })

  it('is false on flat/moderate grade regardless of speed', () => {
    expect(isHikingSegment(5, 0.1)).toBe(false)
  })
})

function track(opts: { n: number; ele?: number[]; time?: number[]; step?: number }): Track {
  const step = opts.step ?? 0.001
  const lon = Array.from({ length: opts.n }, (_, i) => 116 + i * step)
  const lat = Array.from({ length: opts.n }, () => 39)
  const t = createTrack(
    { lon, lat, ele: opts.ele, time: opts.time },
    { name: 'x', format: 'gpx', fileName: 'x.gpx' },
  )
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

describe('computeTrackGap', () => {
  it('returns undefined when the track has no elevation column', () => {
    const t = track({ n: 20, time: Array.from({ length: 20 }, (_, i) => i * 5000) })
    expect(computeTrackGap(t)).toBeUndefined()
  })

  it('returns undefined when the track has no time column', () => {
    const t = track({ n: 20, ele: Array.from({ length: 20 }, (_, i) => 100 + i) })
    expect(computeTrackGap(t)).toBeUndefined()
  })

  it('produces a gap/isHiking array of the right length when both columns are present', () => {
    const n = 20
    const t = track({
      n,
      ele: Array.from({ length: n }, (_, i) => 100 + i * 2),
      time: Array.from({ length: n }, (_, i) => i * 5000), // 5s/point -> ~4.5km/h flat-ish pace
    })
    const result = computeTrackGap(t)
    expect(result).toBeDefined()
    expect(result!.gap.length).toBe(n)
    expect(result!.isHiking.length).toBe(n)
  })

  it('flags a steep, slow segment as hiking', () => {
    const n = 10
    // Very steep climb (50m/point over ~85m steps -> way over 20% grade) at slow pace
    // (60s/point over ~85m -> ~1.4 m/s... need < 0.56 m/s, so slow it further).
    const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.0002) // ~17m/point
    const lat = Array.from({ length: n }, () => 39)
    const ele = Array.from({ length: n }, (_, i) => 100 + i * 20) // steep climb
    const time = Array.from({ length: n }, (_, i) => i * 60000) // 60s/point -> ~0.28 m/s
    const t = createTrack({ lon, lat, ele, time }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
    t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
    const result = computeTrackGap(t)!
    expect(result.isHiking[5]).toBe(1)
  })
})
