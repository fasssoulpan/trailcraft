/**
 * Pure "checkpoints as radar targets" maths (P1 §3.7 follow-up -- the radar's
 * open question, per §3.7's own "待确认的理解" callout, is resolved as
 * "both": range rings stay as a scale reference, checkpoints become the
 * targets on the scope, with the next checkpoint ahead as the primary
 * readout). Same split as `radarMath.ts` (pure ring geometry) vs
 * `radarRender.ts` (the untestable-in-Node canvas half) -- this module knows
 * nothing about Canvas/Cesium/React, so it runs under Vitest's plain `node`
 * environment exactly like `radarMath.ts` and `ui/checkpointApproach.ts` do.
 *
 * ---- Why a separate `gain` parameter instead of computing it here ----
 * Remaining climb needs `core/stats/runningStats.ts#buildRunningGain`'s
 * O(track length) prefix array, which must be built ONCE per (track,
 * threshold, smoothWindow) and reused, not recomputed every call -- exactly
 * the problem `src/ui/hudStats.ts#getHudTrackStats`'s `WeakMap` cache
 * already solves for the HUD's own ascent figure. Rather than duplicating
 * that cache here, this function takes the prefix array as a plain
 * argument: the caller (the radar's per-frame wiring, alongside
 * `HudOverlay`'s own `onProgress` tick) passes in `getHudTrackStats(track,
 * statsOptions).gain` directly, so the two consumers of "cumulative ascent
 * through point i" share the exact one cache entry instead of paying for
 * two independent O(n) passes over the same track. This keeps
 * `buildRadarTargets` itself O(number of checkpoints) per call, cheap enough
 * to call every frame regardless of track size.
 *
 * ---- Cross-track filtering ----
 * Filters `cps` down to `cp.trackId === track.id` itself, same defensive
 * convention `checkpointApproach.ts#pickApproachingCheckpoint` documents (the
 * exact class of bug P0 fixed once already -- checkpoints leaking across
 * tracks) -- never trusts a caller to have pre-filtered.
 */
import type { Track } from '../core/model/track'
import type { CheckPoint, CpKind } from '../core/model/checkpoint'
import { haversine } from '../core/geo/distance'
import { bearingDegrees } from '../cesium/cameraPath'
import { formatCheckpointCutoff } from '../ui/checkpointApproach'

const DEG2RAD = Math.PI / 180
const TWO_PI = Math.PI * 2

/** Wraps a radian angle into `[0, 2*PI)`. */
function normalizeRad(rad: number): number {
  return ((rad % TWO_PI) + TWO_PI) % TWO_PI
}

function clampIndex(i: number, n: number): number {
  if (!Number.isFinite(i)) return 0
  return Math.min(Math.max(Math.round(i), 0), n - 1)
}

export interface RadarTarget {
  id: string
  kind: CpKind
  name: string
  /** Straight-line (haversine) distance from the current position, metres --
   * "as the crow flies", deliberately NOT the along-track distance (see
   * `RadarTargetSet.next.remainingDistanceM` for that one) -- this is what a
   * radar blip's RADIUS on the scope should be scaled from. */
  distanceM: number
  /** Bearing relative to the camera heading, radians, wrapped into
   * `[0, 2*PI)` -- `0` means dead ahead (screen-up), matching
   * `radarRender.ts`'s own tick/north-marker convention
   * (`screenAngle = bearingRad - headingRad`), so a target dead ahead of the
   * camera always plots at the top of the scope regardless of which way the
   * camera is currently facing. */
  bearingRad: number
  /** True once this checkpoint has already been passed along the track
   * (`anchorIndex <= currentIndex`) -- distinguishes a target behind the
   * runner from one still ahead. */
  passed: boolean
  /** True for exactly the single "next checkpoint ahead" (see
   * `RadarTargetSet.next`) -- never true for more than one target, and never
   * true for a `passed` target. */
  isNext: boolean
}

export interface NextCheckpointInfo {
  id: string
  name: string
  kind: CpKind
  /** Remaining ALONG-TRACK distance to this checkpoint, metres -- a
   * `track.points.cumDist` difference, not straight-line: a runner cares
   * about trail distance, and on a switchback these can differ enormously
   * from a target's `distanceM` above. Always `>= 0`. */
  remainingDistanceM: number
  /** Remaining climb to this checkpoint, metres -- a `buildRunningGain`
   * prefix difference (see this module's file comment for where `gain`
   * comes from). `undefined` when the track has no elevation column at all
   * (an empty `gain` array) -- never reported as `0`, which would
   * misrepresent "no data" as "flat". */
  remainingClimbM: number | undefined
  /** Formatted local "HH:mm" cutoff time (via
   * `checkpointApproach.ts#formatCheckpointCutoff`, the same formatter the
   * checkpoint-approach card uses), or `undefined` when the checkpoint has
   * no cutoff time set. */
  cutoff: string | undefined
}

export interface RadarTargetSet {
  /** One entry per checkpoint belonging to `track`, in `cps`' own order. */
  targets: RadarTarget[]
  /** The single next checkpoint ahead of `currentIndex` -- the checkpoint
   * with the smallest `anchorIndex` strictly greater than `currentIndex` --
   * or `undefined` when there are no checkpoints ahead (no checkpoints at
   * all, all of them already passed, or the track has no `cumDist` yet to
   * measure remaining distance against). */
  next: NextCheckpointInfo | undefined
}

/**
 * Builds the radar's target set: every checkpoint on `track` plotted as a
 * blip (distance + camera-relative bearing + passed/ahead), plus the single
 * next-checkpoint-ahead readout.
 *
 * `currentIndex` is a full-precision point index into `track.points`
 * (rounded/clamped defensively, matching `hudStats.ts#computeHudReadout`'s
 * own convention). `headingRad` is the camera's heading, radians clockwise
 * from north (Cesium's own convention, same as `radarRender.ts`'s
 * `RadarDrawOptions.headingRad`). `gain` is the track's running-ascent
 * prefix array (see this module's file comment) -- pass `undefined` or an
 * empty array for a track with no elevation column.
 */
export function buildRadarTargets(
  track: Track,
  cps: CheckPoint[],
  currentIndex: number,
  headingRad: number,
  gain: Float64Array | undefined,
): RadarTargetSet {
  const n = track.points.lon.length
  if (n === 0) return { targets: [], next: undefined }

  const idx = clampIndex(currentIndex, n)
  const lon0 = track.points.lon[idx]
  const lat0 = track.points.lat[idx]
  const cumDist = track.points.cumDist
  const hasCumDist = cumDist !== undefined && cumDist.length > 0

  const relevant = cps.filter((cp) => cp.trackId === track.id)

  // "Next ahead" = smallest anchorIndex strictly greater than idx -- being
  // exactly ON a checkpoint (anchorIndex === idx) counts as already reached,
  // not "next", matching pickApproachingCheckpoint's own <= vs > convention
  // for "passed".
  let nextCp: CheckPoint | undefined
  let nextAnchorIdx = -1
  for (const cp of relevant) {
    const a = clampIndex(cp.anchorIndex, n)
    if (a > idx && (nextCp === undefined || a < nextAnchorIdx)) {
      nextCp = cp
      nextAnchorIdx = a
    }
  }
  // Only meaningful as a "next" target when there's cumDist to measure
  // remaining distance against -- see `RadarTargetSet.next`'s doc comment.
  const haveNext = nextCp !== undefined && hasCumDist

  const targets: RadarTarget[] = relevant.map((cp) => {
    const a = clampIndex(cp.anchorIndex, n)
    const lon1 = track.points.lon[a]
    const lat1 = track.points.lat[a]
    const distanceM = haversine(lon0, lat0, lon1, lat1)
    const absBearingDeg = bearingDegrees({ lon: lon0, lat: lat0 }, { lon: lon1, lat: lat1 })
    const bearingRad = normalizeRad(absBearingDeg * DEG2RAD - headingRad)
    return {
      id: cp.id,
      kind: cp.kind,
      name: cp.name,
      distanceM,
      bearingRad,
      passed: a <= idx,
      isNext: haveNext && cp.id === nextCp!.id,
    }
  })

  let next: NextCheckpointInfo | undefined
  if (haveNext) {
    const remainingDistanceM = Math.max(0, cumDist![nextAnchorIdx] - cumDist![idx])
    const remainingClimbM =
      gain && gain.length > 0
        ? Math.max(0, gain[Math.min(nextAnchorIdx, gain.length - 1)] - gain[Math.min(idx, gain.length - 1)])
        : undefined
    next = {
      id: nextCp!.id,
      name: nextCp!.name,
      kind: nextCp!.kind,
      remainingDistanceM,
      remainingClimbM,
      cutoff: formatCheckpointCutoff(nextCp!.cutoffTime),
    }
  }

  return { targets, next }
}
