/**
 * Calibration / fitting harness for the performance-score power-law model
 * (P2 Q2 commits 1-2). Run with `npx vite-node scripts/calibrate-perf.ts`.
 *
 * Two modes:
 *   `report` (default) -- evaluate the CURRENT shipped model (`score.ts`'s
 *     `calculateSpi`, i.e. whatever SPI_C/SPI_K/SPI_M are baked in right
 *     now) against the calibration table and TrailCraft's own real
 *     recordings, and print residuals + the three structural checks from
 *     the P2 Q2 brief. Before commit 2 this is the "here's the bug,
 *     measured" report; after commit 2 it's the "here's the fix, verified"
 *     report -- same code, different constants.
 *   `fit` -- numerically fit C/K/M against the calibration table (see
 *     "Fitting method" below) and print the result. This is where the
 *     actual numbers that get hand-transcribed into score.ts come from --
 *     score.ts intentionally does NOT import this file or run this search
 *     at runtime (P2 Q2 brief: "Implement the fit in the script, not in the
 *     shipped code").
 *
 * ── Fitting method ─────────────────────────────────────────────────────────
 * The model has 3 free parameters (C, K, M) but the calibration table has
 * only 2 rows with a genuinely independently-published `expectedScore` (the
 * reference's own dual anchors -- see calibration.ts's header for why the
 * 崇礼168 rows deliberately do NOT carry a fabricated `expectedScore`). Two
 * points exactly determine 2 unknowns, so for ANY fixed M, log(C) and K can
 * be solved exactly (a weighted least-squares fit in log space, which
 * degenerates to exact interpolation for exactly 2 positive-weight rows, but
 * generalises correctly if the user adds more `expectedScore` rows later --
 * P2 Q2 brief: "weighting rows by confidence").
 *
 * That leaves M as the one genuinely free parameter, and nothing in the
 * anchor pair can pin it down (M's whole job is to distinguish races of
 * different LENGTH at the same speed, and both anchors are long-distance).
 * So M is chosen by a 1-D search that minimises a STRUCTURAL penalty built
 * from the three checks the P2 Q2 brief says are "defensible without any
 * published number":
 *   1. no 崇礼168 category winner should approach the 1000 cap
 *   2. the 5 崇礼168 category-winner rows should land in a reasonably tight
 *      band of each other (comparable-calibre national elites)
 *   3. the real 13.9km recording must not outscore the real 167.7km one
 * This is genuinely empirical (the penalty is evaluated against real result
 * data, not asserted), but it's a different KIND of empirical from the
 * anchor fit -- flagged clearly in the printed report so nobody mistakes a
 * structural-penalty-chosen M for a residual-fit M.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTrack } from '../src/core/model/track'
import { computeCumDist } from '../src/core/geo/distance'
import { parseGpx } from '../src/core/parsers/gpx'
import { parseFit } from '../src/core/parsers/fit'
import { calculateSpi, computePerformance, type PerformanceResult } from '../src/core/perf/score'
import { CALIBRATION_TABLE, UTMB_KME_REF_V1, type CalibrationRow } from '../src/core/perf/calibration'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function kmeV2(row: CalibrationRow): number {
  return row.distanceKm + row.ascentM / 100 + row.descentM / 150
}

function fmt(n: number | undefined, digits = 1): string {
  return n === undefined ? '  --' : n.toFixed(digits)
}

// ---------------------------------------------------------------------------
// Real recordings (same 10 GPX + 2 FIT files as tests/core/score.test.ts's
// "real recordings" block -- kept as a separate literal list here rather
// than imported, so this script has no dependency on test-only code, but
// deliberately the SAME files so the two reports are directly comparable).
// ---------------------------------------------------------------------------

const dataDir = process.env.TRAILCRAFT_TESTDATA ?? 'C:/Users/Administrator/Desktop/越野跑地图软件开发/测试'
const suppDir = join(dataDir, '补充测试轨迹数据')

const GPX_FILES = [
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
const FIT_FILES = ['张家口市_越野跑20260710080013.fit', '张家口市_越野跑20260725084217.fit']

interface RealRecording {
  file: string
  distKm: number
  kmeV2: number
  hours: number
  /** `envCompensation.totalFactor` from the actual track (mostly altitude
   * compensation for these high-altitude routes -- see env.ts). Real
   * recordings carry their own real value here, UNLIKE the calibration
   * table's rows (see `structuralPenalty` below), because we actually have
   * the elevation profile to compute it from. */
  envFactor: number
}

function bufFrom(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

async function loadRealRecordings(): Promise<RealRecording[]> {
  if (!existsSync(dataDir)) return []
  const out: RealRecording[] = []

  for (const f of GPX_FILES) {
    const p = join(dataDir, f)
    if (!existsSync(p)) continue
    const xml = readFileSync(p, 'utf-8')
    const t = parseGpx(xml, f)
    t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
    t.meta.kindOverride = 'recorded'
    const r = computePerformance(t)
    if (!r.applicable) continue
    const res = r as PerformanceResult
    out.push({
      file: f,
      distKm: res.totalDistanceM / 1000,
      kmeV2: res.kmEffortV2,
      hours: res.totalTimeS / 3600,
      envFactor: res.envCompensation.totalFactor,
    })
  }

  const fitDir = existsSync(suppDir) ? suppDir : dataDir
  for (const f of FIT_FILES) {
    const p = join(fitDir, f)
    if (!existsSync(p)) continue
    const buf = readFileSync(p)
    const t = await parseFit(bufFrom(buf), f)
    t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
    t.meta.kindOverride = 'recorded'
    const r = computePerformance(t)
    if (!r.applicable) continue
    const res = r as PerformanceResult
    out.push({
      file: f,
      distKm: res.totalDistanceM / 1000,
      kmeV2: res.kmEffortV2,
      hours: res.totalTimeS / 3600,
      envFactor: res.envCompensation.totalFactor,
    })
  }

  return out
}

// A deliberately tiny, slow baseline -- same construction as the test
// file's "trivial" fixture -- for the "nothing real should score below this"
// sanity floor. Not part of the fit; just a report-time gut check.
function trivialBaselineKmeV2Hours(): { kmeV2: number; hours: number; envFactor: number } {
  const n = 10
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.001)
  const lat = Array.from({ length: n }, () => 39)
  const ele = Array.from({ length: n }, () => 500)
  const time = Array.from({ length: n }, (_, i) => i * 267_000)
  const t = createTrack({ lon, lat, ele, time }, { name: 'trivial', format: 'gpx', fileName: 'trivial.gpx', kindOverride: 'recorded' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  const r = computePerformance(t)
  if (!r.applicable) throw new Error('trivial baseline unexpectedly not applicable')
  const res = r as PerformanceResult
  return { kmeV2: res.kmEffortV2, hours: res.totalTimeS / 3600, envFactor: res.envCompensation.totalFactor }
}

// ---------------------------------------------------------------------------
// Candidate formula (mirrors score.ts's calculateSpi, generalised with an M
// term -- kept independent of score.ts so `fit` mode can search candidate
// constants without score.ts having to expose its private ones).
// ---------------------------------------------------------------------------

interface Params { C: number; K: number; M: number }

function rawScore(kme: number, hours: number, envFactor: number, p: Params): number {
  const speed = kme / hours
  return p.C * speed ** p.K * (kme / UTMB_KME_REF_V1) ** p.M * envFactor
}

function cappedScore(kme: number, hours: number, envFactor: number, p: Params): number {
  return Math.round(Math.min(rawScore(kme, hours, envFactor, p), 1000))
}

// ---------------------------------------------------------------------------
// Weighted log-linear solve for (C, K) given a fixed M, over every
// calibration row that carries an `expectedScore`.
// ---------------------------------------------------------------------------

const CONFIDENCE_WEIGHT: Record<CalibrationRow['confidence'], number> = {
  high: 1.0,
  medium: 0.5,
  low: 0.15,
}

function solveCK(rows: CalibrationRow[], M: number): { C: number; K: number } | undefined {
  const fitRows = rows.filter((r) => r.expectedScore !== undefined)
  if (fitRows.length < 2) return undefined

  let Sw = 0, Swx = 0, Swy = 0, Swxx = 0, Swxy = 0
  for (const row of fitRows) {
    const w = CONFIDENCE_WEIGHT[row.confidence]
    const kme = kmeV2(row)
    const x = Math.log(kme / row.hours)
    const y = Math.log(row.expectedScore!) - M * Math.log(kme / UTMB_KME_REF_V1)
    Sw += w; Swx += w * x; Swy += w * y; Swxx += w * x * x; Swxy += w * x * y
  }
  const denom = Sw * Swxx - Swx * Swx
  if (Math.abs(denom) < 1e-12) return undefined
  const K = (Sw * Swxy - Swx * Swy) / denom
  const logC = (Swy - K * Swx) / Sw
  return { C: Math.exp(logC), K }
}

// ---------------------------------------------------------------------------
// Structural penalty for a candidate M (with its solved C, K), evaluated
// against the 崇礼168 rows (no `expectedScore`, real result data) and the
// real 13.9km/167.7km recordings (also real data). See the file header for
// why M -- not C or K -- is the parameter this penalty chooses.
// ---------------------------------------------------------------------------

const CAP_TARGET = 950 // raw (uncapped) score a category winner should stay under
const SPREAD_TARGET = 220 // acceptable max-min band across 崇礼168 category winners
const MONO_MARGIN = 150 // 167.7km real recording should beat the 13.9km one by at least this

// Calibration-table rows have no elevation PROFILE (only scalar
// distance/ascent/descent), so there's no honest way to compute their
// altitude compensation the way `env.ts` does for a real track (distance-
// weighted mean altitude along the route) -- computing one anyway would be
// fabricating a number we don't have. envFactor=1.0 here is a documented
// simplification, not a claim these mountain races have no altitude effect;
// since altFactor is always >= 1.0 (it never reduces a score, see env.ts),
// leaving it out only makes the 崇礼168 rows' predicted scores a
// conservative UNDER-estimate -- it cannot hide a capping problem, only
// understate one.
const CALIBRATION_ROW_ENV_FACTOR = 1.0

function structuralPenalty(p: Params, real: RealRecording[]): number {
  const chongli = CALIBRATION_TABLE.filter((r) => r.label.startsWith('崇礼168'))
  let penalty = 0

  // 1. cap avoidance
  for (const row of chongli) {
    const raw = rawScore(kmeV2(row), row.hours, CALIBRATION_ROW_ENV_FACTOR, p)
    const over = Math.max(0, raw - CAP_TARGET)
    penalty += over * over
  }

  // 2. category-winner spread
  if (chongli.length > 0) {
    const scores = chongli.map((row) => Math.min(rawScore(kmeV2(row), row.hours, CALIBRATION_ROW_ENV_FACTOR, p), 1000))
    const spread = Math.max(...scores) - Math.min(...scores)
    const over = Math.max(0, spread - SPREAD_TARGET)
    penalty += 4 * over * over // weighted higher: this is the clearest "unusable scale" signal
  }

  // 3. short-vs-long monotonicity on real recordings (real envFactor, since
  // we actually have the elevation profile for these).
  const short = real.find((r) => r.file.startsWith('速攀129'))
  const long = real.find((r) => r.file.startsWith('620崇礼68'))
  if (short && long) {
    const scoreShort = Math.min(rawScore(short.kmeV2, short.hours, short.envFactor, p), 1000)
    const scoreLong = Math.min(rawScore(long.kmeV2, long.hours, long.envFactor, p), 1000)
    const violation = Math.max(0, scoreShort - scoreLong + MONO_MARGIN)
    penalty += 9 * violation * violation // weighted highest: this is the headline bug
  }

  return penalty
}

function fitM(real: RealRecording[]): { M: number; C: number; K: number } {
  let best: { M: number; C: number; K: number; penalty: number } | undefined

  const evalM = (M: number) => {
    const ck = solveCK(CALIBRATION_TABLE, M)
    if (!ck) return
    const penalty = structuralPenalty({ ...ck, M }, real)
    if (!best || penalty < best.penalty) best = { M, ...ck, penalty }
  }

  // Coarse grid, then a refinement pass around the coarse optimum. Range is
  // POSITIVE M (see file header + score.ts's comment on the sign: with
  // KME_REF anchored at the long-distance UTMB scale, (kme/KME_REF)^M must
  // grow with kme -- i.e. M > 0 -- for a short race to score lower than a
  // long one at the same speed).
  for (let m = 0; m <= 2.5001; m += 0.005) evalM(Math.round(m * 1000) / 1000)
  if (best) {
    const centre = best.M
    for (let m = centre - 0.005; m <= centre + 0.005; m += 0.0005) evalM(Math.round(m * 10000) / 10000)
  }

  if (!best) throw new Error('fit failed: no M candidate solved (check calibration table has >=2 expectedScore rows)')
  return { M: best.M, C: best.C, K: best.K }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printCalibrationTable(score: (row: CalibrationRow) => number | undefined) {
  console.log('\n== Calibration table ==')
  console.log(
    '  ' +
      'label'.padEnd(48) +
      'dist'.padStart(8) +
      'ascent'.padStart(8) +
      'hours'.padStart(8) +
      'predicted'.padStart(11) +
      'expected'.padStart(10) +
      'residual'.padStart(10) +
      '  confidence',
  )
  const residuals: number[] = []
  for (const row of CALIBRATION_TABLE) {
    const predicted = score(row)
    const residual = predicted !== undefined && row.expectedScore !== undefined ? predicted - row.expectedScore : undefined
    if (residual !== undefined) residuals.push(residual)
    console.log(
      '  ' +
        row.label.padEnd(48) +
        fmt(row.distanceKm).padStart(8) +
        fmt(row.ascentM, 0).padStart(8) +
        fmt(row.hours, 2).padStart(8) +
        fmt(predicted, 0).padStart(11) +
        fmt(row.expectedScore, 0).padStart(10) +
        fmt(residual, 0).padStart(10) +
        '  ' + row.confidence + (row.note ? `  (${row.note})` : ''),
    )
  }
  if (residuals.length > 0) {
    const mae = residuals.reduce((s, r) => s + Math.abs(r), 0) / residuals.length
    const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length)
    console.log(`  fit rows: ${residuals.length}  MAE=${mae.toFixed(1)}  RMSE=${rmse.toFixed(1)}`)
  }
}

function printStructuralChecks(score: (row: CalibrationRow) => number | undefined) {
  console.log('\n== Structural check 1: no 崇礼168 category winner hits the 1000 cap ==')
  const chongli = CALIBRATION_TABLE.filter((r) => r.label.startsWith('崇礼168'))
  let anyCapped = false
  for (const row of chongli) {
    const s = score(row)
    const capped = s !== undefined && s >= 1000
    if (capped) anyCapped = true
    console.log(`  ${row.label.padEnd(48)} PI=${fmt(s, 0)}${capped ? '  *** AT CAP ***' : ''}`)
  }
  console.log(`  verdict: ${anyCapped ? 'FAIL -- at least one category winner is pinned at the ceiling' : 'pass'}`)

  console.log('\n== Structural check 2: 崇礼168 category-winner spread ==')
  const scores = chongli.map((row) => score(row)).filter((s): s is number => s !== undefined)
  if (scores.length > 0) {
    const spread = Math.max(...scores) - Math.min(...scores)
    console.log(`  scores: [${scores.join(', ')}]  spread=${spread.toFixed(0)}`)
  }

  console.log('\n== Structural check 3: short recreational effort must not outscore long elite effort ==')
  console.log('  (uses the real 13.9km/167.7km recordings, not a calibration-table row -- see the')
  console.log('   real-recordings section below for the actual PI numbers and pass/fail verdict)')
}

function printRealRecordings(
  score: (kme: number, hours: number, envFactor: number) => number | undefined,
  levelFor: (kme: number, hours: number, envFactor: number) => string | undefined,
  real: RealRecording[],
) {
  console.log('\n== TrailCraft real recordings ==')
  if (real.length === 0) {
    console.log(`  (no test data found at ${dataDir} -- skipped)`)
    return
  }
  console.log('  ' + 'file'.padEnd(42) + 'dist(km)'.padStart(10) + 'PI'.padStart(8) + '  level')
  const sorted = [...real].sort((a, b) => a.distKm - b.distKm)
  for (const r of sorted) {
    const s = score(r.kmeV2, r.hours, r.envFactor)
    const level = levelFor(r.kmeV2, r.hours, r.envFactor)
    console.log('  ' + r.file.padEnd(42) + fmt(r.distKm).padStart(10) + fmt(s, 0).padStart(8) + '  ' + (level ?? ''))
  }

  const trivial = trivialBaselineKmeV2Hours()
  const trivialScore = score(trivial.kmeV2, trivial.hours, trivial.envFactor)
  console.log(`  trivial baseline (~1km, ~1.5km/h crawl): PI=${fmt(trivialScore, 0)}`)
  const below = sorted.filter((r) => (score(r.kmeV2, r.hours, r.envFactor) ?? 0) < (trivialScore ?? 0))
  if (below.length > 0) {
    console.log(`  *** ${below.length} real recording(s) score BELOW the trivial baseline: ${below.map((r) => r.file).join(', ')}`)
  }

  const short = sorted.find((r) => r.file.startsWith('速攀129'))
  const long = sorted.find((r) => r.file.startsWith('620崇礼68'))
  if (short && long) {
    const sShort = score(short.kmeV2, short.hours, short.envFactor) ?? 0
    const sLong = score(long.kmeV2, long.hours, long.envFactor) ?? 0
    console.log(
      `  monotonicity check: ${short.file} (${short.distKm.toFixed(1)}km) PI=${sShort}  vs  ${long.file} (${long.distKm.toFixed(1)}km) PI=${sLong}` +
        `  verdict: ${sShort < sLong ? 'pass' : 'FAIL -- short effort outscores the long one'}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const mode = process.argv[2] ?? 'report'
  const real = await loadRealRecordings()

  if (mode === 'fit') {
    console.log('== Fitting C, K, M against the calibration table ==')
    console.log('(C, K solved exactly from the 2 expectedScore anchors for each candidate M; M chosen by')
    console.log(' minimising the structural penalty over the 崇礼168 rows + the real 13.9km/167.7km pair.)')
    const { M, C, K } = fitM(real)
    console.log(`\nfitted: C=${C.toFixed(4)}  K=${K.toFixed(4)}  M=${M.toFixed(4)}  (KME_REF=${UTMB_KME_REF_V1})`)

    const params: Params = { C, K, M }
    const score = (row: CalibrationRow) => cappedScore(kmeV2(row), row.hours, CALIBRATION_ROW_ENV_FACTOR, params)
    printCalibrationTable(score)
    printStructuralChecks(score)
    printRealRecordings(
      (kme, hours, envFactor) => cappedScore(kme, hours, envFactor, params),
      // Level thresholds are a separate re-derivation (P2 Q2 commit 2, done
      // by hand against the fitted model's actual score distribution, not
      // searched here) -- `fit` mode's job is only C/K/M, so it doesn't
      // print a level column.
      () => undefined,
      real,
    )
    return
  }

  console.log('== Evaluating the CURRENTLY SHIPPED model (score.ts#calculateSpi) ==')
  const score = (row: CalibrationRow) => calculateSpi(kmeV2(row), row.hours, CALIBRATION_ROW_ENV_FACTOR)?.score
  printCalibrationTable(score)
  printStructuralChecks(score)
  printRealRecordings(
    (kme, hours, envFactor) => calculateSpi(kme, hours, envFactor)?.score,
    (kme, hours, envFactor) => calculateSpi(kme, hours, envFactor)?.level,
    real,
  )
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
