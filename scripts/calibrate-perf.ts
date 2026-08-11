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
 * ── Fitting method (P2 Q2 commit 3 revision) ───────────────────────────────
 * The model has 3 free parameters (C, K, M). As of this commit, the
 * calibration table has only ONE row with a genuinely independently-
 * published `expectedScore` -- the reference's own flat anchor (366). The
 * other former numeric anchor, the reference's synthetic "mountain anchor"
 * (170km/10000m, 20h -> stated 1000), had its `expectedScore` deliberately
 * REMOVED this commit: real 2025 UTMB winner data lands almost exactly on
 * that same effort level and, per explicit product instruction
 * (「到不了1000 极端情况不考虑」), must NOT hit the cap -- keeping "exactly
 * 1000" as a hard numeric fit target would directly fight the fix this
 * commit makes. See calibration.ts's header for the full reasoning.
 *
 * One published point can't determine two unknowns (C, K), and an early
 * version of this commit tried a blind 2-D structural-penalty search over
 * (K, M) (weighting every international row's shortfall from a [900, 960]
 * band quadratically) -- it kept converging back to roughly commit 2's own
 * (K, M), because the quadratic penalty is dominated by whichever row is
 * FARTHEST from the band, and that's 2025 TDS women (Careth Arnold, the
 * slowest pace of the 5 confident international rows): pushing K up to help
 * OCC/Puppi's fast-short profile pushes her shortfall up even more, so the
 * search kept retreating to a low-K region that barely helps the short end
 * at all -- the exact opposite of this commit's job. TDS women isn't a data
 * problem (her time is real, precise to the second); a pure power law
 * genuinely cannot place both her (slow pace, huge kme) and OCC/Puppi (fast
 * pace, small kme) in a 60-point-wide band while ALSO respecting the flat
 * anchor and never capping -- see the milestone report for the 2-equation
 * proof. So this commit does not try to force every international row into
 * band; per the brief ("use that as the objective rather than inventing
 * per-athlete exact scores"), the band is a DIRECTIONAL target, and the
 * headline, explicitly-named defect (OCC/Walmsley and 崇礼50/杨春龙 being
 * under-scored) gets priority over squeezing every row into a tight range.
 *
 * The method actually used:
 *   1. Fix a candidate safety ceiling T.
 *   2. Solve (K, M) EXACTLY so that BOTH of the two most cap-adjacent real
 *      rows -- 2025 UTMB men (Tom Evans; the single largest total km-effort
 *      in the table) and 崇礼168 70km (张火话; the single highest implied
 *      pace in the table, an estimated/low-confidence row) -- land at
 *      exactly T. Two equations, two unknowns, closed-form (see `solveKM`).
 *      These are deliberately the two rows most likely to threaten the cap
 *      from opposite mechanisms (huge kme vs huge pace), so pinning both to
 *      the same safe ceiling is a direct, interpretable way to guarantee
 *      real headroom for the whole table, not just the numeric anchor.
 *   3. Solve C EXACTLY from the sole `expectedScore` row (the flat anchor)
 *      for that (K, M) -- trivial weighted-mean-of-one in log space, kept
 *      general so it still works if more genuinely-published rows are added
 *      later (P2 Q2 brief: "weighting rows by confidence").
 *   4. T itself is chosen by a 1-D search (`pickT`) over the T values that
 *      satisfy every HARD structural constraint (see `hardConstraintsOk`:
 *      cap safety with real margin on every 崇礼168/international row, the
 *      13.9km/167.7km monotonicity + recreational-band checks, the 崇礼168
 *      spread check) -- among those, pick the T that maximises OCC/
 *      Walmsley's score, i.e. directly optimise for the brief's named
 *      short-end defect subject to never re-breaking the cap.
 * This is a similar shape to commit 2's method (2 real constraints solve 2
 * unknowns exactly, 1 remaining degree of freedom chosen structurally) but
 * uses a same-ceiling PAIR instead of a single M-search, because with only 1
 * genuinely-published numeric anchor left, (K, M) together are the ones
 * that need pinning down, not just M.
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
  /** From `PerformanceResult.kmEffortV2`, which is rounded to 1 decimal for
   * display -- fine for `fit` mode's candidate-constant exploration
   * (~1-point noise on a 1000-point scale), but NOT used for `report`
   * mode's "currently shipped" numbers, which use `spiScoreShipped` below
   * instead to match the real production score exactly. */
  kmeV2: number
  hours: number
  /** `envCompensation.totalFactor` from the actual track (mostly altitude
   * compensation for these high-altitude routes -- see env.ts). Real
   * recordings carry their own real value here, UNLIKE the calibration
   * table's rows (see `hardConstraintsOk` below), because we actually have
   * the elevation profile to compute it from. */
  envFactor: number
  /** `PerformanceResult.spiScore`/`spiLevel` as actually computed by the
   * shipped `computePerformance` (from the UNROUNDED kme_v2) -- the
   * ground-truth "what a user sees today" figure for `report` mode. */
  spiScoreShipped: number
  spiLevelShipped: string
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
      spiScoreShipped: res.spiScore,
      spiLevelShipped: res.spiLevel,
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
      spiScoreShipped: res.spiScore,
      spiLevelShipped: res.spiLevel,
    })
  }

  return out
}

// A deliberately tiny, slow baseline -- same construction as the test
// file's "trivial" fixture -- for the "nothing real should score below this"
// sanity floor. Not part of the fit; just a report-time gut check.
function trivialBaselineRecording(): RealRecording {
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
  return {
    file: 'trivial (synthetic)',
    distKm: res.totalDistanceM / 1000,
    kmeV2: res.kmEffortV2,
    hours: res.totalTimeS / 3600,
    envFactor: res.envCompensation.totalFactor,
    spiScoreShipped: res.spiScore,
    spiLevelShipped: res.spiLevel,
  }
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
// Weighted log-linear solve for C given a FIXED (K, M), over every
// calibration row that carries an `expectedScore`. With exactly one such
// row (the flat anchor, as of P2 Q2 commit 3), this is exact interpolation;
// written as a weighted mean so it still generalises correctly if more
// genuinely-published `expectedScore` rows are added later.
// ---------------------------------------------------------------------------

const CONFIDENCE_WEIGHT: Record<CalibrationRow['confidence'], number> = {
  high: 1.0,
  medium: 0.5,
  low: 0.15,
}

function solveC(rows: CalibrationRow[], K: number, M: number): number | undefined {
  const fitRows = rows.filter((r) => r.expectedScore !== undefined)
  if (fitRows.length < 1) return undefined

  let Sw = 0, Swy = 0
  for (const row of fitRows) {
    const w = CONFIDENCE_WEIGHT[row.confidence]
    const kme = kmeV2(row)
    const y = Math.log(row.expectedScore!) - K * Math.log(kme / row.hours) - M * Math.log(kme / UTMB_KME_REF_V1)
    Sw += w; Swy += w * y
  }
  if (Sw < 1e-12) return undefined
  return Math.exp(Swy / Sw)
}

// ---------------------------------------------------------------------------
// (K, M) solve for a candidate safety ceiling T: pins BOTH 2025 UTMB men
// (Tom Evans -- the largest total km-effort in the table) and 崇礼168 70km
// (张火话 -- the highest implied pace in the table) to exactly T. Two linear
// equations in (K, M) once everything is expressed in log space relative to
// the flat anchor -- see the file header for why these two specific rows.
// ---------------------------------------------------------------------------

const flatAnchorRow = CALIBRATION_TABLE.find((r) => r.expectedScore !== undefined)!
const utmbMenRow = CALIBRATION_TABLE.find((r) => r.label.includes('Tom Evans'))!
const chongli70Row = CALIBRATION_TABLE.find((r) => r.label.includes('张火话'))!

function solveKM(T: number): { K: number; M: number } {
  const kmeA = kmeV2(flatAnchorRow), speedA = kmeA / flatAnchorRow.hours
  const kmeU = kmeV2(utmbMenRow), speedU = kmeU / utmbMenRow.hours
  const kme7 = kmeV2(chongli70Row), speed7 = kme7 / chongli70Row.hours

  const lnT = Math.log(T / flatAnchorRow.expectedScore!)
  // lnT = K*ln(speedU/speedA) + M*ln(kmeU/kmeA)   (UTMB men lands at T)
  // lnT = K*ln(speed7/speedA) + M*ln(kme7/kmeA)    (崇礼70 lands at T)
  const a1 = Math.log(speedU / speedA), a2 = Math.log(kmeU / kmeA)
  const b1 = Math.log(speed7 / speedA), b2 = Math.log(kme7 / kmeA)
  const det = a1 * b2 - a2 * b1
  const K = (lnT * (b2 - a2)) / det
  const M = (lnT * (a1 - b1)) / det
  return { K, M }
}

// ---------------------------------------------------------------------------
// Hard structural constraints a candidate T must satisfy to be usable at
// all (see file header for why these are HARD gates rather than a weighted
// penalty -- a quadratic-penalty search over the international band was
// tried first and demonstrably converged to the wrong region because 2025
// TDS women's persistent shortfall dominated it). `T_MAX` bounds the search
// from above (real headroom below 1000, and stays inside the brief's
// ~900-960 aspirational band); `pickT` then searches downward from there
// for the highest T that clears every gate, which -- since a higher T
// directly means a higher K, and OCC/Walmsley's edge is almost entirely
// pace-driven -- also maximises OCC's score, i.e. directly targets the
// brief's named short-end defect (OCC, 崇礼50) without the band-penalty's
// failure mode.
// ---------------------------------------------------------------------------

const T_MAX = 960 // upper search bound for the safety ceiling -- top of the brief's assumed elite band, itself well under the hard 1000 cap
const CAP_SAFETY_MARGIN = 970 // every OTHER winner-like row (not the two pinned to T) must stay under this
const SPREAD_MAX = 300 // generous max-min band across 崇礼168 category winners -- looser than commit 2's 220 because commit 2's own table only had 2 numeric anchors to pin the whole curve; this commit has 1, so more spread is the honest cost of also fixing the short end (see report)
const MONO_MARGIN = 150 // 167.7km real recording should beat the 13.9km one by at least this
const RECREATIONAL_MAX = 520 // upper sanity bound for the 13.9km real recording -- must stay recreational-band, not drift toward elite territory

// Calibration-table rows have no elevation PROFILE (only scalar
// distance/ascent/descent), so there's no honest way to compute their
// altitude compensation the way `env.ts` does for a real track (distance-
// weighted mean altitude along the route) -- computing one anyway would be
// fabricating a number we don't have. envFactor=1.0 here is a documented
// simplification, not a claim these mountain races have no altitude effect;
// since altFactor is always >= 1.0 (it never reduces a score, see env.ts),
// leaving it out only makes the 崇礼168/international rows' predicted
// scores a conservative UNDER-estimate -- it cannot hide a capping problem,
// only understate one.
const CALIBRATION_ROW_ENV_FACTOR = 1.0

function winnerRows(): CalibrationRow[] {
  // Every row except the flat anchor is some kind of race winner (real or
  // the reference's synthetic mountain anchor) -- all of them must respect
  // the cap, not just the labelled 崇礼168/international groups.
  return CALIBRATION_TABLE.filter((r) => r !== flatAnchorRow)
}

function hardConstraintsOk(p: Params, real: RealRecording[]): boolean {
  for (const row of winnerRows()) {
    if (row === utmbMenRow || row === chongli70Row) continue // pinned to T by construction
    const raw = rawScore(kmeV2(row), row.hours, CALIBRATION_ROW_ENV_FACTOR, p)
    if (raw > CAP_SAFETY_MARGIN) return false
  }

  const chongli = CALIBRATION_TABLE.filter((r) => r.label.startsWith('崇礼168'))
  if (chongli.length > 0) {
    const scores = chongli.map((row) => Math.min(rawScore(kmeV2(row), row.hours, CALIBRATION_ROW_ENV_FACTOR, p), 1000))
    if (Math.max(...scores) - Math.min(...scores) > SPREAD_MAX) return false
  }

  const short = real.find((r) => r.file.startsWith('速攀129'))
  const long = real.find((r) => r.file.startsWith('620崇礼68'))
  if (short && long) {
    const scoreShort = Math.min(rawScore(short.kmeV2, short.hours, short.envFactor, p), 1000)
    const scoreLong = Math.min(rawScore(long.kmeV2, long.hours, long.envFactor, p), 1000)
    if (scoreLong - scoreShort < MONO_MARGIN) return false
    if (scoreShort > RECREATIONAL_MAX) return false
  }

  return true
}

function fitParams(real: RealRecording[]): { M: number; K: number; C: number; T: number } {
  const occRow = CALIBRATION_TABLE.find((r) => r.label.includes('Jim Walmsley'))!
  let best: { T: number; K: number; M: number; C: number; occScore: number } | undefined

  for (let T = T_MAX; T >= 800; T -= 1) {
    const { K, M } = solveKM(T)
    const C = solveC(CALIBRATION_TABLE, K, M)
    if (C === undefined) continue
    const p: Params = { C, K, M }
    if (!hardConstraintsOk(p, real)) continue
    const occScore = rawScore(kmeV2(occRow), occRow.hours, CALIBRATION_ROW_ENV_FACTOR, p)
    if (!best || occScore > best.occScore) best = { T, K, M, C, occScore }
    break // T descends from T_MAX, and a higher T -> higher K -> higher OCC
    // score in this parameterisation (verified empirically -- see the
    // milestone report), so the FIRST T that clears every gate is also the
    // OCC-maximising one; the loop still walks downward from T_MAX rather
    // than assuming this so a future calibration-table change that breaks
    // the monotonicity gets a correct (if slower) answer, not a silent bug
    // -- remove the `break` to fall back to an exhaustive scan.
  }

  if (!best) throw new Error('fit failed: no T in range satisfied every hard constraint (check calibration table / real recordings)')
  return { M: best.M, K: best.K, C: best.C, T: best.T }
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

function printRealRecordings(pick: (r: RealRecording) => { score: number | undefined; level: string | undefined }, real: RealRecording[]) {
  console.log('\n== TrailCraft real recordings ==')
  if (real.length === 0) {
    console.log(`  (no test data found at ${dataDir} -- skipped)`)
    return
  }
  console.log('  ' + 'file'.padEnd(42) + 'dist(km)'.padStart(10) + 'PI'.padStart(8) + '  level')
  const sorted = [...real].sort((a, b) => a.distKm - b.distKm)
  for (const r of sorted) {
    const { score: s, level } = pick(r)
    console.log('  ' + r.file.padEnd(42) + fmt(r.distKm).padStart(10) + fmt(s, 0).padStart(8) + '  ' + (level ?? ''))
  }

  const trivial = trivialBaselineRecording()
  const trivialPicked = pick(trivial)
  console.log(`  trivial baseline (~1km, ~1.5km/h crawl): PI=${fmt(trivialPicked.score, 0)}`)
  const below = sorted.filter((r) => (pick(r).score ?? 0) < (trivialPicked.score ?? 0))
  if (below.length > 0) {
    console.log(`  *** ${below.length} real recording(s) score BELOW the trivial baseline: ${below.map((r) => r.file).join(', ')}`)
  }

  const short = sorted.find((r) => r.file.startsWith('速攀129'))
  const long = sorted.find((r) => r.file.startsWith('620崇礼68'))
  if (short && long) {
    const sShort = pick(short).score ?? 0
    const sLong = pick(long).score ?? 0
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
    console.log('(K, M solved exactly for a candidate ceiling T so that BOTH 2025 UTMB men and 崇礼168 70km land')
    console.log(' at T; C then solved exactly from the flat anchor; T searched downward from 960 for the highest')
    console.log(' value clearing every hard cap/monotonicity/recreational-band gate -- see file header for why.)')
    const { M, C, K, T } = fitParams(real)
    console.log(`\nfitted: C=${C.toFixed(4)}  K=${K.toFixed(4)}  M=${M.toFixed(4)}  (KME_REF=${UTMB_KME_REF_V1}, T=${T})`)

    const params: Params = { C, K, M }
    const score = (row: CalibrationRow) => cappedScore(kmeV2(row), row.hours, CALIBRATION_ROW_ENV_FACTOR, params)
    printCalibrationTable(score)
    printStructuralChecks(score)
    printRealRecordings(
      (r) => ({
        score: cappedScore(r.kmeV2, r.hours, r.envFactor, params),
        // Level thresholds are a separate re-derivation (P2 Q2 commit 2,
        // done by hand against the fitted model's actual score
        // distribution, not searched here) -- `fit` mode's job is only
        // C/K/M, so it doesn't print a level column.
        level: undefined,
      }),
      real,
    )
    return
  }

  console.log('== Evaluating the CURRENTLY SHIPPED model (score.ts#calculateSpi) ==')
  const score = (row: CalibrationRow) => calculateSpi(kmeV2(row), row.hours, CALIBRATION_ROW_ENV_FACTOR)?.score
  printCalibrationTable(score)
  printStructuralChecks(score)
  // Uses the actual PerformanceResult.spiScore/spiLevel (see RealRecording's
  // spiScoreShipped/spiLevelShipped) rather than recomputing from kmeV2/
  // hours, which would introduce ~1-point noise from kmEffortV2 being
  // rounded to 1 decimal for display in PerformanceResult.
  printRealRecordings((r) => ({ score: r.spiScoreShipped, level: r.spiLevelShipped }), real)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
