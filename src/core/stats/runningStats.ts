/**
 * Running (prefix-sum) statistics along a track (P1 §3.4, milestone N4
 * commit 1). The flythrough HUD needs, at an arbitrary full-precision point
 * index and up to 60 times a second, the cumulative ascent from the start
 * through that point -- `elevation.ts#computeGainLoss` computes a total for
 * a whole array in O(n), and calling it per frame over a growing prefix
 * would make every frame O(n) again (O(n^2) over a full flythrough), which
 * is unusable on a ~330k-point track. This module precomputes the answer
 * for every index ONCE (still O(n), but exactly once per track/settings
 * combination -- see `src/ui/hudStats.ts`'s `WeakMap` cache for the "once
 * per track" half of that), so a frame's lookup is a single array read.
 *
 * `buildRunningGain`/`buildRunningLoss` (and the combined
 * `buildRunningGainLoss`) MUST stay algorithmically identical to
 * `computeGainLoss`'s threshold-hysteresis rule -- their last element is
 * required to equal `computeGainLoss`'s total for the same input (asserted
 * in this module's tests), since P1 acceptance requires the flythrough
 * HUD's ascent figure to agree with the 2D profile / segment table, which
 * both go through `computeGainLoss`. This is not two independent
 * implementations that happen to agree today: `computePrefixGainLoss`
 * below is a line-for-line prefix-accumulating transcription of
 * `computeGainLoss`'s loop, so the two are constrained to stay in sync (any
 * future edit to one's hysteresis rule needs a matching edit here to keep
 * the invariant, but at least they're a diff apart, not a separate
 * algorithm apart).
 */
import { smoothElevation } from './elevation'

export interface RunningGainLoss {
  /** gain[i] = cumulative ascent (metres) from the start of the track
   * through point i, inclusive. Monotonically non-decreasing. */
  gain: Float64Array
  /** loss[i] = cumulative descent (metres), same convention as `gain`. */
  loss: Float64Array
}

/**
 * Line-for-line prefix-accumulating transcription of
 * `elevation.ts#computeGainLoss`'s loop -- see this module's file comment
 * for why the two must be kept in lockstep. `smoothed` is assumed to
 * already have `smoothElevation` applied (callers below do this once, not
 * per-point).
 */
function computePrefixGainLoss(smoothed: Float32Array, threshold: number): RunningGainLoss {
  const n = smoothed.length
  const gain = new Float64Array(n)
  const loss = new Float64Array(n)
  let ref: number | undefined
  let gainAcc = 0
  let lossAcc = 0
  for (let i = 0; i < n; i++) {
    const e = smoothed[i]
    if (Number.isNaN(e)) {
      // Same as computeGainLoss's `continue`: a missing reading neither
      // moves the reference elevation nor breaks the running total -- the
      // prefix simply repeats the previous accumulated value here.
      gain[i] = gainAcc
      loss[i] = lossAcc
      continue
    }
    if (ref === undefined) {
      ref = e
      gain[i] = gainAcc
      loss[i] = lossAcc
      continue
    }
    if (e - ref >= threshold) {
      gainAcc += e - ref
      ref = e
    } else if (ref - e >= threshold) {
      lossAcc += ref - e
      ref = e
    }
    gain[i] = gainAcc
    loss[i] = lossAcc
  }
  return { gain, loss }
}

/**
 * Builds both running-gain and running-loss prefix arrays in one pass.
 * `ele` is the track's RAW elevation column (this smooths it internally
 * with `smoothElevation(ele, smoothWindow)`, exactly matching how
 * `segments.ts#computeSegments` prepares its own input to
 * `computeGainLoss`) -- callers must not pre-smooth before calling this, or
 * the elevation would be smoothed twice and disagree with the segment
 * table's figures.
 *
 * `ele === undefined` (track has no elevation column at all) returns two
 * empty arrays rather than throwing -- callers index these by point index
 * and must already handle "no data at this index" for the single-point
 * NaN case, so an empty array is just the degenerate all-points case of
 * the same situation, not a new failure mode to special-case.
 */
export function buildRunningGainLoss(
  ele: Float32Array | undefined,
  threshold = 5,
  smoothWindow = 5,
): RunningGainLoss {
  if (!ele || ele.length === 0) return { gain: new Float64Array(0), loss: new Float64Array(0) }
  const smoothed = smoothElevation(ele, smoothWindow)
  return computePrefixGainLoss(smoothed, threshold)
}

/** Convenience wrapper over `buildRunningGainLoss` for callers that only
 * need the ascent prefix (e.g. a unit test asserting the gain invariant in
 * isolation). Prefer `buildRunningGainLoss` when both are needed -- it
 * shares the single `smoothElevation` pass instead of paying for it twice. */
export function buildRunningGain(ele: Float32Array | undefined, threshold = 5, smoothWindow = 5): Float64Array {
  return buildRunningGainLoss(ele, threshold, smoothWindow).gain
}

/** Convenience wrapper over `buildRunningGainLoss` for callers that only
 * need the descent prefix. See `buildRunningGain`'s doc comment. */
export function buildRunningLoss(ele: Float32Array | undefined, threshold = 5, smoothWindow = 5): Float64Array {
  return buildRunningGainLoss(ele, threshold, smoothWindow).loss
}

// ---- Local gradient ---------------------------------------------------

/**
 * Local gradient (%) at `index`, matching `ProfileCanvas.tsx`'s hover
 * readout ALGORITHM exactly (this is the extracted, generalised form of
 * what used to be that file's private `localGradientPercent` -- see that
 * file for how it now calls this instead of keeping its own copy). Rise/run
 * over a window of up to `windowPoints` entries on each side of `index`,
 * skipping non-finite (`NaN`/missing) elevation samples at the window's
 * edges so a single dropped reading doesn't collapse the whole window to
 * "no data".
 *
 * Deliberately generic over "point" units (works on any monotonic
 * dist/ele pair, indexed however the caller likes) rather than hard-coded
 * to `ProfileData` -- but in practice both callers feed it the SAME
 * decimated `ProfileData` arrays with the SAME `GRADIENT_WINDOW`:
 * `ProfileCanvas.tsx`'s hover readout (indexed by decimated sample
 * position, unchanged from before this function was extracted out of it)
 * and `src/ui/hudStats.ts`'s flythrough HUD gradient (which maps the
 * engine's full-precision point index to the nearest decimated position
 * first -- see that module's `nearestSamplePos` use). Sharing the exact
 * same decimated array and window, rather than each computing gradient
 * from a differently-scaled window, is what actually *guarantees* "same
 * gradient window" (P1 milestone N4's acceptance requirement) instead of
 * merely aiming for it.
 *
 * Returns `undefined` when there isn't enough finite data in the window to
 * compute a meaningful slope (flat/zero-distance window, or an all-NaN
 * neighbourhood) -- same convention as the pre-extraction implementation.
 */
export function gradientAt(
  ele: ArrayLike<number>,
  dist: ArrayLike<number>,
  index: number,
  windowPoints: number,
): number | undefined {
  const n = ele.length
  if (n === 0) return undefined
  const lo0 = Math.max(0, index - windowPoints)
  const hi0 = Math.min(n - 1, index + windowPoints)
  let lo = lo0
  while (lo <= hi0 && !Number.isFinite(ele[lo])) lo++
  let hi = hi0
  while (hi >= lo0 && !Number.isFinite(ele[hi])) hi--
  if (lo >= hi) return undefined
  const dDist = dist[hi] - dist[lo]
  if (dDist <= 0) return undefined
  const dEle = ele[hi] - ele[lo]
  return (dEle / dDist) * 100
}

/**
 * Window (in samples, on each side of the query position) for `gradientAt`
 * -- the single canonical value both `ProfileCanvas.tsx`'s hover readout
 * and `src/ui/hudStats.ts`'s flythrough HUD gradient use, so neither can
 * silently drift to a different window and disagree on screen. Picked
 * empirically (see the original `ProfileCanvas.tsx` comment this was
 * extracted from): 3 samples on each side (7-wide window) damps metre-level
 * elevation-quantization noise while staying "local" to the spot being
 * inspected.
 */
export const GRADIENT_WINDOW = 3
