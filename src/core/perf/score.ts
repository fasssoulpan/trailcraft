/**
 * Performance Index (PI) power-law scoring model, ported from
 * `cyber-trail-hud/src/analysis/scoring_v4.js` (214 lines) (P2 §3.2,
 * milestone Q2). User's own project, no licence obstacle.
 *
 * This ports ONLY the power-law PI model + level lookup from `scoring_v4.js`
 * -- NOT `analyzePerformance`'s radar scores (climbing/downhill/cardio/
 * terrain), HR zones, TRIMP, HR drift, or hiking-percentage stats. The P2
 * plan (§2.2) explicitly excludes heart-rate analysis/TRIMP/power as out of
 * scope for a pre-race route tool, and the radar helpers all either consume
 * HR directly (`calculateCardioScore`) or aren't part of the five files this
 * milestone's table maps (`calculateClimbingScore` etc. live in
 * `scoring_v4.js` itself, not in `elevation.js`/`gap.js`/etc.).
 *
 * PI = min(1000, round(C * (kme_v2 / hours)^K * (kme_v2 / KME_REF)^M * envFactor))
 *   C = 149.0   calibration constant (see "P2 Q2 commit 2" below)
 *   K = 0.645   speed exponent
 *   M = 0.38    length-normalisation exponent (see below)
 *   kme_v2 = dist_km + ascent_m/100 + descent_m/150
 *   KME_REF = 270 (UTMB's classic ~270 km-effort figure -- see calibration.ts)
 *
 * Dual-anchor calibration (from the reference's own header comment, still
 * exactly satisfied by the refit below):
 *   flat anchor:     92km / 186m D+,             12.75h -> PI ~366 (中等)
 *   mountain anchor: UTMB 170km / 10000m D+/D-,   20h    -> PI ~1000 (精英级)
 * See this file's test suite for regression tests against both anchors.
 *
 * ── THE ONE DELIBERATE DIVERGENCE (P2 §3.2) ──────────────────────────────
 * The reference computes its own `summary.totalAscent`/`totalDescent` (a
 * simple threshold-deadzone accumulator in its `enricher.js`, ELEVATION_DEAD
 * _ZONE). TrailCraft instead feeds `kmEffortV2` from P0's validated
 * threshold-hysteresis ascent/descent (`core/stats/elevation.ts#
 * computeGainLoss`, using the user's own `statsOptions` threshold/smoothing)
 * -- the same figure the segment table, the 3D HUD and the hover readout all
 * already show, so this module cannot introduce a second, disagreeing
 * ascent number for the same track.
 *
 * ── P2 Q2 commit 2: distance normalisation (the fix) ──────────────────────
 * Commit 1's harness (`src/core/perf/calibration.ts` +
 * `scripts/calibrate-perf.ts`) measured a severe distance bias in the
 * original 2-parameter model (`C=30.0, K=1.25`, no length term): K>1 on
 * speed alone rewards the higher average pace short races naturally produce,
 * with nothing counteracting it. Effect, measured against the 2026 崇礼168
 * category winners: the 100km/70km/50km category winners were ALL pinned at
 * the 1000 cap, and TrailCraft's own 13.9km recording (PI=1000) outscored
 * its own 167.7km recording (PI=664).
 *
 * The fix adds `(kme_v2 / KME_REF)^M`, a multiplier that grows with race
 * length so a given km-effort-per-hour scores lower on a short course than
 * on a long one. This REQUIRES M > 0 given KME_REF is anchored at the long-
 * distance UTMB scale (270): for kme < KME_REF, (kme/KME_REF)^M < 1 only
 * when M is positive -- a negative M on this ratio would do the opposite
 * (amplify short courses further). See this milestone's report for the
 * derivation; a negative-M version of this same formula shape only works if
 * KME_REF is anchored at a SHORT reference scale instead, which is not what
 * "anchored at UTMB's ~270" means.
 *
 * Fitting method (implemented in `scripts/calibrate-perf.ts`, not here --
 * this file only carries the result): the calibration table has exactly 2
 * rows with a genuinely independently-published `expectedScore` (the
 * reference's own dual anchors), which exactly determine C and K for ANY
 * fixed M via weighted log-linear regression. M itself is chosen by a 1-D
 * search minimising a structural penalty built from 3 checks that don't
 * need a published PI to be defensible: no 崇礼168 category winner should
 * approach the 1000 cap, the 5 category winners should land in a
 * reasonably tight band, and the real 13.9km recording must not outscore
 * the real 167.7km one. That search landed on M=0.38 (a clean, stable
 * minimum -- see the milestone report for the penalty-vs-M scan), with C
 * and K then re-solved exactly at that M and rounded to 3-4 significant
 * figures. Run `npx vite-node scripts/calibrate-perf.ts fit` to reproduce.
 *
 * Fitted 2026-08 against: cyber-trail-hud's 2 dual anchors (numeric fit) +
 * 2026 崇礼168's 5 category winners + TrailCraft's 12 real recordings
 * (structural constraints only, see calibration.ts for which figures in
 * that set are estimates vs measured facts). Re-run the script if more
 * calibration rows are added later.
 *
 * ── LEVELS recalibration (P2 Q2 commit 2) ────────────────────────────────
 * Thresholds re-derived from scratch against the refitted model (the prior
 * 770/550/420/220 were a +9.6%-median-shift rescale of the ORIGINAL 2-
 * parameter model's distribution and do not carry over -- K and the score
 * distribution both changed substantially).
 *
 * Two independent anchors, both real:
 *  1. The reference's own flat anchor (92km/186m D+, 12.75h) scores ~366
 *     under the refit and is explicitly labelled 中等 in the reference's own
 *     header comment -- 良好's threshold must stay above 366 or this
 *     specific, explicitly-documented case gets silently relabelled.
 *  2. Every one of the 2026 崇礼168 category winners in the calibration
 *     table -- real national-level champions across 4 distances (168/100/
 *     70/50km) -- should qualify as 精英级. Their scores under the refit are
 *     [934, 832, 784, 934, 672]; the floor is 672 (50km winner).
 * Both anchors are satisfiable simultaneously with real headroom, so rather
 * than force the reference's original 700/500/380/200 through a uniform
 * rescale (which would either push 366 into 良好 or push the 50km winner
 * out of 精英级, depending on the scale factor), only the threshold that
 * actually needs to move (精英级, since the winner floor of 672 no longer
 * clears the reference's original 700) moves: 精英级 = 650 (round number,
 * ~3% below the 672 floor). 优秀/良好/中等 keep the reference's own original
 * numbers (500/380/200) unchanged -- they still correctly place both real
 * anchors (366 stays in 中等-band-adjacent 良好's floor is 380, so 366
 * lands in 中等; all real recordings retain sensible 良好-through-精英级
 * spreads, see the milestone report).
 *
 *   Level  | Threshold | Reference's stated meaning (still the intent)
 *   -------|----------:|------------------------------------------------
 *   精英级 |       650 | 职业/国家级精英，大赛冠军/领奖台级
 *   优秀   |       500 | 竞技业余（UTMB 资格线以上，区域赛前 20%）
 *   良好   |       380 | 经验丰富的越野/超马跑者（可完成 50km 山地赛）
 *   中等   |       200 | 能完赛超马的普通跑者
 *   入门   |      <200 | 初次参赛、多日徒步或体能不足
 */
import type { Track } from '../model/track'
import type { StatsOptions } from '../stats/segments'
import { smoothElevation, computeGainLoss } from '../stats/elevation'
import { resolveTrackKind } from './trackKind'
import { derivePointSeries } from './pointSeries'
import { computeTrackGap, type TrackGap } from './gap'
import { computeGradeSegments, type GradeSegment } from './climbs'
import { computeEnvCompensation, type EnvCompensation, type EnvUserProfile } from './env'
import { computeKmSplits, type KmSplit } from './splits'

// Same defaults as core/stats/segments.ts's DEFAULT_THRESHOLD/
// DEFAULT_SMOOTH_WINDOW (not exported from there) -- mirrors
// src/ui/hudStats.ts's own local copy of the same constants.
const DEFAULT_THRESHOLD = 5
const DEFAULT_SMOOTH_WINDOW = 5

// ── Power-law model parameters (P2 Q2 commit 2 refit -- see header) ───────
const SPI_C = 149.0
const SPI_K = 0.645
const SPI_M = 0.38
// UTMB's classic ~270 km-effort (170km + 10000m D+ / 100, the widely-cited
// v1 figure with no descent term) -- a recognisable "this is elite ultra
// scale" reference point. Intentionally duplicated from calibration.ts's
// `UTMB_KME_REF_V1` (same value) rather than imported, so this shipped
// module has no runtime dependency on the calibration data table -- see
// calibration.ts's header for why that table stays script/analysis-only.
const SPI_KME_REF = 270

export type PerformanceLevel = '精英级' | '优秀' | '良好' | '中等' | '入门'

/** Level thresholds -- see this file's header comment for the anchor
 * (every 2026 崇礼168 category winner qualifies as 精英级) and how the
 * other three were derived from it. */
const LEVELS: { threshold: number; label: PerformanceLevel }[] = [
  { threshold: 650, label: '精英级' },
  { threshold: 500, label: '优秀' },
  { threshold: 380, label: '良好' },
  { threshold: 200, label: '中等' },
  { threshold: 0, label: '入门' },
]

export interface SpiResult {
  /** Performance Index, 0-1000. A community reverse-engineered estimate --
   * NOT an official ITRA score (P2 §5). Callers presenting this in UI must
   * label it accordingly. */
  score: number
  level: PerformanceLevel
}

/**
 * Core power-law formula, exported for direct regression testing against
 * the reference's documented dual anchors without needing to build a full
 * `Track`. Returns `undefined` for a non-positive `kme` or `hours` (the
 * reference's own guard, there returning a `{score: 0, level: '数据不足'}`
 * sentinel -- here surfaced as "no result" so callers make an explicit
 * choice about what to show instead of a silent fake zero).
 */
export function calculateSpi(kme: number, hours: number, envFactor: number): SpiResult | undefined {
  if (!(kme > 0) || !(hours > 0)) return undefined
  const speed = kme / hours
  const lengthFactor = (kme / SPI_KME_REF) ** SPI_M
  const score = Math.round(Math.min(SPI_C * speed ** SPI_K * lengthFactor * envFactor, 1000))
  const level = LEVELS.find((l) => score >= l.threshold)!.label
  return { score, level }
}

export type PerformanceNotApplicableReason =
  | 'planned'
  | 'uncertain'
  | 'no-elevation'
  | 'no-time'
  | 'insufficient-points'
  | 'degenerate'

export interface PerformanceNotApplicable {
  applicable: false
  reason: PerformanceNotApplicableReason
  /** Chinese explanation, for direct UI display. */
  message: string
}

export interface PerformanceResult {
  applicable: true
  /** Environment-compensated PI + level -- the headline figure. Community
   * reverse-engineered estimate, NOT an official ITRA score (P2 §5). */
  spiScore: number
  spiLevel: PerformanceLevel
  /** Uncorrected PI (envFactor=1, km-effort v1 without the descent term) --
   * for apples-to-apples comparison across tracks/conditions, matching the
   * reference's `spiRawScore`/`spiRawLevel`. */
  spiRawScore: number
  spiRawLevel: PerformanceLevel
  /** dist_km + ascent_m/100 (v1, no descent term). */
  kmEffort: number
  /** dist_km + ascent_m/100 + descent_m/150 -- what `spiScore` is computed
   * from. */
  kmEffortV2: number
  /** P0 threshold-hysteresis ascent/descent (m) that fed kmEffort/kmEffortV2
   * -- see this file's header comment for why these, not the reference's own
   * algorithm. */
  totalAscentM: number
  totalDescentM: number
  totalDistanceM: number
  totalTimeS: number
  envCompensation: EnvCompensation
  gap: TrackGap
  gradeSegments: GradeSegment[]
  splits: KmSplit[]
}

export type PerformanceAnalysis = PerformanceResult | PerformanceNotApplicable

function notApplicable(reason: PerformanceNotApplicableReason, message: string): PerformanceNotApplicable {
  return { applicable: false, reason, message }
}

/**
 * The actual computation, uncached -- see `computePerformance` below for the
 * memoised public entry point. Kept separate so tests can exercise gating
 * logic without needing to reason about cache state.
 */
function analyze(track: Track, statsOptions: StatsOptions, profile: EnvUserProfile): PerformanceAnalysis {
  // ── Gate 1 (P2 §3.1/§3.2): refuse planned/uncertain tracks outright. ────
  const resolvedKind = resolveTrackKind(track)
  if (resolvedKind.kind === 'planned') {
    return notApplicable('planned', '该轨迹判定为规划路线，规划路线没有"跑得怎么样"可言，无法计算表现分')
  }
  if (resolvedKind.kind === 'uncertain') {
    return notApplicable('uncertain', '该轨迹的实跑/规划判定证据不足，暂无法计算表现分；可在轨迹属性中手动指定为实跑')
  }

  const n = track.points.lon.length
  if (n < 2) return notApplicable('insufficient-points', '轨迹点数不足，无法计算表现分')
  if (!track.points.ele) return notApplicable('no-elevation', '轨迹没有海拔数据，无法计算表现分')
  if (!track.points.time) return notApplicable('no-time', '轨迹没有时间戳，无法计算表现分')

  const threshold = statsOptions.threshold ?? DEFAULT_THRESHOLD
  const smoothWindow = statsOptions.smoothWindow ?? DEFAULT_SMOOTH_WINDOW

  const series = derivePointSeries(track)
  const totalDistanceM = series.dist[n - 1]
  const totalTimeS = series.elapsedSec![n - 1]
  if (!(totalTimeS > 0)) return notApplicable('degenerate', '轨迹总用时为零，无法计算表现分')

  const smoothed = smoothElevation(track.points.ele, smoothWindow)
  const { gain: totalAscentM, loss: totalDescentM } = computeGainLoss(smoothed, threshold)

  const kmEffort = totalDistanceM / 1000 + totalAscentM / 100
  const kmEffortV2 = kmEffort + totalDescentM / 150
  if (!(kmEffortV2 > 0)) return notApplicable('degenerate', '轨迹里程与爬升均为零，无法计算表现分')

  const hours = totalTimeS / 3600
  const envCompensation = computeEnvCompensation(track, profile)

  const spi = calculateSpi(kmEffortV2, hours, envCompensation.totalFactor)
  const spiRaw = calculateSpi(kmEffort, hours, 1.0)
  if (!spi || !spiRaw) return notApplicable('degenerate', '表现分计算所需数值无效')

  const gap = computeTrackGap(track, series)
  if (!gap) return notApplicable('degenerate', '无法计算坡度修正配速')
  // Resolved (not raw) threshold/smoothWindow -- same values that just fed
  // totalAscentM/totalDescentM above -- so climbs/splits' per-segment ascent
  // uses the identical hysteresis settings as the track-total, not merely
  // "the same defaults" (P2 Q2 commit 1; see climbs.ts/splits.ts headers).
  const resolvedStatsOptions = { threshold, smoothWindow }
  const gradeSegments = computeGradeSegments(track, series, resolvedStatsOptions)
  const splits = computeKmSplits(track, series, gap, resolvedStatsOptions)

  return {
    applicable: true,
    spiScore: spi.score,
    spiLevel: spi.level,
    spiRawScore: spiRaw.score,
    spiRawLevel: spiRaw.level,
    kmEffort: Math.round(kmEffort * 10) / 10,
    kmEffortV2: Math.round(kmEffortV2 * 10) / 10,
    totalAscentM,
    totalDescentM,
    totalDistanceM,
    totalTimeS,
    envCompensation,
    gap,
    gradeSegments,
    splits,
  }
}

interface CacheEntry {
  /** `${threshold}:${smoothWindow}:${temperature}:${humidity}` -- like
   * `src/ui/hudStats.ts`'s `statsKey`, recomputed whenever either
   * `statsOptions` or the environmental profile changes even though the
   * `Track` object itself didn't. */
  key: string
  result: PerformanceAnalysis
}

const cache = new WeakMap<Track, CacheEntry>()

function cacheKey(opts: StatsOptions, profile: EnvUserProfile): string {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const smoothWindow = opts.smoothWindow ?? DEFAULT_SMOOTH_WINDOW
  return `${threshold}:${smoothWindow}:${profile.temperature ?? ''}:${profile.humidity ?? ''}`
}

/**
 * Computes (or returns the cached) performance analysis for `track` under
 * `statsOptions` (and an optional environmental `profile`). `WeakMap`-cached
 * per `Track` identity + options, exactly like `src/ui/hudStats.ts#
 * getHudTrackStats` and `core/perf/trackKind.ts#getTrackKind` -- required
 * because this does several O(n) passes over the track (grade, GAP, grade
 * segmentation, km splits, P0 ascent/descent) and must not repeat that on
 * every call for a track that can reach ~330k points.
 */
export function computePerformance(
  track: Track,
  statsOptions: StatsOptions = {},
  profile: EnvUserProfile = {},
): PerformanceAnalysis {
  const key = cacheKey(statsOptions, profile)
  const cached = cache.get(track)
  if (cached && cached.key === key) return cached.result

  const result = analyze(track, statsOptions, profile)
  cache.set(track, { key, result })
  return result
}
