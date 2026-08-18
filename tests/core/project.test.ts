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
    trackId: 'trk_1',
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

  it('round-trip preserves per-track colour and lineWidth (TrackMeta.color/lineWidth)', () => {
    // color/lineWidth live on TrackMeta and TrackFeatureProperties.meta is
    // the whole TrackMeta object (see project.ts's trackToFeature /
    // featureToTrack), so this is really a regression guard against someone
    // narrowing that to an explicit field list and dropping the two
    // presentation fields by accident.
    const t = createTrack(
      { lon: [116.1, 116.2], lat: [39.9, 39.91] },
      { name: '彩色轨迹', format: 'gpx', fileName: 'c.gpx', color: '#9333ea', lineWidth: 5 },
      'wgs84',
    )
    const p = serializeProject('工程', [t], [], paceParams, statsOptions)
    const { tracks } = deserializeProject(p)
    expect(tracks[0].meta.color).toBe('#9333ea')
    expect(tracks[0].meta.lineWidth).toBe(5)
  })

  it('a track saved before color/lineWidth existed round-trips with both still undefined (not resurrected as defaults)', () => {
    const t = trackWithoutEle() // no color/lineWidth set, like an old project file's track
    const p = serializeProject('工程', [t], [], paceParams, statsOptions)
    const { tracks } = deserializeProject(p)
    expect(tracks[0].meta.color).toBeUndefined()
    expect(tracks[0].meta.lineWidth).toBeUndefined()
  })

  it('round-trip preserves a manual track-kind override (Track.meta.kindOverride, P2 §3.1)', () => {
    // kindOverride round-trips "for free" through project.ts because
    // trackToFeature/featureToTrack pass the whole meta object through
    // without an explicit field list (see TrackMeta.kindOverride's own doc
    // comment) -- same mechanism color/lineWidth already rely on above.
    const t = createTrack(
      { lon: [116.1, 116.2], lat: [39.9, 39.91] },
      { name: '手动覆盖轨迹', format: 'gpx', fileName: 'd.gpx', kindOverride: 'recorded' },
      'wgs84',
    )
    const p = serializeProject('工程', [t], [], paceParams, statsOptions)
    const { tracks } = deserializeProject(p)
    expect(tracks[0].meta.kindOverride).toBe('recorded')
  })

  it('a track with no override round-trips with kindOverride still undefined (not resurrected as a default)', () => {
    const t = trackWithoutEle() // never sets kindOverride
    const p = serializeProject('工程', [t], [], paceParams, statsOptions)
    const { tracks } = deserializeProject(p)
    expect(tracks[0].meta.kindOverride).toBeUndefined()
  })

  it('a project saved before kindOverride existed in the schema loads without the field rather than crashing', () => {
    // Simulates a genuinely pre-P2 project file, not just "this track never
    // set it" (the previous test) -- the key itself is absent from the
    // serialized meta object, the way a file written before this milestone
    // would actually look, rather than merely holding an undefined value.
    const t = trackWithEle()
    const p = serializeProject('工程', [t], [], paceParams, statsOptions)
    const raw = JSON.parse(JSON.stringify(p))
    delete raw.features[0].properties.meta.kindOverride
    expect(() => deserializeProject(raw)).not.toThrow()
    const { tracks } = deserializeProject(raw)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].meta.kindOverride).toBeUndefined()
  })

  // P3-R5 commit 2: cadence/power/temperature sensor columns.
  it('round-trip preserves cadence/power/temperature, including per-point NaN', () => {
    const t = createTrack(
      {
        lon: [116.1, 116.2, 116.3], lat: [39.9, 39.91, 39.92],
        ele: [10, 20, 30], time: [1000, 2000, 3000], hr: [90, 95, 100],
        cadence: [80, NaN, 85],
        power: [NaN, 150, 160],
        temperature: [0, NaN, -2.5],
      },
      { name: '传感器轨迹', format: 'fit', fileName: 'sensors.fit' },
      'wgs84',
    )
    const p = serializeProject('工程', [t], [], paceParams, statsOptions)
    const { tracks } = deserializeProject(p)
    const back = tracks[0]
    expect(back.points.cadence![0]).toBe(80)
    expect(Number.isNaN(back.points.cadence![1])).toBe(true)
    expect(back.points.power![0]).toBeNaN()
    expect(back.points.power![1]).toBe(150)
    expect(back.points.temperature![0]).toBe(0)
    expect(back.points.temperature![2]).toBeCloseTo(-2.5, 5)
  })

  it('a track lacking cadence/power/temperature round-trips with all three still absent, not resurrected as all-NaN', () => {
    const t = trackWithEle() // no cadence/power/temperature set
    const p = serializeProject('工程', [t], [], paceParams, statsOptions)
    const { tracks } = deserializeProject(p)
    expect(tracks[0].points.cadence).toBeUndefined()
    expect(tracks[0].points.power).toBeUndefined()
    expect(tracks[0].points.temperature).toBeUndefined()
  })

  it('a project saved before cadence/power/temperature existed in the schema loads without the fields rather than crashing', () => {
    // Simulates a genuine pre-P3-R5 project file: the keys themselves are
    // absent from the serialized properties object (not merely holding
    // `undefined`), matching how a file written before this milestone would
    // actually look on disk -- same pattern as the kindOverride test above.
    const t = trackWithEle()
    const p = serializeProject('工程', [t], [], paceParams, statsOptions)
    const raw = JSON.parse(JSON.stringify(p))
    delete raw.features[0].properties.cadence
    delete raw.features[0].properties.power
    delete raw.features[0].properties.temperature
    expect(() => deserializeProject(raw)).not.toThrow()
    const { tracks } = deserializeProject(raw)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].points.cadence).toBeUndefined()
    expect(tracks[0].points.power).toBeUndefined()
    expect(tracks[0].points.temperature).toBeUndefined()
    // The pre-existing columns on the same old file must still load fine.
    expect(tracks[0].points.ele).toBeDefined()
    expect(tracks[0].points.hr).toBeDefined()
  })

  it('multiple tracks and multiple cps round-trip independently, each cp keeping its own trackId', () => {
    const t1 = trackWithEle()
    const t2 = trackWithoutEle()
    const cp1: CheckPoint = { ...makeCp(), trackId: t1.id }
    const cp2: CheckPoint = { id: 'cp_2', trackId: t2.id, name: 'CP2', kind: 'gear', anchorIndex: 0 }
    const p = serializeProject('工程', [t1, t2], [cp1, cp2], paceParams, statsOptions)
    const back = deserializeProject(p)
    expect(back.tracks.map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort())
    expect(back.cps.map((c) => c.id).sort()).toEqual(['cp_1', 'cp_2'])
    const backCp1 = back.cps.find((c) => c.id === 'cp_1')!
    const backCp2 = back.cps.find((c) => c.id === 'cp_2')!
    expect(backCp1.trackId).toBe(t1.id)
    expect(backCp2.trackId).toBe(t2.id)
    expect(backCp2.clickLngLat).toBeUndefined()
    expect(backCp2.cutoffTime).toBeUndefined()
  })
})
