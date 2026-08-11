import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import { derivePointSeries } from '../../src/core/perf/pointSeries'

function track(opts: {
  n: number
  ele?: number[]
  time?: number[]
  step?: number
}): Track {
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

describe('derivePointSeries', () => {
  it('dist reuses track.points.cumDist when present', () => {
    const t = track({ n: 5 })
    const s = derivePointSeries(t)
    expect(s.dist).toBe(t.points.cumDist)
  })

  it('computes cumDist on the fly when absent', () => {
    const lon = [116, 116.001, 116.002]
    const lat = [39, 39, 39]
    const t = createTrack({ lon, lat }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
    const s = derivePointSeries(t)
    expect(s.dist.length).toBe(3)
    expect(s.dist[0]).toBe(0)
    expect(s.dist[2]).toBeGreaterThan(0)
  })

  it('segmentDist[0] is 0, subsequent entries equal consecutive dist deltas', () => {
    const t = track({ n: 5 })
    const s = derivePointSeries(t)
    expect(s.segmentDist[0]).toBe(0)
    for (let i = 1; i < 5; i++) {
      expect(s.segmentDist[i]).toBeCloseTo(s.dist[i] - s.dist[i - 1], 9)
    }
  })

  it('elapsedSec/segmentTime are undefined when the track has no time column', () => {
    const t = track({ n: 5 })
    const s = derivePointSeries(t)
    expect(s.elapsedSec).toBeUndefined()
    expect(s.segmentTime).toBeUndefined()
  })

  it('elapsedSec starts at 0 and segmentTime matches consecutive deltas when time is present', () => {
    const t = track({ n: 4, time: [1000, 3000, 6000, 10000] })
    const s = derivePointSeries(t)
    expect(s.elapsedSec![0]).toBe(0)
    expect(s.elapsedSec![1]).toBe(2)
    expect(s.elapsedSec![2]).toBe(5)
    expect(s.elapsedSec![3]).toBe(9)
    expect(s.segmentTime![0]).toBe(0)
    expect(s.segmentTime![1]).toBe(2)
    expect(s.segmentTime![2]).toBe(3)
    expect(s.segmentTime![3]).toBe(4)
  })

  it('a per-point missing timestamp (NaN) leaves that point and its adjacent segments NaN, not fabricated', () => {
    const t = track({ n: 4, time: [1000, NaN, 5000, 8000] })
    const s = derivePointSeries(t)
    expect(Number.isNaN(s.elapsedSec![1])).toBe(true)
    expect(Number.isNaN(s.segmentTime![1])).toBe(true)
    expect(Number.isNaN(s.segmentTime![2])).toBe(true)
    expect(s.segmentTime![3]).toBe(3) // 8000 - 5000
  })

  it('grade is undefined when the track has no elevation column', () => {
    const t = track({ n: 10 })
    const s = derivePointSeries(t)
    expect(s.grade).toBeUndefined()
  })

  it('grade is positive on a steady climb and negative on a steady descent', () => {
    const climb = track({ n: 20, ele: Array.from({ length: 20 }, (_, i) => 100 + i * 5) })
    const sClimb = derivePointSeries(climb)
    expect(sClimb.grade![10]).toBeGreaterThan(0)

    const descend = track({ n: 20, ele: Array.from({ length: 20 }, (_, i) => 200 - i * 5) })
    const sDescend = derivePointSeries(descend)
    expect(sDescend.grade![10]).toBeLessThan(0)
  })

  it('grade is clamped to [-60, 60] for an extreme profile', () => {
    const t = track({ n: 10, step: 0.00001, ele: Array.from({ length: 10 }, (_, i) => i * 500) })
    const s = derivePointSeries(t)
    for (let i = 0; i < 10; i++) {
      expect(s.grade![i]).toBeLessThanOrEqual(60)
      expect(s.grade![i]).toBeGreaterThanOrEqual(-60)
    }
  })

  it('grade falls back to 0 (reference behaviour) when a window edge has no finite elevation', () => {
    // window=3 on each side: index 3's back edge (index 0) is NaN -> falls back to 0,
    // rather than NaN propagating or a value computed from a different edge.
    const ele = [NaN, 100, 105, 110, 115, 120, NaN]
    const t = track({ n: 7, ele })
    const s = derivePointSeries(t)
    expect(s.grade![3]).toBe(0)
  })
})
