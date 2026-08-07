import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import type { CheckPoint } from '../../src/core/model/checkpoint'
import { computeSegments, calibrateThreshold } from '../../src/core/stats/segments'
import { smoothElevation, computeGainLoss } from '../../src/core/stats/elevation'

function climbingTrack(n = 100): Track {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.0005)
  const lat = Array.from({ length: n }, () => 39.9)
  const ele = Array.from({ length: n }, (_, i) => 1000 + i * 5) // steady 5m/point climb
  const t = createTrack({ lon, lat, ele }, { name: 'climb', format: 'gpx', fileName: 'climb.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

function noEleTrack(n = 50): Track {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.0005)
  const lat = Array.from({ length: n }, () => 39.9)
  const t = createTrack({ lon, lat }, { name: 'noele', format: 'gpx', fileName: 'noele.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

function cp(name: string, anchorIndex: number): CheckPoint {
  return { id: name, name, kind: 'cp', anchorIndex }
}

describe('computeSegments', () => {
  it('produces exactly 3 segments named 起点→CP1, CP1→CP2, CP2→终点', () => {
    const t = climbingTrack()
    const segs = computeSegments(t, [cp('CP1', 30), cp('CP2', 60)])
    expect(segs).toHaveLength(3)
    expect(segs[0].fromName).toBe('起点')
    expect(segs[0].toName).toBe('CP1')
    expect(segs[1].fromName).toBe('CP1')
    expect(segs[1].toName).toBe('CP2')
    expect(segs[2].fromName).toBe('CP2')
    expect(segs[2].toName).toBe('终点')
  })

  it('segment distances sum to the track total', () => {
    const t = climbingTrack()
    const segs = computeSegments(t, [cp('CP1', 30), cp('CP2', 60)])
    const total = t.points.cumDist![t.points.cumDist!.length - 1]
    const sum = segs.reduce((s, seg) => s + seg.dist, 0)
    expect(sum).toBeCloseTo(total, 5)
  })

  it('netSlope equals (end ele - start ele)/dist for a segment', () => {
    const t = climbingTrack()
    const segs = computeSegments(t, [cp('CP1', 30), cp('CP2', 60)])
    const seg = segs[1] // CP1 -> CP2
    const expected = (t.points.ele![60] - t.points.ele![30]) / seg.dist
    expect(seg.netSlope).toBeCloseTo(expected, 8)
  })

  it('sorts CPs given out of order by anchorIndex', () => {
    const t = climbingTrack()
    const segs = computeSegments(t, [cp('CP2', 60), cp('CP1', 30)])
    expect(segs[0].toName).toBe('CP1')
    expect(segs[1].toName).toBe('CP2')
  })

  it('zero CPs yields a single 起点→终点 segment', () => {
    const t = climbingTrack()
    const segs = computeSegments(t, [])
    expect(segs).toHaveLength(1)
    expect(segs[0].fromName).toBe('起点')
    expect(segs[0].toName).toBe('终点')
  })

  it('a zero-length segment does not divide by zero', () => {
    const t = climbingTrack()
    // CP anchored exactly at the start point => 起点→CP1 has zero distance
    const segs = computeSegments(t, [cp('CP1', 0)])
    expect(segs[0].dist).toBe(0)
    expect(Number.isFinite(segs[0].gainRate)).toBe(true)
    expect(Number.isFinite(segs[0].lossRate)).toBe(true)
    expect(Number.isFinite(segs[0].netSlope)).toBe(true)
  })

  it('throws when cumDist is missing', () => {
    const t = climbingTrack()
    t.points.cumDist = undefined
    expect(() => computeSegments(t, [])).toThrow()
  })

  it('a track without elevation returns 0 gain/loss/netSlope and does not throw', () => {
    const t = noEleTrack()
    expect(() => computeSegments(t, [cp('CP1', 20)])).not.toThrow()
    const segs = computeSegments(t, [cp('CP1', 20)])
    for (const s of segs) {
      expect(s.gain).toBe(0)
      expect(s.loss).toBe(0)
      expect(s.netSlope).toBe(0)
    }
  })
})

describe('calibrateThreshold', () => {
  it('returns a threshold in [3,10] whose gain is at least as close to target as the default 5', () => {
    const t = climbingTrack()
    const officialGain = 300
    const best = calibrateThreshold(t, officialGain)
    expect(best).toBeGreaterThanOrEqual(3)
    expect(best).toBeLessThanOrEqual(10)

    const smoothed = smoothElevation(t.points.ele!, 5)
    const bestDiff = Math.abs(computeGainLoss(smoothed, best).gain - officialGain)
    const defaultDiff = Math.abs(computeGainLoss(smoothed, 5).gain - officialGain)
    expect(bestDiff).toBeLessThanOrEqual(defaultDiff)
  })

  it('throws without elevation', () => {
    const t = noEleTrack()
    expect(() => calibrateThreshold(t, 100)).toThrow()
  })
})
