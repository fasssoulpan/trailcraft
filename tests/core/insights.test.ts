import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import type { CheckPoint } from '../../src/core/model/checkpoint'
import type { KmSplit } from '../../src/core/perf/splits'
import type { GradeSegment } from '../../src/core/perf/climbs'
import type { SensorCoverageStat, SensorCoverageSummary } from '../../src/core/perf/sensorCoverage'
import { computeSensorCoverage } from '../../src/core/perf/sensorCoverage'
import {
  deriveInsights,
  computeActualCutoffMargins,
  deriveInsightsForTrack,
  type InsightsInput,
  type CutoffMarginEvidence,
} from '../../src/core/perf/insights'

// ── Fixture builders ────────────────────────────────────────────────────
// Every field defaults to a "produces no insight" value so each test only
// has to override the handful of fields its own threshold cares about.

function split(km: number, overrides: Partial<KmSplit> = {}): KmSplit {
  return {
    km,
    distance: 1000,
    time: undefined,
    pace: undefined,
    gap: undefined,
    ascent: 0,
    descent: 0,
    avgHR: undefined,
    avgGrade: 0,
    ...overrides,
  }
}

function gradeSeg(overrides: Partial<GradeSegment> & { startDist: number; endDist: number }): GradeSegment {
  const { startDist, endDist } = overrides
  return {
    type: 'uphill',
    distance: endDist - startDist,
    time: undefined,
    ascent: 0,
    descent: 0,
    avgGrade: 10,
    avgPace: undefined,
    avgHR: undefined,
    ...overrides,
  }
}

const ABSENT_STAT: SensorCoverageStat = { present: false, totalCount: 0, validCount: 0, coverage: 0 }

function sensorSummary(overrides: Partial<SensorCoverageSummary> = {}): SensorCoverageSummary {
  return { hr: ABSENT_STAT, cadence: ABSENT_STAT, power: ABSENT_STAT, temperature: ABSENT_STAT, ...overrides }
}

function presentStat(validCount: number, totalCount: number): SensorCoverageStat {
  const coverage = totalCount > 0 ? validCount / totalCount : 0
  return { present: true, totalCount, validCount, coverage, ...(validCount > 0 ? { min: 0, max: 1, mean: 0.5 } : {}) }
}

function baseInput(overrides: Partial<InsightsInput> = {}): InsightsInput {
  return {
    totalDistanceM: 0,
    totalTimeS: 0,
    splits: [],
    gradeSegments: [],
    sensorCoverage: sensorSummary(),
    cutoffMargins: [],
    ...overrides,
  }
}

// ===========================================================================
// 1. late_pace_decay
// ===========================================================================

describe('deriveInsights: late_pace_decay', () => {
  // 6 splits (the minimum), gap only populated on the first/last 2 (the
  // thirds actually compared) -- the middle 2 are irrelevant noise on
  // purpose, mirroring how a real track's middle splits may be missing GAP.
  function splitsWithDecay(firstGap: number, lastGap: number): KmSplit[] {
    return [
      split(1, { gap: firstGap }),
      split(2, { gap: firstGap }),
      split(3, {}),
      split(4, {}),
      split(5, { gap: lastGap }),
      split(6, { gap: lastGap }),
    ]
  }

  it('fires at exactly the 15% threshold', () => {
    const out = deriveInsights(baseInput({ splits: splitsWithDecay(1000, 1150) }))
    const insight = out.find((i) => i.id === 'late_pace_decay')
    expect(insight).toBeDefined()
    expect(insight!.evidence.decayPct).toBeCloseTo(15, 5)
    expect(insight!.evidence.meanFirstGapSecPerKm).toBeCloseTo(1000, 5)
    expect(insight!.evidence.meanLastGapSecPerKm).toBeCloseTo(1150, 5)
    expect(insight!.text).toContain('15%')
  })

  it('does not fire just below the threshold', () => {
    const out = deriveInsights(baseInput({ splits: splitsWithDecay(1000, 1149) }))
    expect(out.find((i) => i.id === 'late_pace_decay')).toBeUndefined()
  })

  it('does not fire with fewer than 6 splits, even with a huge decay', () => {
    const splits = splitsWithDecay(1000, 2000).slice(0, 5)
    const out = deriveInsights(baseInput({ splits }))
    expect(out.find((i) => i.id === 'late_pace_decay')).toBeUndefined()
  })

  it('does not fire when a third has fewer than 2 GAP samples', () => {
    const splits = [
      split(1, { gap: 1000 }),
      split(2, {}), // only 1 valid gap in the first third
      split(3, {}),
      split(4, {}),
      split(5, { gap: 1150 }),
      split(6, { gap: 1150 }),
    ]
    const out = deriveInsights(baseInput({ splits }))
    expect(out.find((i) => i.id === 'late_pace_decay')).toBeUndefined()
  })
})

// ===========================================================================
// 2. costliest_climb
// ===========================================================================

describe('deriveInsights: costliest_climb', () => {
  const totalDistanceM = 100_000
  const totalTimeS = 36_000

  it('fires when the time/distance-share ratio clears 1.5x', () => {
    const seg = gradeSeg({ startDist: 10_000, endDist: 16_000, ascent: 400, time: 4_000 }) // 6% dist, 11.1% time -> ratio ~1.85
    const out = deriveInsights(baseInput({ totalDistanceM, totalTimeS, gradeSegments: [seg] }))
    const insight = out.find((i) => i.id === 'costliest_climb')
    expect(insight).toBeDefined()
    expect(insight!.evidence.startDistM).toBe(10_000)
    expect(insight!.evidence.endDistM).toBe(16_000)
    expect(insight!.evidence.ascentM).toBe(400)
    expect((insight!.evidence.ratio as number)).toBeGreaterThanOrEqual(1.5)
  })

  it('does not fire when the ratio is clearly below 1.5x', () => {
    const seg = gradeSeg({ startDist: 10_000, endDist: 16_000, ascent: 400, time: 2_500 }) // 6% dist, 6.9% time -> ratio ~1.16
    const out = deriveInsights(baseInput({ totalDistanceM, totalTimeS, gradeSegments: [seg] }))
    expect(out.find((i) => i.id === 'costliest_climb')).toBeUndefined()
  })

  it('does not fire when the climb is too short a share of distance (<3%), even with a huge ratio', () => {
    const seg = gradeSeg({ startDist: 0, endDist: 2_000, ascent: 100, time: 3_000 }) // 2% dist, ratio would be huge
    const out = deriveInsights(baseInput({ totalDistanceM, totalTimeS, gradeSegments: [seg] }))
    expect(out.find((i) => i.id === 'costliest_climb')).toBeUndefined()
  })

  it('ignores downhill/flat segments even if their ratio would qualify', () => {
    const seg = gradeSeg({ startDist: 10_000, endDist: 16_000, ascent: 0, descent: 400, time: 4_000, type: 'downhill' })
    const out = deriveInsights(baseInput({ totalDistanceM, totalTimeS, gradeSegments: [seg] }))
    expect(out.find((i) => i.id === 'costliest_climb')).toBeUndefined()
  })

  it('picks the single most extreme climb when several qualify', () => {
    const mild = gradeSeg({ startDist: 0, endDist: 6_000, ascent: 200, time: 2_500 }) // 6% dist, ~6.9% time -> ratio ~1.16 (below threshold anyway)
    const extreme = gradeSeg({ startDist: 20_000, endDist: 26_000, ascent: 500, time: 5_000 }) // 6% dist, 13.9% time -> ratio ~2.3
    const out = deriveInsights(baseInput({ totalDistanceM, totalTimeS, gradeSegments: [mild, extreme] }))
    const insight = out.find((i) => i.id === 'costliest_climb')
    expect(insight!.evidence.startDistM).toBe(20_000)
  })
})

// ===========================================================================
// 3. cutoff_margin_thin / cutoff_margin_missed
// ===========================================================================

describe('deriveInsights: cutoff margins', () => {
  it('missed: negative margin fires cutoff_margin_missed', () => {
    const margins: CutoffMarginEvidence[] = [{ cpName: 'CP3', marginSec: -1 }]
    const out = deriveInsights(baseInput({ cutoffMargins: margins }))
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('cutoff_margin_missed')
    expect(out[0].evidence.cpName).toBe('CP3')
    expect(out[0].evidence.marginSec).toBe(-1)
  })

  it('thin: fires just below the 1200s threshold', () => {
    const margins: CutoffMarginEvidence[] = [{ cpName: 'CP1', marginSec: 1199 }]
    const out = deriveInsights(baseInput({ cutoffMargins: margins }))
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('cutoff_margin_thin')
    expect(out[0].evidence.marginSec).toBe(1199)
  })

  it('does not fire at exactly the 1200s threshold (not thin) or above', () => {
    const margins: CutoffMarginEvidence[] = [
      { cpName: 'CP1', marginSec: 1200 },
      { cpName: 'CP2', marginSec: 3000 },
    ]
    const out = deriveInsights(baseInput({ cutoffMargins: margins }))
    expect(out).toHaveLength(0)
  })

  it('a margin of exactly 0 (arrived at the exact cutoff instant) counts as thin, not missed', () => {
    const margins: CutoffMarginEvidence[] = [{ cpName: 'CP1', marginSec: 0 }]
    const out = deriveInsights(baseInput({ cutoffMargins: margins }))
    expect(out[0].id).toBe('cutoff_margin_thin')
  })
})

// ===========================================================================
// 4. split_anomaly_slow / split_anomaly_fast
// ===========================================================================

describe('deriveInsights: split anomalies', () => {
  // 4 baseline splits at pace=240, 1 outlier -- distance kept at the 1000m
  // default so none get excluded by the trailing-short-split guard.
  function withOutlier(outlierPace: number): KmSplit[] {
    return [
      split(1, { pace: 240 }),
      split(2, { pace: 240 }),
      split(3, { pace: 240 }),
      split(4, { pace: 240 }),
      split(5, { pace: outlierPace }),
    ]
  }

  it('slow: fires when a split is far enough above the average pace', () => {
    // avg = (240*4+400)/5 = 264, dev = (400-264)/264*100 ~= 51.5% >= 30%
    const out = deriveInsights(baseInput({ splits: withOutlier(400) }))
    const insight = out.find((i) => i.id === 'split_anomaly_slow')
    expect(insight).toBeDefined()
    expect(insight!.evidence.km).toBe(5)
    expect(insight!.evidence.paceSecPerKm).toBe(400)
    expect((insight!.evidence.devPct as number)).toBeGreaterThanOrEqual(30)
  })

  it('fast: fires when a split is far enough below the average pace', () => {
    // avg = (240*4+100)/5 = 212, dev = (100-212)/212*100 ~= -52.8%
    const out = deriveInsights(baseInput({ splits: withOutlier(100) }))
    const insight = out.find((i) => i.id === 'split_anomaly_fast')
    expect(insight).toBeDefined()
    expect(insight!.evidence.km).toBe(5)
    expect(insight!.evidence.paceSecPerKm).toBe(100)
  })

  it('does not fire when the deviation is clearly below 30%', () => {
    // avg = (240*4+260)/5 = 244, dev = (260-244)/244*100 ~= 6.6%
    const out = deriveInsights(baseInput({ splits: withOutlier(260) }))
    expect(out.find((i) => i.id === 'split_anomaly_slow')).toBeUndefined()
    expect(out.find((i) => i.id === 'split_anomaly_fast')).toBeUndefined()
  })

  it('does not fire with fewer than 5 usable splits', () => {
    const out = deriveInsights(baseInput({ splits: withOutlier(400).slice(0, 4) }))
    expect(out.find((i) => i.id === 'split_anomaly_slow')).toBeUndefined()
  })

  it('excludes a trailing short split (<500m) from both the average and the anomaly scan', () => {
    const splits = [
      split(1, { pace: 240 }),
      split(2, { pace: 240 }),
      split(3, { pace: 240 }),
      split(4, { pace: 240 }),
      split(5, { pace: 240 }),
      split(6, { pace: 900, distance: 200 }), // trailing remainder, huge pace deviation but should be excluded
    ]
    const out = deriveInsights(baseInput({ splits }))
    expect(out.find((i) => i.id === 'split_anomaly_slow')).toBeUndefined()
    expect(out.find((i) => i.id === 'split_anomaly_fast')).toBeUndefined()
  })
})

// ===========================================================================
// 5. sensor_gap
// ===========================================================================

describe('deriveInsights: sensor_gap', () => {
  it('fires when a present sensor column has coverage clearly below 50%', () => {
    const out = deriveInsights(baseInput({ sensorCoverage: sensorSummary({ hr: presentStat(2, 20) }) }))
    const insight = out.find((i) => i.id === 'sensor_gap')
    expect(insight).toBeDefined()
    expect(insight!.evidence.sensor).toBe('hr')
    expect(insight!.evidence.validCount).toBe(2)
    expect(insight!.evidence.totalCount).toBe(20)
    expect(insight!.evidence.coveragePct).toBeCloseTo(10, 5)
  })

  it('does not fire at exactly 50% coverage', () => {
    const out = deriveInsights(baseInput({ sensorCoverage: sensorSummary({ hr: presentStat(5, 10) }) }))
    expect(out.find((i) => i.id === 'sensor_gap')).toBeUndefined()
  })

  it('does not fire when coverage is clearly above 50%', () => {
    const out = deriveInsights(baseInput({ sensorCoverage: sensorSummary({ hr: presentStat(9, 10) }) }))
    expect(out.find((i) => i.id === 'sensor_gap')).toBeUndefined()
  })

  it('does not fire for a column that is wholly absent, no matter how you slice it', () => {
    const out = deriveInsights(baseInput({ sensorCoverage: sensorSummary({ hr: ABSENT_STAT }) }))
    expect(out.find((i) => i.id === 'sensor_gap')).toBeUndefined()
  })

  it('reports a gap independently per column, in hr/cadence/power/temperature order', () => {
    const out = deriveInsights(
      baseInput({
        sensorCoverage: sensorSummary({
          hr: presentStat(2, 20), // low -> fires
          cadence: presentStat(18, 20), // high -> no fire
          power: ABSENT_STAT, // absent -> no fire
          temperature: presentStat(1, 20), // low -> fires
        }),
      }),
    )
    const gaps = out.filter((i) => i.id === 'sensor_gap')
    expect(gaps.map((g) => g.evidence.sensor)).toEqual(['hr', 'temperature'])
  })
})

// ===========================================================================
// 6. Empty / degenerate inputs never fabricate an insight and never throw
// ===========================================================================

describe('deriveInsights: empty / degenerate inputs', () => {
  it('a fully empty input yields an empty list', () => {
    expect(deriveInsights(baseInput())).toEqual([])
  })

  it('a single split does not throw and yields no split-based insights', () => {
    const out = deriveInsights(baseInput({ splits: [split(1, { gap: 1000, pace: 300 })] }))
    expect(out).toEqual([])
  })

  it('gradeSegments with no uphill segments does not throw and yields no climb insight', () => {
    const seg = gradeSeg({ startDist: 0, endDist: 6_000, type: 'downhill', descent: 300, time: 2_000 })
    const out = deriveInsights(baseInput({ totalDistanceM: 100_000, totalTimeS: 36_000, gradeSegments: [seg] }))
    expect(out.find((i) => i.id === 'costliest_climb')).toBeUndefined()
  })

  it('zero totalDistanceM/totalTimeS does not throw (climb detector bails out cleanly)', () => {
    const seg = gradeSeg({ startDist: 0, endDist: 100, ascent: 50, time: 60 })
    expect(() => deriveInsights(baseInput({ gradeSegments: [seg] }))).not.toThrow()
  })

  it('a climb segment with time=undefined does not throw and is skipped', () => {
    const seg = gradeSeg({ startDist: 0, endDist: 6_000, ascent: 400, time: undefined })
    const out = deriveInsights(baseInput({ totalDistanceM: 100_000, totalTimeS: 36_000, gradeSegments: [seg] }))
    expect(out.find((i) => i.id === 'costliest_climb')).toBeUndefined()
  })

  it('no cutoffs, no sensor data -> empty list, no throw', () => {
    expect(deriveInsights(baseInput({ cutoffMargins: [], sensorCoverage: sensorSummary() }))).toEqual([])
  })
})

// ===========================================================================
// 7. Fixed output order
// ===========================================================================

describe('deriveInsights: fixed output order', () => {
  it('emits in decay -> climb -> cutoff -> split anomaly -> sensor order when everything qualifies', () => {
    const splits: KmSplit[] = [
      split(1, { gap: 1000, pace: 100 }), // fast outlier
      split(2, { gap: 1000, pace: 240 }),
      split(3, { pace: 240 }),
      split(4, { pace: 240 }),
      split(5, { gap: 1150, pace: 240 }),
      split(6, { gap: 1150, pace: 400 }), // slow outlier
    ]
    const climbSeg = gradeSeg({ startDist: 20_000, endDist: 26_000, ascent: 500, time: 5_000 })
    const cutoffMargins: CutoffMarginEvidence[] = [
      { cpName: 'CP-missed', marginSec: -100 },
      { cpName: 'CP-thin', marginSec: 500 },
    ]
    const sensorCoverage = sensorSummary({ hr: presentStat(2, 20), temperature: presentStat(1, 20) })

    const out = deriveInsights({
      totalDistanceM: 100_000,
      totalTimeS: 36_000,
      splits,
      gradeSegments: [climbSeg],
      cutoffMargins,
      sensorCoverage,
    })

    expect(out.map((i) => i.id)).toEqual([
      'late_pace_decay',
      'costliest_climb',
      'cutoff_margin_missed',
      'cutoff_margin_thin',
      'split_anomaly_slow',
      'split_anomaly_fast',
      'sensor_gap',
      'sensor_gap',
    ])
    // The two sensor_gap entries must still be individually attributable.
    const sensorGaps = out.filter((i) => i.id === 'sensor_gap')
    expect(sensorGaps.map((g) => g.evidence.sensor)).toEqual(['hr', 'temperature'])
  })
})

// ===========================================================================
// 8. computeActualCutoffMargins
// ===========================================================================

function cp(overrides: Partial<CheckPoint> & { trackId: string }): CheckPoint {
  return {
    id: 'cp-' + Math.random().toString(36).slice(2),
    name: 'CP',
    kind: 'cp',
    anchorIndex: 0,
    ...overrides,
  }
}

function trackWithTime(time: (number | typeof NaN)[]): Track {
  const n = time.length
  const lon = Array.from({ length: n }, (_, i) => i * 0.001)
  const lat = Array.from({ length: n }, () => 39)
  return createTrack({ lon, lat, time }, { name: 't', format: 'gpx', fileName: 't.gpx' })
}

describe('computeActualCutoffMargins', () => {
  it('returns [] when the track has no time column', () => {
    const t = createTrack({ lon: [0, 1], lat: [0, 0] }, { name: 't', format: 'gpx', fileName: 't.gpx' })
    const cps = [cp({ trackId: t.id, cutoffTime: '2026-08-18T12:00:00+08:00' })]
    expect(computeActualCutoffMargins(t, cps)).toEqual([])
  })

  it('skips CPs belonging to a different track', () => {
    const t = trackWithTime([0, 60_000, 120_000])
    const cps = [cp({ trackId: 'other-track', anchorIndex: 1, cutoffTime: '2026-08-18T12:00:00+08:00' })]
    expect(computeActualCutoffMargins(t, cps)).toEqual([])
  })

  it('skips CPs with no cutoffTime', () => {
    const t = trackWithTime([0, 60_000, 120_000])
    const cps = [cp({ trackId: t.id, anchorIndex: 1 })]
    expect(computeActualCutoffMargins(t, cps)).toEqual([])
  })

  it('skips CPs with an unparseable cutoffTime', () => {
    const t = trackWithTime([0, 60_000, 120_000])
    const cps = [cp({ trackId: t.id, anchorIndex: 1, cutoffTime: 'not-a-date' })]
    expect(computeActualCutoffMargins(t, cps)).toEqual([])
  })

  it('computes a positive margin (arrived before cutoff) and a negative one (missed) from real arrival times', () => {
    // t=0 at epoch 2026-08-18T10:00:00+08:00, +1min/point
    const epoch = Date.parse('2026-08-18T10:00:00+08:00')
    const t = trackWithTime([epoch, epoch + 60_000, epoch + 120_000])
    const cps = [
      cp({ trackId: t.id, name: 'CP-early', anchorIndex: 1, cutoffTime: '2026-08-18T10:05:00+08:00' }), // arrival 10:01, 4min margin
      cp({ trackId: t.id, name: 'CP-late', anchorIndex: 2, cutoffTime: '2026-08-18T10:01:00+08:00' }), // arrival 10:02, -1min margin
    ]
    const margins = computeActualCutoffMargins(t, cps)
    expect(margins).toHaveLength(2)
    expect(margins[0]).toEqual({ cpName: 'CP-early', marginSec: 240 })
    expect(margins[1]).toEqual({ cpName: 'CP-late', marginSec: -60 })
  })

  it('clamps an out-of-range anchorIndex into the valid point range', () => {
    const epoch = Date.parse('2026-08-18T10:00:00+08:00')
    const t = trackWithTime([epoch, epoch + 60_000, epoch + 120_000])
    const cps = [cp({ trackId: t.id, anchorIndex: 999, cutoffTime: '2026-08-18T10:10:00+08:00' })]
    const margins = computeActualCutoffMargins(t, cps)
    expect(margins).toHaveLength(1)
    // clamped to the last point (epoch+120000), cutoff is 10 min after epoch
    expect(margins[0].marginSec).toBeCloseTo(10 * 60 - 120, 5)
  })

  it('skips a CP whose anchored point has a non-finite time reading', () => {
    const epoch = Date.parse('2026-08-18T10:00:00+08:00')
    const t = trackWithTime([epoch, NaN, epoch + 120_000])
    const cps = [cp({ trackId: t.id, anchorIndex: 1, cutoffTime: '2026-08-18T10:10:00+08:00' })]
    expect(computeActualCutoffMargins(t, cps)).toEqual([])
  })

  it('an empty CP list does not throw', () => {
    const t = trackWithTime([0, 60_000])
    expect(computeActualCutoffMargins(t, [])).toEqual([])
  })
})

// ===========================================================================
// 9. deriveInsightsForTrack (Track-facing entry point + its defensive gate)
// ===========================================================================

function recordedTrack(opts: {
  n: number
  ele?: number[]
  time?: number[]
  hr?: number[]
  step?: number
}): Track {
  const step = opts.step ?? 0.001 // ~111m/point at lat 39
  const lon = Array.from({ length: opts.n }, (_, i) => 116 + i * step)
  const lat = Array.from({ length: opts.n }, () => 39)
  const t = createTrack(
    { lon, lat, ele: opts.ele, time: opts.time, hr: opts.hr },
    { name: 'x', format: 'gpx', fileName: 'x.gpx' },
  )
  t.meta.kindOverride = 'recorded' // bypass classifyTrack's heuristics; we're testing insights, not classification
  return t
}

describe('deriveInsightsForTrack', () => {
  it('returns [] for a track explicitly marked as planned (the defensive gate)', () => {
    const t = recordedTrack({
      n: 20,
      ele: Array.from({ length: 20 }, () => 1500),
      time: Array.from({ length: 20 }, (_, i) => i * 60_000),
    })
    t.meta.kindOverride = 'planned'
    expect(deriveInsightsForTrack(t, {}, [])).toEqual([])
  })

  it('returns [] for a track explicitly marked as uncertain', () => {
    const t = recordedTrack({
      n: 20,
      ele: Array.from({ length: 20 }, () => 1500),
      time: Array.from({ length: 20 }, (_, i) => i * 60_000),
    })
    t.meta.kindOverride = 'uncertain'
    expect(deriveInsightsForTrack(t, {}, [])).toEqual([])
  })

  it('a single-point track does not throw and returns []', () => {
    const t = recordedTrack({ n: 1, ele: [1500], time: [0] })
    expect(() => deriveInsightsForTrack(t, {}, [])).not.toThrow()
    expect(deriveInsightsForTrack(t, {}, [])).toEqual([])
  })

  it('a track with no elevation column does not throw and returns []', () => {
    const t = recordedTrack({ n: 20, time: Array.from({ length: 20 }, (_, i) => i * 60_000) })
    expect(() => deriveInsightsForTrack(t, {}, [])).not.toThrow()
    expect(deriveInsightsForTrack(t, {}, [])).toEqual([])
  })

  it('a track with no time column does not throw and returns []', () => {
    const t = recordedTrack({ n: 20, ele: Array.from({ length: 20 }, () => 1500) })
    expect(() => deriveInsightsForTrack(t, {}, [])).not.toThrow()
    expect(deriveInsightsForTrack(t, {}, [])).toEqual([])
  })

  it('no checkpoints at all does not throw', () => {
    const t = recordedTrack({
      n: 20,
      ele: Array.from({ length: 20 }, () => 1500),
      time: Array.from({ length: 20 }, (_, i) => i * 60_000),
    })
    expect(() => deriveInsightsForTrack(t, {}, [])).not.toThrow()
  })

  it('a small applicable track with sparse hr readings surfaces a sensor_gap insight whose evidence matches computeSensorCoverage', () => {
    const n = 20
    const hr = Array.from({ length: n }, (_, i) => (i < 2 ? 120 : 0)) // 2/20 = 10% coverage
    const t = recordedTrack({
      n,
      ele: Array.from({ length: n }, () => 1500),
      time: Array.from({ length: n }, (_, i) => i * 60_000),
      hr,
    })
    const insights = deriveInsightsForTrack(t, {}, [])
    const trueCoverage = computeSensorCoverage(t.points)

    const gap = insights.find((i) => i.id === 'sensor_gap' && i.evidence.sensor === 'hr')
    expect(gap).toBeDefined()
    expect(gap!.evidence.validCount).toBe(trueCoverage.hr.validCount)
    expect(gap!.evidence.totalCount).toBe(trueCoverage.hr.totalCount)
    expect(gap!.evidence.coveragePct).toBeCloseTo(trueCoverage.hr.coverage * 100, 5)
  })

  it('a fully-covered hr column does not surface a sensor_gap insight', () => {
    const n = 20
    const t = recordedTrack({
      n,
      ele: Array.from({ length: n }, () => 1500),
      time: Array.from({ length: n }, (_, i) => i * 60_000),
      hr: Array.from({ length: n }, () => 130),
    })
    const insights = deriveInsightsForTrack(t, {}, [])
    expect(insights.find((i) => i.id === 'sensor_gap')).toBeUndefined()
  })
})
