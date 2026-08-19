/**
 * Track-free "quick calculator" mode (user-requested addition alongside the
 * P2 表现分析 report -- see `PerformancePanel.tsx`'s file comment for that
 * report; this is a sibling entry point, not a replacement).
 *
 * The user's own words: 「表现分析加一个速算模式 输入距离 爬升 用时
 * 即可简便计算出表现分 同时列出各分段预估用时」 -- enter distance/ascent/
 * finish time by hand, no track needed, get the score plus estimated
 * per-segment splits. This module holds the pure logic; `QuickCalcPanel.tsx`
 * is the (untested, per project convention -- no jsdom) UI shell around it.
 *
 * Deliberately reuses, rather than reinvents:
 *  - `core/perf/score.ts#calculateSpi`/`LEVELS` for the score itself -- it
 *    already takes plain (kme, hours, envFactor) numbers, exactly what a
 *    track-free calculator has.
 *  - `core/pace/models.ts#practicalSegmentTime` for the split-time shape --
 *    same fatigue-aware model the sidebar's 配速与关门预警 panel already
 *    uses on `paceParams` from `state/appStore.ts`, not a second pace model.
 */
import type { PaceParams, SegmentLike } from '../pace/models'
import { practicalSegmentTime } from '../pace/models'

/** `dist_km + ascent_m/100 + descent_m/150` -- same v2 km-effort formula
 * `core/perf/score.ts#analyze` derives from a real track's ascent/descent,
 * here taken directly from the calculator's manual inputs. No positivity
 * guard here (that's `calculateSpi`'s job, on the composed kme/hours pair) --
 * this is pure arithmetic and never produces `NaN` for finite inputs. */
export function computeKmEffortV2(distKm: number, ascentM: number, descentM: number): number {
  return distKm + ascentM / 100 + descentM / 150
}

// ── Split estimates ─────────────────────────────────────────────────────

/**
 * Segment length (km) to split the course into, picked by total distance --
 * the brief's own suggestion: "per 10 km is reasonable for long courses, per
 * 5 km for short ones". 50 km is the cutover: it's both the median-ish
 * boundary in `racePresets.ts`'s own "按距离" tier (50K sits at the short
 * end of that list, 70K+ at the long end) and a common "past this, ultra
 * pacing strategy usually shifts to ~10 km aid-station-scale planning"
 * convention. Courses at exactly 50 km get the finer 5 km split (`> 50`, not
 * `>= 50`) since a marathon-plus-a-bit still benefits from closer checkpoints.
 */
export function segmentLengthKm(distKm: number): number {
  return distKm > 50 ? 10 : 5
}

/**
 * How many segments `distKm` splits into at `segmentLengthKm`'s resolution,
 * rounded to the nearest whole segment (never zero for a positive distance)
 * -- e.g. 57 km at the 10 km resolution rounds to 6 segments of 9.5 km each,
 * not 5 segments of 10 km + one awkward 7 km tail. Equal-length segments
 * (rather than "10 km, 10 km, ..., short remainder") keep every split a
 * comparable size, which is what a pacing guide is for.
 */
export function segmentCount(distKm: number): number {
  if (!(distKm > 0)) return 0
  const segLen = segmentLengthKm(distKm)
  return Math.max(1, Math.round(distKm / segLen))
}

export interface QuickSplit {
  /** 1-based split number. */
  index: number
  /** This split's distance, km (equal for every split except possibly
   * differing by float rounding -- `distKm` isn't generally a multiple of
   * `segmentLengthKm`). */
  distanceKm: number
  /** Ascent assumed for this split, m -- `totalAscentM` distributed evenly
   * across segments by distance share (see this file's header: there is no
   * real per-segment profile without a track). */
  ascentM: number
  /** Descent assumed for this split, m -- same even-distribution caveat. */
  descentM: number
  /** Estimated duration of just this split, s. */
  segmentTimeSec: number
  /** Estimated elapsed time from the start through the END of this split,
   * s -- what a runner actually checks against a cutoff. */
  cumulativeTimeSec: number
}

/**
 * Distributes `finishTimeSec` across `segmentCount(distKm)` equal-length
 * segments using P0's `practicalSegmentTime` pace model, weighted by each
 * segment's assumed (evenly-distributed) ascent/descent and by the fatigue
 * that model already grows with elapsed time -- NOT a flat per-km division.
 *
 * Two-pass approach: `practicalSegmentTime` needs an absolute elapsed-time
 * scale for its fatigue term, but the whole point here is that the user's
 * *actual* finish time is the thing being distributed, not predicted. So
 * pass 1 runs the model forward in its own "raw" time scale (starting at
 * elapsed=0, exactly like `estimateArrivals` does) to get each segment's
 * RELATIVE weight -- how much longer a segment with more climb/descent/
 * elapsed-fatigue should take than a flatter, earlier one. Pass 2 scales
 * every raw segment time by the single constant `finishTimeSec / rawTotal`
 * so the segments sum to exactly the entered finish time while preserving
 * those relative proportions (uniform scaling can't change which segment is
 * relatively slower than which). This is an approximation -- the real
 * fatigue-vs-elapsed-time curve is evaluated in raw-model time, not the
 * user's actual pace -- but it's the honest cost of the model needing SOME
 * time scale before the real one is known, and it still means a course with
 * back-loaded climbing gets back-loaded splits, not a flat division.
 *
 * Degenerate inputs (`distKm<=0`, `finishTimeSec<=0`) return `[]` rather
 * than risking a NaN/divide-by-zero downstream. `ascentM`/`descentM` are
 * clamped to >=0 (a caller typo of a negative figure shouldn't propagate).
 * If the raw pass produces a non-positive or non-finite total (e.g. a
 * degenerate `paceParams` with every rate at 0), falls back to a flat
 * per-segment division rather than dividing by zero.
 */
export function computeQuickSplits(
  distKm: number,
  ascentM: number,
  descentM: number,
  finishTimeSec: number,
  paceParams: PaceParams,
): QuickSplit[] {
  if (!(distKm > 0) || !(finishTimeSec > 0)) return []

  const ascent = Math.max(0, ascentM)
  const descent = Math.max(0, descentM)
  const n = segmentCount(distKm)
  const segDistKm = distKm / n
  const segAscent = ascent / n
  const segDescent = descent / n

  const seg: SegmentLike = { dist: segDistKm * 1000, gain: segAscent, loss: segDescent }

  // Pass 1: raw relative weights in the model's own time scale.
  const raw: number[] = []
  let rawElapsed = 0
  for (let i = 0; i < n; i++) {
    const t = practicalSegmentTime(seg, paceParams, rawElapsed)
    raw.push(t)
    rawElapsed += t
  }
  const rawTotal = raw.reduce((a, b) => a + b, 0)
  const scale = Number.isFinite(rawTotal) && rawTotal > 0 ? finishTimeSec / rawTotal : NaN

  const splits: QuickSplit[] = []
  let cumulative = 0
  for (let i = 0; i < n; i++) {
    const segmentTimeSec = Number.isFinite(scale) ? raw[i] * scale : finishTimeSec / n
    cumulative += segmentTimeSec
    splits.push({
      index: i + 1,
      distanceKm: segDistKm,
      ascentM: segAscent,
      descentM: segDescent,
      segmentTimeSec,
      cumulativeTimeSec: cumulative,
    })
  }
  return splits
}
