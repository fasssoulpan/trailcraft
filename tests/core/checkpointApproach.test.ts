import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import { CP_KIND_COLORS, CP_KIND_LABELS, type CheckPoint } from '../../src/core/model/checkpoint'
import {
  pickApproachingCheckpoint,
  buildCheckpointCardData,
  formatCheckpointCutoff,
  CP_APPROACH_WINDOW_M,
  CP_DISMISS_WINDOW_M,
} from '../../src/ui/checkpointApproach'

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

// buildCheckpointCardData/formatCheckpointCutoff are the shared formatting
// layer both CheckpointCard.tsx (DOM) and cesium/recorder.ts's video
// compositor (canvas, milestone N5) read from -- see buildCheckpointCardData's
// own doc comment for why this must stay the one place a checkpoint's card
// content gets formatted.
describe('formatCheckpointCutoff', () => {
  it('formats an ISO timestamp as local HH:mm', () => {
    const iso = new Date(2026, 7, 6, 14, 5).toISOString()
    expect(formatCheckpointCutoff(iso)).toBe('14:05')
  })

  it('pads single-digit hours/minutes with a leading zero', () => {
    const iso = new Date(2026, 7, 6, 9, 5).toISOString()
    expect(formatCheckpointCutoff(iso)).toBe('09:05')
  })

  it('returns undefined for an absent or unparsable timestamp', () => {
    expect(formatCheckpointCutoff(undefined)).toBeUndefined()
    expect(formatCheckpointCutoff('not-a-date')).toBeUndefined()
  })
})

describe('buildCheckpointCardData', () => {
  it('carries the kind label/colour from the same maps the 2D marker/3D pin use', () => {
    const t = makeTrack()
    const cp = makeCp({ anchorIndex: 10, trackId: t.id, kind: 'danger', name: '危险路段' })
    const data = buildCheckpointCardData(cp, t)
    expect(data.kindLabel).toBe(CP_KIND_LABELS.danger)
    expect(data.color).toBe(CP_KIND_COLORS.danger)
    expect(data.name).toBe('危险路段')
    expect(data.id).toBe(cp.id)
  })

  it('reports mileage in km from the track cumDist at the (clamped) anchor index', () => {
    const t = makeTrack()
    const cp = makeCp({ anchorIndex: 50, trackId: t.id })
    const data = buildCheckpointCardData(cp, t)
    expect(data.mileageKm).toBeCloseTo(t.points.cumDist![50] / 1000, 6)
  })

  it('clamps an out-of-range anchorIndex instead of throwing/returning undefined mileage', () => {
    const t = makeTrack()
    const cp = makeCp({ anchorIndex: 99999, trackId: t.id })
    expect(() => buildCheckpointCardData(cp, t)).not.toThrow()
    const data = buildCheckpointCardData(cp, t)
    expect(data.mileageKm).toBeCloseTo(t.points.cumDist![t.points.cumDist!.length - 1] / 1000, 6)
  })

  it('mileageKm is undefined when the track has no cumDist yet', () => {
    const lon = [116, 116.001, 116.002]
    const lat = [39, 39, 39]
    const t = createTrack({ lon, lat }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
    const cp = makeCp({ anchorIndex: 1, trackId: t.id })
    expect(buildCheckpointCardData(cp, t).mileageKm).toBeUndefined()
  })

  it('eleM is undefined when the track has no elevation column', () => {
    const t = makeTrack()
    const cp = makeCp({ anchorIndex: 10, trackId: t.id })
    expect(buildCheckpointCardData(cp, t).eleM).toBeUndefined()
  })

  it('carries a formatted cutoff when the checkpoint has one, undefined otherwise', () => {
    const t = makeTrack()
    const withCutoff = makeCp({ anchorIndex: 10, trackId: t.id, cutoffTime: new Date(2026, 7, 6, 14, 0).toISOString() })
    expect(buildCheckpointCardData(withCutoff, t).cutoff).toBe('14:00')
    const withoutCutoff = makeCp({ anchorIndex: 10, trackId: t.id })
    expect(buildCheckpointCardData(withoutCutoff, t).cutoff).toBeUndefined()
  })
})
