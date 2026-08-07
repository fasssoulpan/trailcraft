import { describe, it, expect } from 'vitest'
import { createTrack } from '../../src/core/model/track'
import type { CheckPoint } from '../../src/core/model/checkpoint'
import type { PaceParams } from '../../src/core/pace/models'
import type { StatsOptions } from '../../src/core/stats/segments'
import { serializeProject, deserializeProject } from '../../src/core/model/project'

const paceParams: PaceParams = {
  model: 'practical',
  flatPaceSecPerKm: 360,
  vamMPerH: 600,
  descentFactor: 0.25,
  fatiguePctPerHour: 3,
}
const statsOptions: StatsOptions = { threshold: 6, smoothWindow: 7 }

function trackWithEle() {
  return createTrack(
    {
      lon: [116.1, 116.2, 116.3],
      lat: [39.9, 39.91, 39.92],
      ele: [10, 20, 30],
      time: [1000, 2000, 3000],
      hr: [90, 95, 100],
    },
    { name: '带海拔轨迹', format: 'gpx', fileName: 'a.gpx', creator: 'Test' },
    'wgs84',
  )
}

function trackWithoutEle() {
  return createTrack(
    { lon: [116.1, 116.2], lat: [39.9, 39.91] },
    { name: '无海拔轨迹', format: 'gpx', fileName: 'b.gpx' },
    'gcj02',
  )
}

function makeCp(): CheckPoint {
  return {
    id: 'cp_1',
    name: 'CP1 & <补给站>',
    kind: 'aid',
    anchorIndex: 1,
    clickLngLat: [116.2, 39.91],
    cutoffTime: '2026-08-07T14:00:00+08:00',
    photoUrl: 'blob:foo',
  }
}

describe('serializeProject / deserializeProject', () => {
  it('has schema_version present from the start', () => {
    const p = serializeProject('工程', [trackWithEle()], [], paceParams, statsOptions)
    expect(p.schema_version).toBe('1.0')
    expect(p.type).toBe('FeatureCollection')
  })

  it('output is valid JSON (round-trips through JSON.parse(JSON.stringify))', () => {
    const p = serializeProject('工程', [trackWithEle(), trackWithoutEle()], [makeCp()], paceParams, statsOptions, '2026-08-07T06:00:00+08:00')
    const roundTripped = JSON.parse(JSON.stringify(p))
    expect(roundTripped).toEqual(p)
  })

  it('round-trip preserves point counts, coordinates and elevation', () => {
    const t = trackWithEle()
    const p = serializeProject('工程', [t], [], paceParams, statsOptions)
    const { tracks } = deserializeProject(p)
    expect(tracks).toHaveLength(1)
    const back = tracks[0]
    expect(back.points.lon.length).toBe(3)
    expect(Array.from(back.points.lon)).toEqual(Array.from(t.points.lon))
    expect(Array.from(back.points.lat)).toEqual(Array.from(t.points.lat))
    expect(Array.from(back.points.ele!)).toEqual(Array.from(t.points.ele!))
    expect(Array.from(back.points.time!)).toEqual(Array.from(t.points.time!))
    expect(Array.from(back.points.hr!)).toEqual(Array.from(t.points.hr!))
    expect(back.originalCrs).toBe('wgs84')
    expect(back.id).toBe(t.id)
    // cumDist must be recomputed, not just carried along
    expect(back.points.cumDist).toBeDefined()
    expect(back.points.cumDist![0]).toBe(0)
    expect(back.points.cumDist![2]).toBeGreaterThan(0)
  })

  it('a track lacking elevation round-trips with elevation still absent, not resurrected as all-NaN', () => {
    const t = trackWithoutEle()
    const p = serializeProject('工程', [t], [], paceParams, statsOptions)
    const { tracks } = deserializeProject(p)
    expect(tracks[0].points.ele).toBeUndefined()
    expect(tracks[0].points.time).toBeUndefined()
    expect(tracks[0].points.hr).toBeUndefined()
    expect(tracks[0].originalCrs).toBe('gcj02')
  })

  it('round-trip preserves CP anchors and all fields', () => {
    const cp = makeCp()
    const p = serializeProject('工程', [trackWithEle()], [cp], paceParams, statsOptions)
    const { cps } = deserializeProject(p)
    expect(cps).toHaveLength(1)
    expect(cps[0]).toEqual(cp)
  })

  it('round-trip preserves settings: paceParams, statsOptions, raceStartTime', () => {
    const p = serializeProject('工程', [trackWithEle()], [], paceParams, statsOptions, '2026-08-07T06:00:00+08:00')
    const back = deserializeProject(p)
    expect(back.paceParams).toEqual(paceParams)
    expect(back.statsOptions).toEqual(statsOptions)
    expect(back.raceStartTime).toBe('2026-08-07T06:00:00+08:00')
  })

  it('raceStartTime is optional and round-trips as undefined when omitted', () => {
    const p = serializeProject('工程', [], [], paceParams, statsOptions)
    const back = deserializeProject(p)
    expect(back.raceStartTime).toBeUndefined()
  })

  it('multiple tracks and multiple cps round-trip independently', () => {
    const t1 = trackWithEle()
    const t2 = trackWithoutEle()
    const cp1 = makeCp()
    const cp2: CheckPoint = { id: 'cp_2', name: 'CP2', kind: 'gear', anchorIndex: 0 }
    const p = serializeProject('工程', [t1, t2], [cp1, cp2], paceParams, statsOptions)
    const back = deserializeProject(p)
    expect(back.tracks.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort())
    expect(back.cps.map((c) => c.id).sort()).toEqual(['cp_1', 'cp_2'])
    const backCp2 = back.cps.find((c) => c.id === 'cp_2')!
    expect(backCp2.clickLngLat).toBeUndefined()
    expect(backCp2.cutoffTime).toBeUndefined()
  })
})
