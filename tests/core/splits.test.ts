import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import { computeKmSplits } from '../../src/core/perf/splits'
import { computeTrackGap } from '../../src/core/perf/gap'
import { derivePointSeries } from '../../src/core/perf/pointSeries'

function track(opts: { n: number; ele?: number[]; time?: number[]; hr?: number[]; step?: number }): Track {
  const step = opts.step ?? 0.001 // ~111m/point at lat 39
  const lon = Array.from({ length: opts.n }, (_, i) => 116 + i * step)
  const lat = Array.from({ length: opts.n }, () => 39)
  const t = createTrack(
    { lon, lat, ele: opts.ele, time: opts.time, hr: opts.hr },
    { name: 'x', format: 'gpx', fileName: 'x.gpx' },
  )
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

describe('computeKmSplits', () => {
  it('returns [] for a track with fewer than 2 points', () => {
    const t = track({ n: 1 })
    expect(computeKmSplits(t)).toEqual([])
  })

  it('a track whose length is not a whole number of kilometres puts the remainder in a final short split', () => {
    // ~111m/point * 99 points ~= 11km + a bit; not an exact multiple of 1000m.
    const n = 99
    const t = track({ n })
    const splits = computeKmSplits(t)
    const total = t.points.cumDist![n - 1]
    expect(total % 1000).not.toBeCloseTo(0, 0) // sanity: genuinely not a whole number of km

    const summedDistance = splits.reduce((s, sp) => s + sp.distance, 0)
    expect(summedDistance).toBeCloseTo(total, -1) // within ~rounding

    const last = splits[splits.length - 1]
    expect(last.distance).toBeLessThan(1000)
    expect(last.distance).toBeGreaterThan(0)
    // Every split before the last should be ~1000m (the reference cuts at
    // each 1000m mark, not evenly across the whole track).
    for (const sp of splits.slice(0, -1)) {
      expect(sp.distance).toBeGreaterThanOrEqual(900)
    }
  })

  it('km numbers are sequential starting at 1', () => {
    const t = track({ n: 30 })
    const splits = computeKmSplits(t)
    expect(splits.map((s) => s.km)).toEqual(splits.map((_, i) => i + 1))
  })

  it('time/pace are undefined when the track has no time column', () => {
    const t = track({ n: 30 })
    const splits = computeKmSplits(t)
    for (const sp of splits) {
      expect(sp.time).toBeUndefined()
      expect(sp.pace).toBeUndefined()
    }
  })

  it('time/pace are populated when the track has a time column', () => {
    const n = 30
    const time = Array.from({ length: n }, (_, i) => i * 60000) // 1 min/point
    const t = track({ n, time })
    const splits = computeKmSplits(t)
    for (const sp of splits) {
      expect(sp.time).toBeGreaterThan(0)
      expect(sp.pace).toBeGreaterThan(0)
    }
  })

  it('ascent/descent use the reference own >2m/<-2m diff threshold (not P0 hysteresis)', () => {
    const n = 20
    // Alternating +0.5/-0.5m jitter (1.0m step-to-step diff), below the 2m
    // threshold -> should not accumulate ANY ascent/descent, even though a
    // naive sum-of-abs-diffs would report plenty.
    const ele = Array.from({ length: n }, (_, i) => 100 + (i % 2 === 0 ? 0.5 : -0.5))
    const t = track({ n, ele })
    const splits = computeKmSplits(t)
    for (const sp of splits) {
      expect(sp.ascent).toBe(0)
      expect(sp.descent).toBe(0)
    }
  })

  it('avgHR averages readings only, ignoring the 0 sentinel', () => {
    const n = 20
    const hr = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 150 : 0))
    const t = track({ n, hr })
    const splits = computeKmSplits(t)
    expect(splits[0].avgHR).toBe(150)
  })

  it('gap is undefined when no TrackGap is supplied, populated when one is', () => {
    const n = 30
    const ele = Array.from({ length: n }, (_, i) => 100 + i)
    const time = Array.from({ length: n }, (_, i) => i * 60000)
    const t = track({ n, ele, time })

    const withoutGap = computeKmSplits(t)
    expect(withoutGap.every((sp) => sp.gap === undefined)).toBe(true)

    const series = derivePointSeries(t)
    const gap = computeTrackGap(t, series)!
    const withGap = computeKmSplits(t, series, gap)
    expect(withGap.some((sp) => sp.gap !== undefined)).toBe(true)
  })
})
