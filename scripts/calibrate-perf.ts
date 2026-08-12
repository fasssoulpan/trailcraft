/**
 * Calibration / fitting harness for the performance-score power-law model
 * (P2 Q2 commits 1-3). Run with `npx vite-node scripts/calibrate-perf.ts`.
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
 * ── Fitting method (P2 Q2 commit 4 revision -- current) ────────────────────
 * Commit 3's method solved (K, M) freely from 2 pinned rows (2025 UTMB men
 * and 崇礼168 70km both landing exactly at a searched ceiling T). That
 * produced M=0.295, K=0.683 -- i.e. M/K=0.432, meaning the model expected a
 * runner to be ~63% slower over 10x the km-effort to score the same. There
 * is no physiological support for that: Riegel's endurance model (`t ∝
 * d^r`), the standard empirical reference for how finishing pace decays with
 * distance, puts road running at r≈1.06 and ultra-trail literature at
 * r≈1.10-1.20 (13%-37% slower over 10x distance). In this model's terms,
 * M/K = r-1, so the physiologically-plausible region is M/K ∈ [0.10, 0.20]
 * -- commit 3's free 2-anchor solve landed M/K more than 2x past the top of
 * that band, which is why real short-but-strong efforts (a 13.87km/781m D+/
 * 790m D- run in 1h29m, 18.1 km-effort/h) were scoring in the "良好" band
 * instead of reflecting the genuinely strong pace behind them.
 *
 * Why bound M/K instead of just fitting it freely again: the calibration
 * table still has only ONE row with a genuinely independently-published
 * `expectedScore` (the flat anchor, 366) -- every other row (崇礼168,
 * 2025 UTMB-week) is a real result but has NO independently-published PI to
 * fit against (P2 §5: never fabricate one). With 1 numeric anchor and 3 free
 * parameters (C, K, M), an unconstrained fit is just curve-fitting to
 * whichever structural assumptions get baked into the penalty function --
 * commit 3's own header documents this failure mode (a blind 2-D penalty
 * search over (K, M) kept sliding back toward the wrong region because
 * 2025 TDS women's shortfall dominated the quadratic penalty). Riegel's
 * exponent is the strongest constraint actually available on the shape of
 * the distance/pace tradeoff -- an empirical result independent of this
 * table's confidence caveats -- so this commit uses it as a hard bound on
 * the search space rather than another row to weight into a penalty.
 *
 * The method actually used:
 *   1. Fix a candidate M/K ratio r ∈ [MK_MIN, MK_MAX] (the Riegel-plausible
 *      band) and a candidate safety ceiling T.
 *   2. Solve K EXACTLY so that 2025 UTMB men (Tom Evans; the single largest
 *      total km-effort in the table, and per explicit product instruction
 *      「到不了1000 极端情况不考虑」 the row that must land comfortably under
 *      the cap) lands at exactly T, using the flat anchor to eliminate C
 *      from that one equation (see `solveK`) -- M = r*K follows directly.
 *      Unlike commit 3, 崇礼168 70km is no longer force-pinned to the same T
 *      (that was needed to determine 2 free unknowns; bounding M/K removes
 *      the need for a second pinned equation) -- it now only has to clear
 *      the same structural gates as every other winner-like row.
 *   3. Solve C EXACTLY from the sole `expectedScore` row (the flat anchor)
 *      for that (K, M) -- trivial weighted-mean-of-one in log space, kept
 *      general so it still works if more genuinely-published rows are added
 *      later (P2 Q2 brief: "weighting rows by confidence").
 *   4. Among every (r, T) pair that satisfies every HARD structural
 *      constraint (see `hardConstraintsOk`: every winner-like row other than
 *      the pinned UTMB anchor must stay under a cap-safety margin, the
 *      崇礼168 category-winner spread check, and the real 13.9km/167.7km
 *      monotonicity check), pick the pair that maximises OCC/Walmsley's
 *      score (P2 Q2's other explicitly-named under-scored elite short
 *      effort), i.e. directly optimise for the brief's named short-end
 *      defect subject to staying inside the physiologically admissible band
 *      and never re-breaking the cap.
 * This is a similar shape to commit 3's method (pin real rows, solve the
 * rest exactly, pick the remaining freedom by a structural search) but
 * replaces "solve M freely from a second pinned row" with "bound M/K by
 * Riegel and search within that band" -- the band, not a second real-world
 * pin, is what makes the short end of the fit defensible now.
 *
 * One documented tension this surfaced: commit 3 force-pinned 崇礼168 70km
 * (张火话) to the SAME ceiling as UTMB men specifically because, taken at
 * face value, its numbers (123.6 km-effort in 4.53h, 27.3 km-effort/h) imply
 * a PACE ~55% higher than the UTMB men's winning pace on only 36% of the
 * total km-effort -- for ANY K>0, that combination out-scores UTMB men
 * whenever M/K < ~0.43 (provably so: the score ratio between two rows
 * collapses to [pace_ratio * kme_ratio^r]^K, independent of K's actual
 * value, so once the bracketed base exceeds 1 no K can fix it). Since 0.43
 * is entirely outside the Riegel band [0.10, 0.20], this row will *always*
 * out-score UTMB men under a physiologically-bounded M -- exact-pinning it
 * to the same ceiling as commit 3 did is no longer possible without
 * violating the physiological bound. This row is explicitly flagged 'low'
 * confidence with an unsourced, proportionally-estimated ascent figure (P2
 * §5: not sourced, not GPS-measured) -- entirely plausible the true ascent
 * is higher than the naive proportional estimate (short categories often
 * front-load a race's steepest terrain rather than spreading it evenly), in
 * which case the true implied pace is milder than these numbers suggest.
 * Rather than force-fit the whole model around one low-confidence estimate,
 * this commit keeps 崇礼70 subject only to the same cap-safety margin as
 * every other winner-like row (never allowed to approach 1000) and drops
 * the additional "must not exceed UTMB" requirement for it specifically --
 * documented here, and in the milestone report, rather than silently
 * dropped.
 *
 * Practical consequence worth naming explicitly: even with that relaxation,
 * 崇礼70's cap-safety margin AND the 崇礼168 spread check both still tighten
 * as T rises (崇礼70 is also the largest contributor to the category spread,
 * being the fastest-implied-pace row) -- so the highest T that clears every
 * gate settles well below the "~960, rather than drifting" aspiration named
 * in the brief (T lands in the 800s, not the 900s). This is the honest
 * consequence of holding both "never hit 1000" and the Riegel bound
 * simultaneously against a table that includes this specific estimated row
 * -- not a search bug. UTMB men still lands solidly 精英级 with real
 * headroom below 1000; see the milestone report for the exact figure.
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
// K solve for a candidate M/K ratio r and safety ceiling T: pins 2025 UTMB
// men (Tom Evans -- the largest total km-effort in the table, and the row
// the product instruction most directly targets: "must not reach 1000") to
// exactly T, with M constrained to r*K throughout -- one linear equation in
// K once everything is expressed in log space relative to the flat anchor
// and M is substituted out. 崇礼168 70km (commit 3's second pinned row) is
// deliberately NOT pinned here -- bounding M/K removes the need for a
// second real-world pin to fully determine (K, M); it now only has to clear
// the same structural gates as every other winner-like row (see
// `hardConstraintsOk`).
// ---------------------------------------------------------------------------

const flatAnchorRow = CALIBRATION_TABLE.find((r) => r.expectedScore !== undefined)!
const utmbMenRow = CALIBRATION_TABLE.find((r) => r.label.includes('Tom Evans'))!

// Riegel's endurance model (t ∝ d^r) is the standard empirical reference for
// how finishing pace decays with distance: r≈1.06 for road running, r≈
// 1.10-1.20 for ultra-trail (steeper decay -- terrain/vert compound fatigue
// beyond flat-road endurance loss). In this model, M/K = r-1 (see score.ts's
// header for the derivation), so [0.10, 0.20] is the ultra-trail-plausible
// band for M/K -- not a number tuned to make any one row "feel right", but
// the physiological bound documented in this file's header.
const MK_MIN = 0.10
const MK_MAX = 0.20
const MK_STEP = 0.002 // ~50 samples across the band; fine enough that the OCC-maximising choice below isn't step-size-limited

function solveK(T: number, r: number): number {
  const kmeA = kmeV2(flatAnchorRow), speedA = kmeA / flatAnchorRow.hours
  const kmeU = kmeV2(utmbMenRow), speedU = kmeU / utmbMenRow.hours
  const lnT = Math.log(T / flatAnchorRow.expectedScore!)
  // lnT = K*ln(speedU/speedA) + M*ln(kmeU/kmeA), with M = r*K:
  // lnT = K*[ln(speedU/speedA) + r*ln(kmeU/kmeA)]
  const denom = Math.log(speedU / speedA) + r * Math.log(kmeU / kmeA)
  return lnT / denom
}

// ---------------------------------------------------------------------------
// Hard structural constraints a candidate (r, T) pair must satisfy to be
// usable at all (see file header for why these are HARD gates rather than a
// weighted penalty -- a quadratic-penalty search over the international
// band was tried in commit 3 and demonstrably converged to the wrong region
// because 2025 TDS women's persistent shortfall dominated it). `T_MAX`
// bounds the search from above (real headroom below 1000, and stays inside
// the brief's ~900-960 aspirational band); `fitParams` searches (r, T) for
// the combination that clears every gate AND maximises OCC/Walmsley's
// score, i.e. directly targets the brief's named short-end defect (OCC,
// 崇礼50, and TrailCraft's own 速攀129 recording) without the band-penalty's
// failure mode, subject to staying inside the Riegel-plausible M/K band.
//
// CAP_SAFETY_MARGIN (985, a fixed number just below 1000) applies to every
// winner-like row except the pinned UTMB-men anchor -- including 崇礼168
// 70km, which commit 3 instead force-pinned exactly to T. See the file
// header ("One documented tension...") for why an exact "must not exceed
// UTMB" requirement is mathematically impossible for that specific row
// under a Riegel-bounded M: its low-confidence, estimated ascent implies a
// pace/kme combination that out-scores UTMB men for every M/K below ~0.43,
// far outside the [0.10, 0.20] admissible band. The category-winner
// non-inversion the brief asks to keep is enforced WITHIN 崇礼168 itself via
// the spread check below, which is the check the P2 Q2 brief's own
// structural checks (`printStructuralChecks`) actually name.
// ---------------------------------------------------------------------------

const T_MAX = 960 // upper search bound for the safety ceiling -- top of the brief's assumed elite band, itself well under the hard 1000 cap
const CAP_SAFETY_MARGIN = 985 // every OTHER winner-like row (not the one pinned to T) must stay under this -- real headroom below 1000, restored from commit 3 now that 崇礼168 70km is no longer force-pinned to T either
const SPREAD_MAX = 300 // generous max-min band across 崇礼168 category winners -- looser than commit 2's 220 because the table has only 1 numeric anchor to pin the whole curve; more spread is the honest cost of also fixing the short end (see report)
// 167.7km real recording should beat the 13.9km one by at least this. Commit
// 3's value (150) is unreachable ANYWHERE inside the Riegel band [0.10,
// 0.20] -- measured margin peaks at ~50-56 points at the band's own upper
// edge (r=0.20, where M/K best preserves long-effort dominance) and goes
// NEGATIVE (an actual inversion) below r~0.16, because the whole point of
// this refit is to let the 13.9km recording's genuinely strong pace (18.1
// km-effort/h) close most of that gap -- a 150-point margin would only be
// achievable by keeping M large again, i.e. re-introducing the bug this
// commit fixes. 30 keeps a clear, non-borderline separation while staying
// inside what the physiologically-bounded model can actually produce.
const MONO_MARGIN = 30

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
    if (row === utmbMenRow) continue // pinned to T by construction, T <= T_MAX well under the margin below
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
    // Monotonicity only -- P2 Q2 commit 3's fixed RECREATIONAL_MAX=520 was
    // itself calibrated under the M=0.295/0.38 regime being replaced here,
    // and this exact 13.9km recording (速攀129, 18.1 km-effort/h) is the
    // brief's own headline under-scored case, not one that should be capped
    // back down by a leftover constant -- the monotonicity margin below is
    // the constraint the brief actually asks to keep ("a short recreational
    // effort does not outscore a long elite one"), not a specific ceiling.
    if (scoreLong - scoreShort < MONO_MARGIN) return false
  }

  return true
}

function fitParams(real: RealRecording[]): { M: number; K: number; C: number; T: number; r: number } {
  const occRow = CALIBRATION_TABLE.find((r) => r.label.includes('Jim Walmsley'))!
  let best: { T: number; K: number; M: number; C: number; r: number; occScore: number } | undefined

  // Brute-force 2-D search over (T, r=M/K): unlike commit 3's single-M
  // solve, a smaller r monotonically helps some rows and hurts others in
  // ways not verified analytically here, so this scans the full admissible
  // grid rather than assuming a shortcut and stopping early.
  for (let T = T_MAX; T >= 600; T -= 1) {
    for (let r = MK_MIN; r <= MK_MAX + 1e-9; r += MK_STEP) {
      const K = solveK(T, r)
      if (!(K > 0)) continue
      const M = r * K
      const C = solveC(CALIBRATION_TABLE, K, M)
      if (C === undefined) continue
      const p: Params = { C, K, M }
      if (!hardConstraintsOk(p, real)) continue
      const occScore = rawScore(kmeV2(occRow), occRow.hours, CALIBRATION_ROW_ENV_FACTOR, p)
      if (!best || occScore > best.occScore) best = { T, K, M, C, r, occScore }
    }
  }

  if (!best) throw new Error('fit failed: no (r, T) in range satisfied every hard constraint (check calibration table / real recordings)')
  return { M: best.M, K: best.K, C: best.C, T: best.T, r: best.r }
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
    console.log(`(M/K=r-1 swept over the Riegel-plausible band [${MK_MIN}, ${MK_MAX}]; K solved exactly for each (r, T)`)
    console.log(' so 2025 UTMB men lands at T; C then solved exactly from the flat anchor; (r, T) chosen from every')
    console.log(' combination clearing every hard cap/inversion/spread/monotonicity gate by maximising OCC/Walmsley\'s')
    console.log(' score -- see file header for why.)')
    const { M, C, K, T, r } = fitParams(real)
    console.log(`\nfitted: C=${C.toFixed(4)}  K=${K.toFixed(4)}  M=${M.toFixed(4)}  (KME_REF=${UTMB_KME_REF_V1}, T=${T}, M/K=${r.toFixed(4)}, Riegel r=${(1 + r).toFixed(4)})`)

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
