import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import type { CheckPoint } from '../../src/core/model/checkpoint'
import { buildRunningGain } from '../../src/core/stats/runningStats'
import { buildRadarTargets } from '../../src/overlay/radarTargets'

const DEG2RAD = Math.PI / 180

// A straight line of points ~100m apart heading due east, mirroring
// tests/core/checkpointApproach.test.ts's own fixture -- exact spacing
// doesn't matter, only that cumDist grows monotonically.
function makeTrack(n = 100, withEle = false): Track {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.001)
  const lat = Array.from({ length: n }, () => 39)
  const ele = withEle ? Array.from({ length: n }, (_, i) => i) : undefined // steady 1m/point climb
  const t = createTrack({ lon, lat, ele }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

// A hairpin: heads east for 10 segments, then heads back to end up
// physically right next to the START point again -- so a checkpoint
// anchored at the far (in track-distance) end is nonetheless close by
// straight-line distance, letting the along-track/straight-line divergence
// be asserted directly rather than just trusted.
function makeSwitchbackTrack(): Track {
  const lon: number[] = []
  const lat: number[] = []
  for (let i = 0; i <= 10; i++) {
    lon.push(116 + i * 0.001)
    lat.push(39)
  }
  for (let i = 1; i <= 10; i++) {
    lon.push(116 + (10 - i) * 0.001)
    lat.push(39.00005)
  }
  const t = createTrack({ lon, lat }, { name: 'switchback', format: 'gpx', fileName: 'x.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

function makeCp(patch: Partial<CheckPoint> & { anchorIndex: number; trackId: string }): CheckPoint {
  return { id: `cp_${patch.anchorIndex}_${patch.trackId}_${Math.random()}`, name: 'CP', kind: 'cp', ...patch }
}

describe('buildRadarTargets', () => {
  it('returns empty targets and no next checkpoint when there are no checkpoints at all', () => {
    const t = makeTrack()
    const result = buildRadarTargets(t, [], 10, 0, undefined)
    expect(result.targets).toEqual([])
    expect(result.next).toBeUndefined()
  })

  it('single checkpoint ahead: appears in targets and is the next checkpoint', () => {
    const t = makeTrack()
    const cp = makeCp({ anchorIndex: 50, trackId: t.id })
    const result = buildRadarTargets(t, [cp], 10, 0, undefined)
    expect(result.targets).toHaveLength(1)
    expect(result.targets[0].id).toBe(cp.id)
    expect(result.targets[0].passed).toBe(false)
    expect(result.targets[0].isNext).toBe(true)
    expect(result.next?.id).toBe(cp.id)
  })

  it('single checkpoint already behind: not next, marked passed', () => {
    const t = makeTrack()
    const cp = makeCp({ anchorIndex: 5, trackId: t.id })
    const result = buildRadarTargets(t, [cp], 50, 0, undefined)
    expect(result.targets[0].passed).toBe(true)
    expect(result.targets[0].isNext).toBe(false)
    expect(result.next).toBeUndefined()
  })

  it('filters out checkpoints belonging to a different track (P0 cross-track leakage regression)', () => {
    const t = makeTrack()
    const other = makeCp({ anchorIndex: 50, trackId: 'trk_other' })
    const result = buildRadarTargets(t, [other], 10, 0, undefined)
    expect(result.targets).toEqual([])
    expect(result.next).toBeUndefined()
  })

  describe('next-checkpoint selection', () => {
    it('picks the checkpoint with the smallest anchorIndex greater than currentIndex', () => {
      const t = makeTrack()
      const near = makeCp({ anchorIndex: 30, trackId: t.id, name: 'near' })
      const far = makeCp({ anchorIndex: 60, trackId: t.id, name: 'far' })
      const result = buildRadarTargets(t, [far, near], 10, 0, undefined)
      expect(result.next?.id).toBe(near.id)
    })

    it('currentIndex exactly ON a checkpoint counts as already reached, not next', () => {
      const t = makeTrack()
      const here = makeCp({ anchorIndex: 40, trackId: t.id, name: 'here' })
      const ahead = makeCp({ anchorIndex: 60, trackId: t.id, name: 'ahead' })
      const result = buildRadarTargets(t, [here, ahead], 40, 0, undefined)
      const hereTarget = result.targets.find((tg) => tg.id === here.id)!
      expect(hereTarget.passed).toBe(true)
      expect(hereTarget.isNext).toBe(false)
      expect(result.next?.id).toBe(ahead.id)
    })

    it('past the last checkpoint: everything passed, no next', () => {
      const t = makeTrack()
      const cp = makeCp({ anchorIndex: 20, trackId: t.id })
      const result = buildRadarTargets(t, [cp], 99, 0, undefined)
      expect(result.targets[0].passed).toBe(true)
      expect(result.next).toBeUndefined()
    })

    it('multiple checkpoints ahead: only the nearest-by-index is flagged isNext, never more than one', () => {
      const t = makeTrack()
      const cps = [10, 20, 30, 40].map((idx) => makeCp({ anchorIndex: idx, trackId: t.id }))
      const result = buildRadarTargets(t, cps, 0, 0, undefined)
      const flagged = result.targets.filter((tg) => tg.isNext)
      expect(flagged).toHaveLength(1)
      expect(flagged[0].id).toBe(cps[0].id) // anchorIndex 10, the smallest > 0
    })
  })

  describe('along-track vs straight-line distance', () => {
    it('genuinely differ on a synthetic switchback', () => {
      const t = makeSwitchbackTrack()
      const cp = makeCp({ anchorIndex: 20, trackId: t.id }) // physically back near the start
      const result = buildRadarTargets(t, [cp], 0, 0, undefined)
      const target = result.targets[0]
      // Straight-line: point 20 is only ~5.5m north of point 0.
      expect(target.distanceM).toBeLessThan(50)
      // Along-track: the full out-and-back route, over a kilometre.
      expect(result.next?.remainingDistanceM).toBeGreaterThan(1000)
      // The whole point: these must not be approximately equal.
      expect(result.next!.remainingDistanceM).toBeGreaterThan(target.distanceM * 10)
    })
  })

  describe('remaining climb', () => {
    it('equals the buildRunningGain prefix difference', () => {
      const t = makeTrack(100, true)
      const gain = buildRunningGain(t.points.ele)
      const cp = makeCp({ anchorIndex: 50, trackId: t.id })
      const result = buildRadarTargets(t, [cp], 10, 0, gain)
      expect(result.next?.remainingClimbM).toBeCloseTo(gain[50] - gain[10], 6)
      expect(result.next?.remainingClimbM).toBeGreaterThan(0)
    })

    it('is undefined (not 0) when the track has no elevation column', () => {
      const t = makeTrack(100, false)
      const cp = makeCp({ anchorIndex: 50, trackId: t.id })
      const result = buildRadarTargets(t, [cp], 10, 0, undefined)
      expect(result.next?.remainingClimbM).toBeUndefined()
      // Also true when handed an explicitly-empty gain array (what
      // buildRunningGain itself returns for an ele-less track).
      const result2 = buildRadarTargets(t, [cp], 10, 0, new Float64Array(0))
      expect(result2.next?.remainingClimbM).toBeUndefined()
    })
  })

  describe('cutoff time', () => {
    it('carries the formatted cutoff when set, undefined otherwise', () => {
      const t = makeTrack()
      const withCutoff = makeCp({
        anchorIndex: 50,
        trackId: t.id,
        cutoffTime: new Date(2026, 7, 6, 14, 0).toISOString(),
      })
      const result = buildRadarTargets(t, [withCutoff], 10, 0, undefined)
      expect(result.next?.cutoff).toBe('14:00')

      const withoutCutoff = makeCp({ anchorIndex: 50, trackId: t.id })
      const result2 = buildRadarTargets(t, [withoutCutoff], 10, 0, undefined)
      expect(result2.next?.cutoff).toBeUndefined()
    })
  })

  describe('bearing relative to camera heading', () => {
    it('a target dead ahead of the camera heading has relative bearing ~0', () => {
      // Point due north of the origin point.
      const lon = [0, 0]
      const lat = [0, 1]
      const t = createTrack({ lon, lat }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
      t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
      const cp = makeCp({ anchorIndex: 1, trackId: t.id })
      // Absolute bearing to the target is ~0deg (due north); heading 0 means
      // the camera is also facing north, so the target should be dead ahead.
      const result = buildRadarTargets(t, [cp], 0, 0, undefined)
      expect(result.targets[0].bearingRad).toBeCloseTo(0, 3)
    })

    it('wraps correctly through 360 degrees', () => {
      const lon = [0, 0]
      const lat = [0, 1]
      const t = createTrack({ lon, lat }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
      t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
      const cp = makeCp({ anchorIndex: 1, trackId: t.id })
      // Absolute bearing to target ~0deg; camera heading 350deg -- relative
      // bearing should wrap to ~+10deg, not jump to a large negative value.
      const headingRad = 350 * DEG2RAD
      const result = buildRadarTargets(t, [cp], 0, headingRad, undefined)
      expect(result.targets[0].bearingRad).toBeGreaterThanOrEqual(0)
      expect(result.targets[0].bearingRad).toBeLessThan(Math.PI * 2)
      expect(result.targets[0].bearingRad).toBeCloseTo(10 * DEG2RAD, 2)
    })

    it('always returns a bearing within [0, 2*PI) regardless of heading sign/magnitude', () => {
      const t = makeTrack()
      const cp = makeCp({ anchorIndex: 50, trackId: t.id })
      for (const heading of [0, Math.PI / 2, -Math.PI, Math.PI * 5, -100, 999]) {
        const result = buildRadarTargets(t, [cp], 10, heading, undefined)
        const b = result.targets[0].bearingRad
        expect(b).toBeGreaterThanOrEqual(0)
        expect(b).toBeLessThan(Math.PI * 2)
      }
    })
  })

  describe('empty/degenerate track', () => {
    it('an empty track returns empty targets and no next, without throwing', () => {
      const t = createTrack({ lon: [], lat: [] }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
      const cp = makeCp({ anchorIndex: 0, trackId: t.id })
      expect(() => buildRadarTargets(t, [cp], 0, 0, undefined)).not.toThrow()
      const result = buildRadarTargets(t, [cp], 0, 0, undefined)
      expect(result.targets).toEqual([])
      expect(result.next).toBeUndefined()
    })

    it('a track with no cumDist yet reports no next checkpoint (nothing to measure remaining distance against)', () => {
      const lon = [116, 116.001, 116.002]
      const lat = [39, 39, 39]
      const t = createTrack({ lon, lat }, { name: 'x', format: 'gpx', fileName: 'x.gpx' }) // cumDist left unset
      const cp = makeCp({ anchorIndex: 2, trackId: t.id })
      expect(() => buildRadarTargets(t, [cp], 0, 0, undefined)).not.toThrow()
      expect(buildRadarTargets(t, [cp], 0, 0, undefined).next).toBeUndefined()
    })
  })
})
