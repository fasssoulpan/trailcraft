/**
 * Pure "which checkpoint card should be showing right now" decision (P1
 * §3.1/§3.4, milestone N4 commit 3) -- no React, no Cesium, unit-testable
 * with plain numbers. `CheckpointCard.tsx` is the thin rendering half that
 * calls this every frame from the flythrough engine's `onProgress`
 * callback and only actually re-renders when its result changes.
 *
 * ---- Approach window, in mileage ----
 * "Approaching" is defined in MILEAGE, not point index or elapsed time: a
 * fixed number of points means wildly different real distances on tracks
 * with different GPS sampling rates (a device logging once per second on a
 * fast downhill segment packs far more points per real metre than one
 * logging once per 5 seconds on a climb), and time-until-arrival depends on
 * the user's current playback speed multiplier (1x-20x) in a way that would
 * make the SAME physical stretch of trail trigger the card at wildly
 * different camera positions depending on what speed happened to be
 * selected. Mileage is the only one of the three that means the same thing
 * regardless of sampling rate or playback speed.
 *
 * `CP_APPROACH_WINDOW_M` / `CP_DISMISS_WINDOW_M` are named constants (not
 * inlined) precisely so this behaviour is a single, documented, tunable
 * number rather than something a future edit has to go hunting for.
 */
import type { Track } from '../core/model/track'
import type { CheckPoint } from '../core/model/checkpoint'

/** Card starts showing this many metres BEFORE the runner reaches the
 * checkpoint. 300m: roughly a couple of minutes' running-time runway at
 * typical trail pace, and close enough to the checkpoint at 1x-2x playback
 * that a viewer reading the card still has time to look up and see the
 * checkpoint's marker/aid station coming into view. */
export const CP_APPROACH_WINDOW_M = 300

/** Card keeps showing for this many metres AFTER the runner has passed the
 * checkpoint, then dismisses. Deliberately much shorter than the approach
 * window -- once you've passed a checkpoint there's nothing left to read it
 * for, so it should get out of the way quickly rather than linger and
 * compete with the next one. */
export const CP_DISMISS_WINDOW_M = 120

export interface ApproachCandidate {
  cp: CheckPoint
  /** Checkpoint's own mileage (metres) along the track, i.e.
   * `track.points.cumDist[cp.anchorIndex]`. */
  cpMileageM: number
  /** `cpMileageM - mileageM`: positive while still ahead, negative once
   * passed. Exposed (not just the winner) so callers/tests can see WHY a
   * particular checkpoint won over a nearby one. */
  deltaM: number
}

/**
 * Picks which single checkpoint (if any) should be shown as an "approaching
 * checkpoint" card at `mileageM` along `track`.
 *
 * ---- Multiple checkpoints close together ----
 * Policy: show only the NEAREST qualifying checkpoint (smallest
 * `|deltaM|`), never more than one at a time. Two checkpoints spaced closer
 * than `CP_APPROACH_WINDOW_M + CP_DISMISS_WINDOW_M` apart (e.g. a gear
 * check immediately before an aid station) would otherwise both be "in
 * range" simultaneously for part of the approach; queueing them (show A,
 * then B once A dismisses) was considered but rejected -- it would delay
 * the SECOND checkpoint's card past the point the runner is already
 * passing it on a tightly-spaced pair, which is worse than briefly not
 * mentioning it at all. "Nearest wins" means the runner always sees a card
 * relevant to what's immediately in front of the camera, at the cost of a
 * closely-trailing checkpoint sometimes not getting its own card -- an
 * acceptable trade the milestone brief leaves to this documented choice.
 *
 * ---- Stateless by design ----
 * This is a pure function of the CURRENT `mileageM` snapshot only -- it has
 * no memory of which checkpoints were already shown/dismissed. That's
 * deliberate: it's what makes scrubbing backwards behave sensibly. A
 * stateful "have I shown this one yet" tracker would need explicit
 * resetting on every seek (forward OR backward) to avoid either replaying
 * cards the user already saw or missing ones after a backward jump; a pure
 * re-evaluation at the new mileage needs no such bookkeeping and cannot
 * "replay a burst" of anything, because there is no history to replay --
 * whoever the caller was previously showing, the very next `update()` call
 * (from `CheckpointCard.tsx`) just recomputes and swaps to whatever is
 * correct for wherever the scrubber landed.
 *
 * ---- Cross-track filtering ----
 * Filters `cps` down to `cp.trackId === track.id` itself, rather than
 * trusting the caller to have pre-filtered -- the exact class of bug P0
 * fixed once already (checkpoints leaking across tracks), and
 * `cpEntities.ts`/`SegmentTable.tsx` both re-establish this same filter at
 * their own call sites rather than relying on a caller's discipline, so
 * this module follows the same defensive convention.
 */
export function pickApproachingCheckpoint(
  cps: CheckPoint[],
  track: Track,
  mileageM: number,
): CheckPoint | undefined {
  const cumDist = track.points.cumDist
  if (!cumDist || cumDist.length === 0) return undefined

  let best: ApproachCandidate | undefined
  for (const cp of cps) {
    if (cp.trackId !== track.id) continue
    const idx = Math.min(Math.max(cp.anchorIndex, 0), cumDist.length - 1)
    const cpMileageM = cumDist[idx]
    const deltaM = cpMileageM - mileageM
    if (deltaM > CP_APPROACH_WINDOW_M || deltaM < -CP_DISMISS_WINDOW_M) continue
    const absDelta = Math.abs(deltaM)
    if (!best || absDelta < Math.abs(best.deltaM)) best = { cp, cpMileageM, deltaM }
  }
  return best?.cp
}
