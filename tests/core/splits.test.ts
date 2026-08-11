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

  // P2 Q2 commit 1: ascent/descent switched from the reference's own
  // >2m/<-2m diff threshold to a prefix difference over P0's
  // threshold-hysteresis running totals (core/stats/runningStats.ts#
  // buildRunningGain/buildRunningLoss) -- the same algorithm and
  // `statsOptions` as climbs.ts and the whole-track total feeding the score.
  // See splits.ts's header comment for the full rationale.
  it('ascent/descent now use P0 threshold-hysteresis (default threshold=5, smoothWindow=5), same as climbs.ts and the track-total feeding the score', () => {
    const n = 20
    // Alternating +0.5/-0.5m jitter (1.0m step-to-step diff) is well under
    // P0's default 5m threshold -- and gets smoothed away further by the
    // default 5-window smoothing before the threshold is even applied --
    // so it should still accumulate ZERO ascent/descent, though for a
    // different reason than before this port switched off the reference's
    // own >2m/<-2m diff-sum rule.
    const ele = Array.from({ length: n }, (_, i) => 100 + (i % 2 === 0 ? 0.5 : -0.5))
    const t = track({ n, ele })
    const splits = computeKmSplits(t)
    for (const sp of splits) {
      expect(sp.ascent).toBe(0)
      expect(sp.descent).toBe(0)
    }
  })

  it('per-split ascent/descent sum to the whole-track total from core/stats/elevation.ts#computeGainLoss (prefix-difference additivity)', async () => {
    const { smoothElevation, computeGainLoss } = await import('../../src/core/stats/elevation')
    const n = 50
    // Wiggly-but-net-climbing profile spanning several km splits.
    const ele = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 3) * 30 + i * 2)
    const t = track({ n, ele })
    const splits = computeKmSplits(t)

    const totalAscent = splits.reduce((s, sp) => s + sp.ascent, 0)
    const totalDescent = splits.reduce((s, sp) => s + sp.descent, 0)

    const smoothed = smoothElevation(Float32Array.from(ele), 5)
    const expected = computeGainLoss(smoothed, 5)

    // Splits (unlike grade segments) always partition the whole track with
    // no gaps, so this should hold up to per-split rounding for any track
    // (each split's ascent/descent is independently Math.round()-ed, worst
    // case ~0.5m of error each).
    expect(Math.abs(totalAscent - expected.gain)).toBeLessThanOrEqual(splits.length)
    expect(Math.abs(totalDescent - expected.loss)).toBeLessThanOrEqual(splits.length)
  })

  it('honours statsOptions threshold: a looser threshold accumulates at least as much ascent as a stricter one', () => {
    const n = 40
    const ele = Array.from({ length: n }, (_, i) => 100 + i * 2 + (i % 2 === 0 ? 6 : -3))
    const t = track({ n, ele })

    const loose = computeKmSplits(t, undefined, undefined, { threshold: 2, smoothWindow: 1 })
    const strict = computeKmSplits(t, undefined, undefined, { threshold: 20, smoothWindow: 1 })

    const looseAscent = loose.reduce((s, sp) => s + sp.ascent, 0)
    const strictAscent = strict.reduce((s, sp) => s + sp.ascent, 0)
    expect(looseAscent).toBeGreaterThan(strictAscent)
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
