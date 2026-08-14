import { describe, it, expect } from 'vitest'
import {
  computeKmEffortV2,
  segmentLengthKm,
  segmentCount,
  computeQuickSplits,
} from '../../src/core/perf/quickCalc'
import type { PaceParams } from '../../src/core/pace/models'
import { RACE_PRESETS, RACE_PRESET_CATEGORIES } from '../../src/core/perf/racePresets'

const basePaceParams: PaceParams = {
  model: 'practical',
  flatPaceSecPerKm: 360,
  vamMPerH: 600,
  descentFactor: 0.25,
  fatiguePctPerHour: 3,
}

describe('computeKmEffortV2', () => {
  it('matches the documented v2 formula', () => {
    expect(computeKmEffortV2(100, 5000, 5000)).toBeCloseTo(100 + 50 + 33.333, 2)
  })

  it('zero ascent/descent reduces to plain distance', () => {
    expect(computeKmEffortV2(42, 0, 0)).toBe(42)
  })

  it('zero distance with ascent is not NaN', () => {
    expect(computeKmEffortV2(0, 1000, 0)).toBeCloseTo(10, 6)
    expect(Number.isNaN(computeKmEffortV2(0, 1000, 0))).toBe(false)
  })
})

describe('segmentLengthKm', () => {
  it('uses 5 km segments at and below the 50 km cutover', () => {
    expect(segmentLengthKm(50)).toBe(5)
    expect(segmentLengthKm(30)).toBe(5)
    expect(segmentLengthKm(5)).toBe(5)
  })

  it('uses 10 km segments above the 50 km cutover', () => {
    expect(segmentLengthKm(50.1)).toBe(10)
    expect(segmentLengthKm(100)).toBe(10)
    expect(segmentLengthKm(210)).toBe(10)
  })
})

describe('segmentCount', () => {
  it('never returns 0 for a positive distance, however small', () => {
    expect(segmentCount(0.5)).toBeGreaterThanOrEqual(1)
    expect(segmentCount(3)).toBeGreaterThanOrEqual(1)
  })

  it('returns 0 for non-positive distance', () => {
    expect(segmentCount(0)).toBe(0)
    expect(segmentCount(-5)).toBe(0)
  })

  it('rounds to the nearest whole segment at the chosen resolution', () => {
    expect(segmentCount(57)).toBe(6) // 57/10 = 5.7 -> 6
    expect(segmentCount(30)).toBe(6) // 30/5 = 6
    expect(segmentCount(100)).toBe(10) // 100/10 = 10
  })

  it('every race preset yields a sensible segment count (1..30)', () => {
    for (const p of RACE_PRESETS) {
      const n = segmentCount(p.dist)
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(30)
    }
  })
})

describe('computeQuickSplits', () => {
  it('segment times sum to the entered finish time', () => {
    const finishTimeSec = 20 * 3600 // 20h
    const splits = computeQuickSplits(100, 5000, 5000, finishTimeSec, basePaceParams)
    const sum = splits.reduce((a, s) => a + s.segmentTimeSec, 0)
    expect(sum).toBeCloseTo(finishTimeSec, 3)
  })

  it('cumulative times are monotonically increasing and match the running sum', () => {
    const splits = computeQuickSplits(100, 5000, 5000, 20 * 3600, basePaceParams)
    let running = 0
    for (const s of splits) {
      running += s.segmentTimeSec
      expect(s.cumulativeTimeSec).toBeCloseTo(running, 6)
    }
    for (let i = 1; i < splits.length; i++) {
      expect(splits[i].cumulativeTimeSec).toBeGreaterThan(splits[i - 1].cumulativeTimeSec)
    }
  })

  it('later segments are slower than an equivalent earlier segment under non-zero fatigue', () => {
    // A flat course (equal ascent/descent per segment) isolates the fatigue
    // effect: with fatiguePctPerHour > 0, later splits must take longer.
    const p: PaceParams = { ...basePaceParams, fatiguePctPerHour: 5 }
    const splits = computeQuickSplits(100, 0, 0, 15 * 3600, p)
    for (let i = 1; i < splits.length; i++) {
      expect(splits[i].segmentTimeSec).toBeGreaterThan(splits[i - 1].segmentTimeSec)
    }
  })

  it('zero fatigue on a flat course gives (near-)equal segment times', () => {
    const p: PaceParams = { ...basePaceParams, fatiguePctPerHour: 0 }
    const splits = computeQuickSplits(100, 0, 0, 10 * 3600, p)
    const first = splits[0].segmentTimeSec
    for (const s of splits) expect(s.segmentTimeSec).toBeCloseTo(first, 6)
  })

  it('ascent distributed evenly means every split carries the same share', () => {
    const splits = computeQuickSplits(100, 5000, 0, 15 * 3600, basePaceParams)
    const n = splits.length
    for (const s of splits) expect(s.ascentM).toBeCloseTo(5000 / n, 6)
  })

  it('degenerate: zero distance returns no splits', () => {
    expect(computeQuickSplits(0, 500, 500, 3600, basePaceParams)).toEqual([])
  })

  it('degenerate: zero finish time returns no splits', () => {
    expect(computeQuickSplits(50, 500, 500, 0, basePaceParams)).toEqual([])
  })

  it('degenerate: ascent but no distance returns no splits, no NaN thrown', () => {
    const splits = computeQuickSplits(0, 2000, 0, 3600, basePaceParams)
    expect(splits).toEqual([])
  })

  it('a degenerate all-zero pace model falls back to flat division without NaN', () => {
    const zeroPace: PaceParams = { flatPaceSecPerKm: 0, vamMPerH: 1, descentFactor: 0, fatiguePctPerHour: 0 }
    const finishTimeSec = 10 * 3600
    const splits = computeQuickSplits(50, 0, 0, finishTimeSec, zeroPace)
    expect(splits.length).toBeGreaterThan(0)
    for (const s of splits) {
      expect(Number.isFinite(s.segmentTimeSec)).toBe(true)
      expect(Number.isFinite(s.cumulativeTimeSec)).toBe(true)
    }
    const sum = splits.reduce((a, s) => a + s.segmentTimeSec, 0)
    expect(sum).toBeCloseTo(finishTimeSec, 3)
  })

  it('negative ascent/descent inputs are clamped to zero, not propagated', () => {
    const splits = computeQuickSplits(50, -100, -100, 10 * 3600, basePaceParams)
    for (const s of splits) {
      expect(s.ascentM).toBeGreaterThanOrEqual(0)
      expect(s.descentM).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('racePresets', () => {
  it('has 39 entries across exactly 3 categories', () => {
    expect(RACE_PRESETS.length).toBe(39)
    expect(RACE_PRESET_CATEGORIES).toEqual(['国际经典', '中国经典', '按距离'])
    const cats = new Set(RACE_PRESETS.map((p) => p.category))
    expect(cats.size).toBe(3)
    for (const c of cats) expect(RACE_PRESET_CATEGORIES).toContain(c)
  })

  it('every preset has positive distance and non-negative ascent', () => {
    for (const p of RACE_PRESETS) {
      expect(p.dist).toBeGreaterThan(0)
      expect(p.elev).toBeGreaterThanOrEqual(0)
    }
  })
})
