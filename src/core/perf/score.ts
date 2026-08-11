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
 * PI = min(1000, round(C * (kme_v2 / hours)^K * envFactor))
 *   C = 30.0   calibration constant (dual-anchor derived, see below)
 *   K = 1.25   speed exponent (super-linear: faster efforts gain more,
 *              matching competitive stratification)
 *   kme_v2 = dist_km + ascent_m/100 + descent_m/150
 *
 * Dual-anchor calibration (from the reference's own header comment):
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
 * Consequence: feeding a different ascent into kme_v2 shifts PI
 * systematically relative to the reference (P0's algorithm was validated
 * against 崇礼168's official gain and reads ~4.8% LOWER than a naive
 * diff-sum on that route, which is directionally similar to but not
 * identical in magnitude to the reference's own dead-zone accumulator). The
 * LEVELS thresholds below are kept AS THE REFERENCE CALIBRATED THEM
 * (精英级 700 / 优秀 500 / 良好 380 / 中等 200 / 入门 0) -- this is a
 * deliberate non-decision, not an endorsement: recalibrating them is a
 * product judgement call for the user, not something this port should do
 * unilaterally. See this module's test suite (`real recordings` block) and
 * the milestone report for the measured shift on real tracks, both with
 * TrailCraft's ascent and the reference's own algorithm on the same inputs.
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

// ── Power-law model parameters (dual-anchor derived) ──────────────────────
const SPI_C = 30.0
const SPI_K = 1.25

export type PerformanceLevel = '精英级' | '优秀' | '良好' | '中等' | '入门'

/**
 * Level thresholds, kept exactly as the reference calibrated them. See this
 * file's header comment for why they are NOT re-derived here even though
 * P0's ascent algorithm shifts PI relative to the reference.
 */
const LEVELS: { threshold: number; label: PerformanceLevel }[] = [
  { threshold: 700, label: '精英级' },
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
  const score = Math.round(Math.min(SPI_C * speed ** SPI_K * envFactor, 1000))
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
