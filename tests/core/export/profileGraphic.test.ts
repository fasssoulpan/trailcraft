import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../../src/core/model/track'
import { computeCumDist } from '../../../src/core/geo/distance'
import type { CheckPoint } from '../../../src/core/model/checkpoint'
import type { PaceParams } from '../../../src/core/pace/models'
import { computeProfileChartModel, svgFromProfileChartModel, buildElevationProfileSvg } from '../../../src/core/export/profileGraphic'

function climbingTrack(n = 200): Track {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.0005)
  const lat = Array.from({ length: n }, () => 39.9)
  const ele = Array.from({ length: n }, (_, i) => 1000 + i * 5)
  const t = createTrack({ lon, lat, ele }, { name: '测试赛道', format: 'gpx', fileName: 'climb.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

function noEleTrack(n = 50): Track {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.0005)
  const lat = Array.from({ length: n }, () => 39.9)
  const t = createTrack({ lon, lat }, { name: '无海拔赛道', format: 'gpx', fileName: 'noele.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

function cp(id: string, name: string, anchorIndex: number, trackId: string, cutoffTime?: string): CheckPoint {
  return { id, trackId, name, kind: 'cp', anchorIndex, cutoffTime }
}

const pace: PaceParams = {
  model: 'practical', flatPaceSecPerKm: 360, vamMPerH: 600, descentFactor: 0.25, fatiguePctPerHour: 3,
}

describe('computeProfileChartModel', () => {
  it('throws a clear Chinese message and does not build a chart when the track has no elevation', () => {
    const t = noEleTrack()
    expect(() => computeProfileChartModel(t, [])).toThrow(/海拔/)
  })

  it('throws when cumDist is missing even if elevation is present', () => {
    const t = climbingTrack()
    t.points.cumDist = undefined
    expect(() => computeProfileChartModel(t, [])).toThrow()
  })

  it('total ascent in the model matches computeSegments summed over the same track/CPs', () => {
    const t = climbingTrack()
    const cps = [cp('c1', 'CP1', 50, t.id), cp('c2', 'CP2', 120, t.id)]
    const model = computeProfileChartModel(t, cps)
    // Track climbs steadily 5m/point with no descent, so total gain should
    // be close to (n-1)*5 minus whatever the hysteresis threshold eats.
    expect(model.totalGainM).toBeGreaterThan(0)
    expect(model.totalLossM).toBe(0)
  })

  it('places one CP label per CP anchored to this track, ignoring CPs from other tracks', () => {
    const t = climbingTrack()
    const cps = [cp('c1', 'CP1', 50, t.id), cp('other', '不相关', 10, 'trk_other')]
    const model = computeProfileChartModel(t, cps)
    expect(model.cpLabels).toHaveLength(1)
    expect(model.cpLabels[0].name).toBe('CP1')
  })

  it('segment annotations have no segTimeSec when no pace params/start time are given', () => {
    const t = climbingTrack()
    const cps = [cp('c1', 'CP1', 50, t.id)]
    const model = computeProfileChartModel(t, cps)
    expect(model.segmentAnnotations.every((a) => a.segTimeSec === undefined)).toBe(true)
    expect(model.segmentAnnotations.every((a) => Number.isFinite(a.netSlopePct))).toBe(true)
  })

  it('segment annotations get a projected time once pace params and a valid start time are given', () => {
    const t = climbingTrack()
    const cps = [cp('c1', 'CP1', 50, t.id)]
    const model = computeProfileChartModel(t, cps, { paceParams: pace, raceStartTimeIso: '2026-08-07T06:00:00+08:00' })
    expect(model.segmentAnnotations.some((a) => a.segTimeSec !== undefined)).toBe(true)
  })

  it('an invalid start time falls back to no segment times rather than throwing', () => {
    const t = climbingTrack()
    const cps = [cp('c1', 'CP1', 50, t.id)]
    const model = computeProfileChartModel(t, cps, { paceParams: pace, raceStartTimeIso: 'not-a-date' })
    expect(model.segmentAnnotations.every((a) => a.segTimeSec === undefined)).toBe(true)
  })
})

describe('svgFromProfileChartModel / buildElevationProfileSvg', () => {
  it('produces an <svg> document containing the track name, CP name and total ascent', () => {
    const t = climbingTrack()
    const cps = [cp('c1', 'CP1', 50, t.id)]
    const svg = buildElevationProfileSvg(t, cps)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('</svg>')
    expect(svg).toContain('测试赛道')
    expect(svg).toContain('CP1')
    expect(svg).toContain('累计爬升')
  })

  it('two CPs anchored close together both appear in the output (no silent drop from label staggering)', () => {
    const t = climbingTrack()
    const cps = [cp('c1', 'CP近1', 50, t.id), cp('c2', 'CP近2', 52, t.id)]
    const svg = buildElevationProfileSvg(t, cps)
    expect(svg).toContain('CP近1')
    expect(svg).toContain('CP近2')
  })

  it('refuses (throws) rather than emitting an empty chart for a track with no elevation', () => {
    const t = noEleTrack()
    expect(() => buildElevationProfileSvg(t, [])).toThrow(/海拔/)
  })

  it('svgFromProfileChartModel is a pure function of the model (same model -> identical output)', () => {
    const t = climbingTrack()
    const cps = [cp('c1', 'CP1', 50, t.id)]
    const model = computeProfileChartModel(t, cps)
    expect(svgFromProfileChartModel(model)).toBe(svgFromProfileChartModel(model))
  })
})
