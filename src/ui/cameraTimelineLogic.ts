/**
 * Pure logic behind `KeyframeEditor.tsx`'s keyframe timeline (方案 V2.1
 * §5.5, milestone P3-R3 commit 3): timeline-fraction <-> mileage mapping,
 * and turning checkpoints/climbs into pickable mileage ranges for template
 * application -- no React, no Cesium, unit-testable with plain numbers,
 * same split `checkpointApproach.ts` already establishes for N4's card.
 *
 * ---- Why range selection needs to not be "type two numbers" ----
 * The brief's usability bar is a non-expert composing a 100km route in
 * 10 minutes. Typing exact mileages for "apply 爬升段慢放 to the climb from
 * 32km to 41km" means first knowing there IS a climb there and exactly
 * where it starts/ends -- information the user doesn't have memorised.
 * `checkpointSegments`/`climbSegments` below turn data the app already
 * computed (checkpoint order, `core/perf/climbs.ts#GradeSegment`) into a
 * short, labelled, clickable list instead.
 */
import type { Track } from '../core/model/track'
import type { CheckPoint } from '../core/model/checkpoint'
import type { GradeSegment } from '../core/perf/climbs'
import type { MileageRange } from '../cesium/cameraTemplates'

// ---- Timeline <-> mileage mapping ------------------------------------------

/** Timeline fraction (0..1, e.g. from a pointer x position normalised
 * against the timeline's own width) -> mileage (metres). Mirrors
 * `cesium/cameraPath.ts#progressToMileage`'s own clamping convention
 * (`NaN`/out-of-range fraction clamps rather than propagating), kept as a
 * separate, Cesium-free copy here so `KeyframeEditor.tsx` never has to
 * reach into the `cesium/` dynamic-import boundary just to place a marker
 * on its own timeline. */
export function timelineFractionToMileage(fraction: number, totalMileageM: number): number {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  return f * Math.max(0, totalMileageM)
}

/** Mileage (metres) -> timeline fraction (0..1). `0` for a zero-length
 * route (nothing to divide by), matching
 * `cameraPath.ts#mileageToProgress`'s own zero-length convention. */
export function mileageToTimelineFraction(mileageM: number, totalMileageM: number): number {
  if (!(totalMileageM > 0)) return 0
  const m = Number.isFinite(mileageM) ? Math.min(totalMileageM, Math.max(0, mileageM)) : 0
  return m / totalMileageM
}

// ---- Range pickers ----------------------------------------------------------

export interface PickableRange extends MileageRange {
  /** Stable key for a React list; also usable as the `<option>` value. */
  key: string
  /** Chinese label shown in the picker (e.g. "CP1 单飞石 → CP2 山脊补给"). */
  label: string
}

/** cp's own mileage along `track` (`track.points.cumDist[cp.anchorIndex]`),
 * clamped into the track's valid point range -- same clamp
 * `checkpointApproach.ts#pickApproachingCheckpoint` already applies, for
 * the same reason (a CP anchored before a toolbox decimation op can end up
 * pointing past the now-shorter `points` arrays). `undefined` when the
 * track has no `cumDist` yet. */
export function checkpointMileageM(cp: CheckPoint, track: Track): number | undefined {
  const cumDist = track.points.cumDist
  if (!cumDist || cumDist.length === 0) return undefined
  const idx = Math.min(Math.max(cp.anchorIndex, 0), cumDist.length - 1)
  return cumDist[idx]
}

/**
 * Every checkpoint-to-checkpoint segment on `track`, in track order, PLUS
 * the two edge segments ("起点 -> first CP" and "last CP -> 终点") so the
 * whole route is coverable via checkpoints alone even with just one CP on
 * the track. Filters `cps` to `track.id` itself (same defensive
 * `trackId`-filtering convention `pickApproachingCheckpoint` documents for
 * itself), and to those with a resolvable mileage, then sorts by mileage --
 * `cps` is not guaranteed to already be in track order (it can hold CPs
 * from multiple tracks interleaved, see `state/appStore.ts#reorderCp`'s own
 * comment on that).
 *
 * Returns an empty array for a track with fewer than 1 usable checkpoint or
 * no length (nothing to segment).
 */
export function checkpointSegments(track: Track, cps: CheckPoint[]): PickableRange[] {
  const totalMileageM = totalMileage(track)
  if (!(totalMileageM > 0)) return []

  const onTrack = cps
    .filter((c) => c.trackId === track.id)
    .map((c) => ({ cp: c, mileageM: checkpointMileageM(c, track) }))
    .filter((x): x is { cp: CheckPoint; mileageM: number } => x.mileageM !== undefined)
    .sort((a, b) => a.mileageM - b.mileageM)

  if (onTrack.length === 0) return []

  const ranges: PickableRange[] = []
  if (onTrack[0].mileageM > 0) {
    ranges.push({ key: `start-${onTrack[0].cp.id}`, label: `起点 → ${onTrack[0].cp.name}`, startMileageM: 0, endMileageM: onTrack[0].mileageM })
  }
  for (let i = 0; i < onTrack.length - 1; i++) {
    const a = onTrack[i]
    const b = onTrack[i + 1]
    if (b.mileageM <= a.mileageM) continue // coincident/degenerate anchors -- nothing to select
    ranges.push({ key: `${a.cp.id}-${b.cp.id}`, label: `${a.cp.name} → ${b.cp.name}`, startMileageM: a.mileageM, endMileageM: b.mileageM })
  }
  const lastCp = onTrack[onTrack.length - 1]
  if (lastCp.mileageM < totalMileageM) {
    ranges.push({ key: `${lastCp.cp.id}-end`, label: `${lastCp.cp.name} → 终点`, startMileageM: lastCp.mileageM, endMileageM: totalMileageM })
  }
  return ranges
}

/** `track.points.cumDist`'s last entry, or 0 for a track with no distance
 * column/points -- the same "total mileage" every other pure module in
 * this codebase (`cameraPath.ts#CameraPath.totalMileage`) derives the same
 * way. */
export function totalMileage(track: Track): number {
  const cumDist = track.points.cumDist
  return cumDist && cumDist.length > 0 ? cumDist[cumDist.length - 1] : 0
}

/** Every UPHILL grade segment as a pickable range -- flat/downhill segments
 * are omitted, since "apply 爬升段慢放 to a downhill" doesn't make sense as
 * a one-click option (a user who genuinely wants that can still type exact
 * mileages via the timeline's own drag-to-place keyframes). Label includes
 * length and average grade so the list is scannable without cross-checking
 * the stats panel. */
export function climbSegmentRanges(climbs: GradeSegment[]): PickableRange[] {
  return climbs
    .filter((c) => c.type === 'uphill')
    .map((c, i) => ({
      key: `climb-${i}-${c.startDist}`,
      label: `爬升 ${(c.distance / 1000).toFixed(1)}km · 均坡 ${c.avgGrade.toFixed(0)}%`,
      startMileageM: c.startDist,
      endMileageM: c.endDist,
    }))
}
