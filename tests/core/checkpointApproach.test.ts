import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import type { CheckPoint } from '../../src/core/model/checkpoint'
import { pickApproachingCheckpoint, CP_APPROACH_WINDOW_M, CP_DISMISS_WINDOW_M } from '../../src/ui/checkpointApproach'

// A straight line of points ~100m apart (roughly -- exact spacing doesn't
// matter, only that cumDist grows monotonically) so mileage arithmetic in
// the tests is easy to reason about.
function makeTrack(n = 100): Track {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.001)
  const lat = Array.from({ length: n }, () => 39)
  const t = createTrack({ lon, lat }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

function makeCp(patch: Partial<CheckPoint> & { anchorIndex: number; trackId: string }): CheckPoint {
  return { id: `cp_${patch.anchorIndex}_${patch.trackId}`, name: 'CP', kind: 'cp', ...patch }
}

describe('pickApproachingCheckpoint', () => {
  it('returns undefined when no checkpoint is within range', () => {
    const t = makeTrack()
    const cpMileage = t.points.cumDist![50]
    const cps = [makeCp({ anchorIndex: 50, trackId: t.id })]
    const farBefore = cpMileage - CP_APPROACH_WINDOW_M - 50
    const farAfter = cpMileage + CP_DISMISS_WINDOW_M + 50
    expect(pickApproachingCheckpoint(cps, t, farBefore)).toBeUndefined()
    expect(pickApproachingCheckpoint(cps, t, farAfter)).toBeUndefined()
  })

  it('shows the checkpoint once within the approach window ahead of it', () => {
    const t = makeTrack()
    const cpMileage = t.points.cumDist![50]
    const cp = makeCp({ anchorIndex: 50, trackId: t.id })
    const cps = [cp]
    expect(pickApproachingCheckpoint(cps, t, cpMileage - CP_APPROACH_WINDOW_M + 1)?.id).toBe(cp.id)
    expect(pickApproachingCheckpoint(cps, t, cpMileage - 10)?.id).toBe(cp.id)
    expect(pickApproachingCheckpoint(cps, t, cpMileage)?.id).toBe(cp.id)
  })

  it('keeps showing the checkpoint briefly after passing it, then dismisses', () => {
    const t = makeTrack()
    const cpMileage = t.points.cumDist![50]
    const cp = makeCp({ anchorIndex: 50, trackId: t.id })
    const cps = [cp]
    expect(pickApproachingCheckpoint(cps, t, cpMileage + CP_DISMISS_WINDOW_M - 1)?.id).toBe(cp.id)
    expect(pickApproachingCheckpoint(cps, t, cpMileage + CP_DISMISS_WINDOW_M + 1)).toBeUndefined()
  })

  it('filters out checkpoints belonging to a different track (P0 cross-track leakage regression)', () => {
    const t = makeTrack()
    const otherTrackId = 'trk_other'
    const cpMileage = t.points.cumDist![50]
    const cps = [makeCp({ anchorIndex: 50, trackId: otherTrackId })]
    expect(pickApproachingCheckpoint(cps, t, cpMileage)).toBeUndefined()
  })

  it('two checkpoints close together: the nearer one (by mileage) wins, never both', () => {
    const t = makeTrack()
    const cpA = makeCp({ anchorIndex: 40, trackId: t.id, name: 'A' })
    const cpB = makeCp({ anchorIndex: 42, trackId: t.id, name: 'B' })
    const cps = [cpA, cpB]
    const mileageA = t.points.cumDist![40]
    const mileageB = t.points.cumDist![42]
    const midpoint = (mileageA + mileageB) / 2

    // Approaching from well before both: A (the closer one ahead) wins.
    const result1 = pickApproachingCheckpoint(cps, t, mileageA - 50)
    expect(result1?.id).toBe(cpA.id)

    // Between the two, closer to B: B wins.
    const nearB = mileageB - 5
    const result2 = pickApproachingCheckpoint(cps, t, nearB)
    expect(result2?.id).toBe(cpB.id)

    // Exactly at the midpoint mileage-wise, ties go to whichever the
    // implementation's `<` comparison prefers -- assert it's always
    // exactly one of the two, never both/neither (that's the actual
    // "no unreadable pile" guarantee).
    const resultMid = pickApproachingCheckpoint(cps, t, midpoint)
    expect([cpA.id, cpB.id]).toContain(resultMid?.id)
  })

  it('anchorIndex out of range is clamped rather than throwing', () => {
    const t = makeTrack()
    const cp = makeCp({ anchorIndex: 99999, trackId: t.id })
    expect(() => pickApproachingCheckpoint([cp], t, t.points.cumDist![t.points.cumDist!.length - 1])).not.toThrow()
  })

  it('a track with no cumDist yet returns undefined without throwing', () => {
    const lon = [116, 116.001, 116.002]
    const lat = [39, 39, 39]
    const t = createTrack({ lon, lat }, { name: 'x', format: 'gpx', fileName: 'x.gpx' }) // cumDist left unset
    const cp = makeCp({ anchorIndex: 1, trackId: t.id })
    expect(() => pickApproachingCheckpoint([cp], t, 0)).not.toThrow()
    expect(pickApproachingCheckpoint([cp], t, 0)).toBeUndefined()
  })

  it('is a pure function of the current mileage snapshot: re-evaluating at an earlier mileage after a later one gives the same answer a fresh call would (no seek-backward burst/replay state)', () => {
    const t = makeTrack()
    const cp = makeCp({ anchorIndex: 50, trackId: t.id })
    const cps = [cp]
    const cpMileage = t.points.cumDist![50]

    // Simulate: approach, pass, dismiss, then seek backwards into the
    // approach window again.
    const afterDismiss = pickApproachingCheckpoint(cps, t, cpMileage + CP_DISMISS_WINDOW_M + 50)
    expect(afterDismiss).toBeUndefined()
    const seekBackIntoWindow = pickApproachingCheckpoint(cps, t, cpMileage - 10)
    expect(seekBackIntoWindow?.id).toBe(cp.id)
    // And a fresh, independent call at the same mileage agrees exactly.
    expect(pickApproachingCheckpoint(cps, t, cpMileage - 10)?.id).toBe(cp.id)
  })
})
