import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTrack, type Track, type TrackMeta } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import { parseGpx } from '../../src/core/parsers/gpx'
import { parseFit } from '../../src/core/parsers/fit'
import { calculateSpi, computePerformance, type PerformanceResult } from '../../src/core/perf/score'

function meta(name: string, kindOverride?: 'recorded' | 'planned' | 'uncertain'): TrackMeta {
  return { name, format: 'gpx', fileName: `${name}.gpx`, kindOverride }
}

function track(opts: {
  n: number
  ele?: number[]
  time?: number[]
  step?: number
  kindOverride?: 'recorded' | 'planned' | 'uncertain'
}): Track {
  const step = opts.step ?? 0.001
  const lon = Array.from({ length: opts.n }, (_, i) => 116 + i * step)
  const lat = Array.from({ length: opts.n }, () => 39)
  const t = createTrack(
    { lon, lat, ele: opts.ele, time: opts.time },
    meta('x', opts.kindOverride),
  )
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

// A realistic-ish scoreable track: steady climb + jittery (non-uniform)
// timestamps, long enough to also classify as `recorded` WITHOUT an
// override, so the "applicable" tests below also incidentally exercise the
// natural trackKind gate, not just the override path.
function scoreableTrack(n = 300): Track {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.0005)
  const lat = Array.from({ length: n }, () => 39.9)
  // First half climbs (+3m/point), second half descends (-2m/point) -- a
  // real up-then-down profile so P0's threshold-hysteresis reports BOTH
  // nonzero gain and nonzero loss (a purely monotonic profile could report
  // zero loss, which would make kmEffortV2 == kmEffort and defeat the point
  // of this fixture).
  const half = Math.floor(n / 2)
  const ele = Array.from({ length: n }, (_, i) => (i <= half ? 1000 + i * 3 : 1000 + half * 3 - (i - half) * 2))
  // Jittery 4-6s deltas -> non-uniform interval, plausible speed -> recorded.
  const time: number[] = [0]
  for (let i = 1; i < n; i++) time.push(time[i - 1] + (4000 + (i % 3) * 1000))
  const t = createTrack({ lon, lat, ele, time }, meta('scoreable'))
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

describe('calculateSpi (power-law formula, dual-anchor regression)', () => {
  it('flat anchor: 92km / 186m D+ (assumed D- = D+, undocumented in the reference), 12.75h -> in the ~366 (中等) neighbourhood', () => {
    // scoring_v4.js's own header comment states this anchor WITHOUT a
    // descent figure. "Flat" routes are typically loops/out-and-back with
    // D- close to D+, so we assume D- = D+ = 186m (a documented assumption
    // of this test, not a value taken from the reference) and assert a
    // tolerance band around the cited ~366, not a false-precision exact
    // value the reference itself doesn't give us either.
    const kmeV2 = 92 + 186 / 100 + 186 / 150
    const result = calculateSpi(kmeV2, 12.75, 1.0)
    expect(result).toBeDefined()
    expect(result!.score).toBeGreaterThan(340)
    expect(result!.score).toBeLessThan(400)
    expect(result!.level).toBe('中等')
  })

  it('mountain anchor: UTMB 170km / 10000m D+ / 10000m D- (explicit in the reference), 20h -> caps at exactly 1000 (精英级)', () => {
    const kmeV2 = 170 + 10000 / 100 + 10000 / 150
    const result = calculateSpi(kmeV2, 20, 1.0)
    expect(result).toEqual({ score: 1000, level: '精英级' })
  })

  it('is monotonically increasing in speed (kme/hours) for a fixed envFactor', () => {
    const slow = calculateSpi(50, 10, 1.0)!
    const fast = calculateSpi(50, 5, 1.0)!
    expect(fast.score).toBeGreaterThan(slow.score)
  })

  it('scales with envFactor', () => {
    const neutral = calculateSpi(50, 10, 1.0)!
    const penalised = calculateSpi(50, 10, 1.1)!
    expect(penalised.score).toBeGreaterThan(neutral.score)
  })

  it('returns undefined for non-positive kme or hours (degenerate input)', () => {
    expect(calculateSpi(0, 10, 1.0)).toBeUndefined()
    expect(calculateSpi(-5, 10, 1.0)).toBeUndefined()
    expect(calculateSpi(50, 0, 1.0)).toBeUndefined()
    expect(calculateSpi(50, -1, 1.0)).toBeUndefined()
  })

  it('level thresholds match the reference exactly at their boundaries', () => {
    // Solve kme/hours so that C*(speed)^K lands exactly on each threshold.
    const speedFor = (score: number) => (score / 30.0) ** (1 / 1.25)
    expect(calculateSpi(speedFor(700) * 10, 10, 1.0)!.level).toBe('精英级')
    expect(calculateSpi(speedFor(500) * 10, 10, 1.0)!.level).toBe('优秀')
    expect(calculateSpi(speedFor(380) * 10, 10, 1.0)!.level).toBe('良好')
    expect(calculateSpi(speedFor(200) * 10, 10, 1.0)!.level).toBe('中等')
    expect(calculateSpi(speedFor(10) * 10, 10, 1.0)!.level).toBe('入门')
  })
})

describe('computePerformance: cannot-score gates', () => {
  it('refuses a track classified planned', () => {
    // No time column at all -> auto-classifies planned.
    const t = track({ n: 50, ele: Array.from({ length: 50 }, (_, i) => 100 + i) })
    const r = computePerformance(t)
    expect(r.applicable).toBe(false)
    expect((r as { reason: string }).reason).toBe('planned')
  })

  it('refuses a track classified uncertain', () => {
    const t = track({ n: 1, kindOverride: 'uncertain', ele: [100], time: [0] })
    const r = computePerformance(t)
    expect(r.applicable).toBe(false)
    expect((r as { reason: string }).reason).toBe('uncertain')
  })

  it('refuses a track with no elevation column (even though override forces recorded)', () => {
    const n = 50
    const t = track({ n, kindOverride: 'recorded', time: Array.from({ length: n }, (_, i) => i * 5000) })
    const r = computePerformance(t)
    expect(r.applicable).toBe(false)
    expect((r as { reason: string }).reason).toBe('no-elevation')
  })

  it('refuses a track with no time column (even though override forces recorded)', () => {
    const n = 50
    const t = track({ n, kindOverride: 'recorded', ele: Array.from({ length: n }, (_, i) => 100 + i) })
    const r = computePerformance(t)
    expect(r.applicable).toBe(false)
    expect((r as { reason: string }).reason).toBe('no-time')
  })

  it('refuses a single-point track (override forces recorded, so this exercises the point-count gate specifically)', () => {
    const t = track({ n: 1, kindOverride: 'recorded', ele: [100], time: [0] })
    const r = computePerformance(t)
    expect(r.applicable).toBe(false)
    expect((r as { reason: string }).reason).toBe('insufficient-points')
  })
})

describe('computePerformance: applicable path', () => {
  it('produces a full PerformanceResult on a scoreable track', () => {
    const t = scoreableTrack()
    const r = computePerformance(t)
    expect(r.applicable).toBe(true)
    const result = r as PerformanceResult
    expect(Number.isFinite(result.spiScore)).toBe(true)
    expect(result.spiScore).toBeGreaterThanOrEqual(0)
    expect(result.spiScore).toBeLessThanOrEqual(1000)
    expect(result.spiRawScore).toBeGreaterThanOrEqual(0)
    expect(result.kmEffortV2).toBeGreaterThan(result.kmEffort) // descent term adds on top
    expect(result.totalAscentM).toBeGreaterThan(0)
    expect(result.gap.gap.length).toBe(t.points.lon.length)
    expect(result.splits.length).toBeGreaterThan(0)
    expect(result.gradeSegments.length).toBeGreaterThan(0)
  })

  it('totalAscentM/totalDescentM match core/stats/elevation.ts#computeGainLoss on the same statsOptions (P2 §3.2 divergence)', async () => {
    const { smoothElevation, computeGainLoss } = await import('../../src/core/stats/elevation')
    const t = scoreableTrack()
    const opts = { threshold: 5, smoothWindow: 5 }
    const r = computePerformance(t, opts) as PerformanceResult
    const smoothed = smoothElevation(t.points.ele!, opts.smoothWindow)
    const expected = computeGainLoss(smoothed, opts.threshold)
    expect(r.totalAscentM).toBeCloseTo(expected.gain, 6)
    expect(r.totalDescentM).toBeCloseTo(expected.loss, 6)
  })

  it('memoises per Track+statsOptions identity (WeakMap): same inputs return the exact cached object', () => {
    const t = scoreableTrack()
    const a = computePerformance(t, { threshold: 5, smoothWindow: 5 })
    const b = computePerformance(t, { threshold: 5, smoothWindow: 5 })
    expect(b).toBe(a)
  })

  it('recomputes when statsOptions change even though the Track did not', () => {
    const t = scoreableTrack()
    const a = computePerformance(t, { threshold: 5, smoothWindow: 5 }) as PerformanceResult
    const b = computePerformance(t, { threshold: 8, smoothWindow: 5 }) as PerformanceResult
    expect(b).not.toBe(a)
  })

  it('splits ascent/descent sum to totalAscentM/totalDescentM (P2 Q2 commit 1: climbs/splits routed through the same P0 hysteresis as the track total)', () => {
    const t = scoreableTrack()
    const r = computePerformance(t) as PerformanceResult
    const splitAscent = r.splits.reduce((s, sp) => s + sp.ascent, 0)
    const splitDescent = r.splits.reduce((s, sp) => s + sp.descent, 0)
    // Splits always partition the whole track with no gaps, so this holds up
    // to per-split rounding error (each split's ascent/descent is
    // independently Math.round()-ed, worst case ~0.5m of error each).
    expect(Math.abs(splitAscent - r.totalAscentM)).toBeLessThanOrEqual(r.splits.length)
    expect(Math.abs(splitDescent - r.totalDescentM)).toBeLessThanOrEqual(r.splits.length)
  })

  it('recomputes when the environmental profile changes even though the Track/statsOptions did not', () => {
    const t = scoreableTrack()
    const a = computePerformance(t, {}, {}) as PerformanceResult
    const b = computePerformance(t, {}, { temperature: 30 }) as PerformanceResult
    expect(b).not.toBe(a)
    expect(b.envCompensation.heatFactor).toBeGreaterThan(a.envCompensation.heatFactor)
  })
})

// ---- Real recordings (P2 §3.2 milestone Q2 acceptance) -------------------
//
// Reports PI for the real COROS recordings using TrailCraft's P0 ascent, and
// (for comparison, using a from-scratch re-implementation of the reference's
// OWN smoother.js/enricher.js dead-zone accumulator -- NOT TrailCraft's
// smoothElevation/computeGainLoss, whose "window" parameter has different
// units, see the helper below) using the reference's own ascent algorithm.
// Both sets of numbers are printed for the milestone report; only loose
// invariants are asserted here (finite, in-range, monotonic with effort) to
// avoid pinning brittle exact values.

const dataDir = process.env.TRAILCRAFT_TESTDATA ?? 'C:/Users/Administrator/Desktop/越野跑地图软件开发/测试'
const suppDir = join(dataDir, '补充测试轨迹数据')

function bufFrom(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

/**
 * Re-implementation of the reference's OWN ascent/descent algorithm
 * (`processing/smoother.js#smoothElevation` + `enricher.js`'s dead-zone
 * accumulator), for the "what would the reference itself have reported"
 * comparison column below. Deliberately NOT reusing TrailCraft's
 * `core/stats/elevation.ts#smoothElevation` -- that function's `window`
 * parameter is a TOTAL window size (`window=5` -> 2 points each side), while
 * the reference's `SMOOTH_WINDOW=5` is one-SIDED (-> 11-point total window)
 * -- reusing TrailCraft's function with the same numeral "5" would silently
 * compare against the wrong window size, not an honest "reference's own way".
 */
function referenceStyleAscentDescent(ele: Float32Array): { ascent: number; descent: number } {
  const REF_SMOOTH_WINDOW = 5 // one-sided, matching smoother.js
  const REF_DEAD_ZONE = 2 // metres, matching smoother.js's ELEVATION_DEAD_ZONE
  const n = ele.length
  const smoothed = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - REF_SMOOTH_WINDOW)
    const hi = Math.min(n - 1, i + REF_SMOOTH_WINDOW)
    let sum = 0
    let count = 0
    for (let j = lo; j <= hi; j++) {
      if (Number.isFinite(ele[j])) { sum += ele[j]; count++ }
    }
    smoothed[i] = count > 0 ? sum / count : NaN
  }
  let ascent = 0
  let descent = 0
  let ref: number | undefined
  for (let i = 0; i < n; i++) {
    const e = smoothed[i]
    if (!Number.isFinite(e)) continue
    if (ref === undefined) { ref = e; continue }
    const diff = e - ref
    if (Math.abs(diff) >= REF_DEAD_ZONE) {
      if (diff > 0) ascent += diff
      else descent += Math.abs(diff)
      ref = e
    }
  }
  return { ascent, descent }
}

function computeReferenceStylePI(t: Track): number | undefined {
  const ele = t.points.ele
  const time = t.points.time
  const cumDist = t.points.cumDist
  if (!ele || !time || !cumDist || cumDist.length < 2) return undefined
  const { ascent, descent } = referenceStyleAscentDescent(ele)
  const distKm = cumDist[cumDist.length - 1] / 1000
  let t0: number | undefined
  for (let i = 0; i < time.length; i++) { if (Number.isFinite(time[i])) { t0 = time[i]; break } }
  let tN: number | undefined
  for (let i = time.length - 1; i >= 0; i--) { if (Number.isFinite(time[i])) { tN = time[i]; break } }
  if (t0 === undefined || tN === undefined) return undefined
  const hours = (tN - t0) / 1000 / 3600
  const kmeV2 = distKm + ascent / 100 + descent / 150
  return calculateSpi(kmeV2, hours, 1.0)?.score
}

describe.skipIf(!existsSync(dataDir))('computePerformance on real recordings', () => {
  it('reports PI (TrailCraft ascent) and reference-style PI for every real GPX/FIT recording, both finite and in [0,1000]', async () => {
    const gpxFiles = [
      '468分张家口市越野跑20240713070047.gpx',
      '620崇礼68 20240712170018.gpx',
      '690分20240921065926.gpx',
      '北京市_越野跑20240501063333.gpx',
      '台州市_越野跑20251101053012.gpx',
      '大五台9个半20240615055824.gpx',
      '张家口市_越野跑20250823055934.gpx',
      '越野跑20250825235135.gpx',
      '越野跑20250912200059.gpx',
      '速攀129新望京20240912160539.gpx',
    ]
    const fitFiles = ['张家口市_越野跑20260710080013.fit', '张家口市_越野跑20260725084217.fit']

    const rows: { file: string; distKm: number; trailcraft: number | undefined; reference: number | undefined }[] = []

    for (const f of gpxFiles) {
      const p = join(dataDir, f)
      if (!existsSync(p)) continue
      const xml = readFileSync(p, 'utf-8')
      const t = parseGpx(xml, f)
      t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
      t.meta.kindOverride = 'recorded' // real recordings; don't depend on trackKind heuristics here
      const r = computePerformance(t)
      const trailcraft = r.applicable ? r.spiScore : undefined
      const reference = computeReferenceStylePI(t)
      rows.push({ file: f, distKm: t.points.cumDist[t.points.cumDist.length - 1] / 1000, trailcraft, reference })
    }

    const fitDir = existsSync(suppDir) ? suppDir : dataDir
    for (const f of fitFiles) {
      const p = join(fitDir, f)
      if (!existsSync(p)) continue
      const buf = readFileSync(p)
      const t = await parseFit(bufFrom(buf), f)
      t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
      t.meta.kindOverride = 'recorded'
      const r = computePerformance(t)
      const trailcraft = r.applicable ? r.spiScore : undefined
      const reference = computeReferenceStylePI(t)
      rows.push({ file: f, distKm: t.points.cumDist[t.points.cumDist.length - 1] / 1000, trailcraft, reference })
    }

    expect(rows.length).toBeGreaterThan(0)

    // eslint-disable-next-line no-console
    console.log('\n[P2 Q2] Real-recording PI comparison (TrailCraft P0 ascent vs reference-style ascent):')
    for (const row of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${row.file.padEnd(40)} ${row.distKm.toFixed(1).padStart(6)}km  trailcraft=${String(row.trailcraft).padStart(4)}  reference=${String(row.reference).padStart(4)}`,
      )
    }

    for (const row of rows) {
      expect(row.trailcraft, row.file).toBeDefined()
      expect(row.trailcraft!).toBeGreaterThanOrEqual(0)
      expect(row.trailcraft!).toBeLessThanOrEqual(1000)
    }

    // Every real trail effort must not score lower than a trivially short,
    // slow one -- a deliberately minimal baseline (~1km at a ~1.5km/h crawl,
    // negligible elevation change), NOT a pairwise comparison between two
    // arbitrary real recordings (real files vary in the runner's own pace/
    // fitness, so "longest real file" is not guaranteed to out-score
    // "shortest real file" -- effort, not raw distance, drives PI).
    const trivialN = 10
    const trivialLon = Array.from({ length: trivialN }, (_, i) => 116 + i * 0.001)
    const trivialLat = Array.from({ length: trivialN }, () => 39)
    const trivialEle = Array.from({ length: trivialN }, () => 500)
    const trivialTime = Array.from({ length: trivialN }, (_, i) => i * 267_000) // ~40 min total
    const trivial = createTrack(
      { lon: trivialLon, lat: trivialLat, ele: trivialEle, time: trivialTime },
      meta('trivial', 'recorded'),
    )
    trivial.points.cumDist = computeCumDist(trivial.points.lon, trivial.points.lat)
    const trivialResult = computePerformance(trivial)
    expect(trivialResult.applicable).toBe(true)
    const trivialScore = (trivialResult as PerformanceResult).spiScore

    for (const row of rows) {
      expect(row.trailcraft!, `${row.file} should score >= the trivial short/slow baseline (${trivialScore})`)
        .toBeGreaterThanOrEqual(trivialScore)
    }
  }, 120_000)
})
