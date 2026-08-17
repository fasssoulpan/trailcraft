import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../../src/core/model/track'
import { computeCumDist } from '../../../src/core/geo/distance'
import type { CheckPoint } from '../../../src/core/model/checkpoint'
import type { PaceParams } from '../../../src/core/pace/models'
import { buildRouteBookData, RouteBookDataError } from '../../../src/core/export/routeBookData'

function climbingTrack(n = 200): Track {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.0005)
  const lat = Array.from({ length: n }, () => 39.9)
  const ele = Array.from({ length: n }, (_, i) => 1000 + i * 5)
  const t = createTrack({ lon, lat, ele }, { name: '测试赛道', format: 'gpx', fileName: 'climb.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

function cp(id: string, name: string, anchorIndex: number, trackId: string, cutoffTime?: string): CheckPoint {
  return { id, trackId, name, kind: 'cp', anchorIndex, cutoffTime }
}

const pace: PaceParams = {
  model: 'practical', flatPaceSecPerKm: 360, vamMPerH: 600, descentFactor: 0.25, fatiguePctPerHour: 3,
}
const statsOptions = { threshold: 5, smoothWindow: 5 }
const startIso = '2026-08-07T06:00:00+08:00'

describe('buildRouteBookData', () => {
  it('throws RouteBookDataError naming the missing data when cumDist is absent', () => {
    const t = climbingTrack()
    t.points.cumDist = undefined
    expect(() => buildRouteBookData(t, [cp('c1', 'CP1', 50, t.id)], pace, statsOptions, startIso)).toThrow(RouteBookDataError)
    expect(() => buildRouteBookData(t, [cp('c1', 'CP1', 50, t.id)], pace, statsOptions, startIso)).toThrow(/里程/)
  })

  it('throws naming missing elevation when the track has no ele column', () => {
    const t = climbingTrack()
    t.points.ele = undefined
    expect(() => buildRouteBookData(t, [cp('c1', 'CP1', 50, t.id)], pace, statsOptions, startIso)).toThrow(/海拔/)
  })

  it('throws naming missing CPs when there are zero checkpoints for this track', () => {
    const t = climbingTrack()
    expect(() => buildRouteBookData(t, [], pace, statsOptions, startIso)).toThrow(/检查点|CP/)
  })

  it('ignores CPs belonging to a different track and still throws for zero own CPs', () => {
    const t = climbingTrack()
    const cps = [cp('other', '别的轨迹CP', 10, 'trk_other')]
    expect(() => buildRouteBookData(t, cps, pace, statsOptions, startIso)).toThrow(RouteBookDataError)
  })

  it('produces one row per computeSegments segment, with cumulative distance matching the running total', () => {
    const t = climbingTrack()
    const cps = [cp('c1', 'CP1', 50, t.id), cp('c2', 'CP2', 120, t.id)]
    const data = buildRouteBookData(t, cps, pace, statsOptions, startIso)
    expect(data.rows).toHaveLength(3) // 起点->CP1, CP1->CP2, CP2->终点
    expect(data.rows[data.rows.length - 1].cumDistM).toBeCloseTo(data.totalDistM, 5)
    // cumulative distance is monotonically increasing
    for (let i = 1; i < data.rows.length; i++) {
      expect(data.rows[i].cumDistM).toBeGreaterThan(data.rows[i - 1].cumDistM)
    }
  })

  it('total ascent equals the sum of per-row gains', () => {
    const t = climbingTrack()
    const cps = [cp('c1', 'CP1', 50, t.id)]
    const data = buildRouteBookData(t, cps, pace, statsOptions, startIso)
    const sumGain = data.rows.reduce((s, r) => s + r.gain, 0)
    expect(data.totalGainM).toBeCloseTo(sumGain, 6)
  })

  it('rows carry eta/level/margin once a valid pace + start time are given, aligned to cutoff times', () => {
    const t = climbingTrack()
    const cutoffIso = '2026-08-07T20:00:00+08:00' // generous cutoff, should be green
    const cps = [cp('c1', 'CP1', 50, t.id, cutoffIso)]
    const data = buildRouteBookData(t, cps, pace, statsOptions, startIso)
    expect(data.rows[0].etaMs).toBeDefined()
    expect(data.rows[0].cutoffMs).toBe(Date.parse(cutoffIso))
    expect(data.rows[0].level).toBe('green')
    expect(data.rows[1].cutoffMs).toBeUndefined() // finish segment, no CP
  })

  it('an invalid start time degrades gracefully: rows still have distance/gain but no eta/level/margin', () => {
    const t = climbingTrack()
    const cps = [cp('c1', 'CP1', 50, t.id)]
    const data = buildRouteBookData(t, cps, pace, statsOptions, 'not-a-date')
    expect(data.startMs).toBeUndefined()
    expect(data.rows.every((r) => r.etaMs === undefined)).toBe(true)
    expect(data.rows.every((r) => r.segTimeSec === undefined)).toBe(true)
    expect(data.rows.every((r) => r.distM >= 0)).toBe(true)
  })

  it('marginSec is undefined (not Infinity) when a CP has no cutoff time', () => {
    const t = climbingTrack()
    const cps = [cp('c1', 'CP1', 50, t.id)] // no cutoffTime
    const data = buildRouteBookData(t, cps, pace, statsOptions, startIso)
    expect(data.rows[0].marginSec).toBeUndefined()
    expect(data.rows[0].level).toBe('green')
  })

  it('sortedCps is sorted by anchorIndex regardless of input order', () => {
    const t = climbingTrack()
    const cps = [cp('c2', 'CP2', 120, t.id), cp('c1', 'CP1', 50, t.id)]
    const data = buildRouteBookData(t, cps, pace, statsOptions, startIso)
    expect(data.sortedCps.map((c) => c.name)).toEqual(['CP1', 'CP2'])
  })
})
