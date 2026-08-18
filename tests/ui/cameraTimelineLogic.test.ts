import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import type { CheckPoint } from '../../src/core/model/checkpoint'
import type { GradeSegment } from '../../src/core/perf/climbs'
import {
  timelineFractionToMileage,
  mileageToTimelineFraction,
  checkpointMileageM,
  checkpointSegments,
  climbSegmentRanges,
  totalMileage,
} from '../../src/ui/cameraTimelineLogic'

// Same fixture convention as tests/core/checkpointApproach.test.ts: a
// straight line of points, ~roughly evenly spaced, so mileage arithmetic is
// easy to reason about (exact spacing doesn't matter, only that cumDist
// grows monotonically).
function makeTrack(n = 200): Track {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.001)
  const lat = Array.from({ length: n }, () => 39)
  const t = createTrack({ lon, lat }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

function makeCp(patch: Partial<CheckPoint> & { anchorIndex: number; trackId: string }): CheckPoint {
  return { id: `cp_${patch.anchorIndex}_${patch.trackId}`, name: `CP@${patch.anchorIndex}`, kind: 'cp', ...patch }
}

describe('timeline <-> mileage mapping', () => {
  it('round-trips a fraction through mileage and back', () => {
    const total = 42_195
    for (const f of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      const m = timelineFractionToMileage(f, total)
      expect(mileageToTimelineFraction(m, total)).toBeCloseTo(f, 6)
    }
  })

  it('clamps an out-of-range fraction instead of propagating it', () => {
    expect(timelineFractionToMileage(-1, 1000)).toBe(0)
    expect(timelineFractionToMileage(2, 1000)).toBe(1000)
    expect(timelineFractionToMileage(NaN, 1000)).toBe(0)
  })

  it('clamps an out-of-range mileage instead of propagating it', () => {
    expect(mileageToTimelineFraction(-500, 1000)).toBe(0)
    expect(mileageToTimelineFraction(5000, 1000)).toBe(1)
  })

  it('a zero-length route always reports fraction 0, never NaN', () => {
    expect(mileageToTimelineFraction(0, 0)).toBe(0)
    expect(mileageToTimelineFraction(500, 0)).toBe(0)
  })
})

describe('checkpointMileageM', () => {
  it('reads the cumulative mileage at the checkpoint\'s anchor index', () => {
    const t = makeTrack()
    const cp = makeCp({ anchorIndex: 50, trackId: t.id })
    expect(checkpointMileageM(cp, t)).toBeCloseTo(t.points.cumDist![50])
  })

  it('is undefined when the track has no cumDist yet', () => {
    const t = makeTrack()
    t.points.cumDist = undefined
    const cp = makeCp({ anchorIndex: 50, trackId: t.id })
    expect(checkpointMileageM(cp, t)).toBeUndefined()
  })

  it('clamps an out-of-range anchorIndex instead of throwing', () => {
    const t = makeTrack()
    const cp = makeCp({ anchorIndex: 99999, trackId: t.id })
    expect(() => checkpointMileageM(cp, t)).not.toThrow()
    expect(checkpointMileageM(cp, t)).toBeCloseTo(t.points.cumDist![t.points.cumDist!.length - 1])
  })
})

describe('checkpointSegments', () => {
  it('produces start-edge, middle, and end-edge segments for two CPs, in mileage order', () => {
    const t = makeTrack()
    const cps = [makeCp({ anchorIndex: 150, trackId: t.id }), makeCp({ anchorIndex: 50, trackId: t.id })] // given out of order
    const segments = checkpointSegments(t, cps)
    expect(segments.length).toBe(3)
    expect(segments[0].label).toContain('起点 →')
    expect(segments[1].label).toBe('CP@50 → CP@150')
    expect(segments[2].label).toContain('→ 终点')
    // Contiguous and covers the whole route.
    expect(segments[0].startMileageM).toBe(0)
    expect(segments[segments.length - 1].endMileageM).toBeCloseTo(totalMileage(t))
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].startMileageM).toBeCloseTo(segments[i - 1].endMileageM)
    }
  })

  it('ignores checkpoints belonging to a different track', () => {
    const t = makeTrack()
    const other = makeTrack()
    const cps = [makeCp({ anchorIndex: 50, trackId: other.id })]
    expect(checkpointSegments(t, cps)).toEqual([])
  })

  it('returns an empty array when there are no usable checkpoints', () => {
    const t = makeTrack()
    expect(checkpointSegments(t, [])).toEqual([])
  })

  it('a single checkpoint still yields the two edge segments', () => {
    const t = makeTrack()
    const cps = [makeCp({ anchorIndex: 100, trackId: t.id })]
    const segments = checkpointSegments(t, cps)
    expect(segments.length).toBe(2)
    expect(segments[0].endMileageM).toBeCloseTo(segments[1].startMileageM)
  })
})

describe('climbSegmentRanges', () => {
  function grade(patch: Partial<GradeSegment>): GradeSegment {
    return {
      type: 'uphill',
      startDist: 0,
      endDist: 1000,
      distance: 1000,
      time: undefined,
      ascent: 0,
      descent: 0,
      avgGrade: 0,
      avgPace: undefined,
      avgHR: undefined,
      ...patch,
    }
  }

  it('keeps only uphill segments, mapped to a mileage range', () => {
    const segments = [
      grade({ type: 'downhill', startDist: 0, endDist: 500 }),
      grade({ type: 'flat', startDist: 500, endDist: 1000 }),
      grade({ type: 'uphill', startDist: 1000, endDist: 3500, distance: 2500, avgGrade: 8.3 }),
    ]
    const ranges = climbSegmentRanges(segments)
    expect(ranges.length).toBe(1)
    expect(ranges[0]).toMatchObject({ startMileageM: 1000, endMileageM: 3500 })
    expect(ranges[0].label).toContain('2.5km')
    expect(ranges[0].label).toContain('8%')
  })

  it('returns an empty array when there are no climbs', () => {
    expect(climbSegmentRanges([grade({ type: 'flat' })])).toEqual([])
  })
})
