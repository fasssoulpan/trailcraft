import { describe, it, expect } from 'vitest'
import { createTrack, trackPointCount, type TrackPointsInput } from '../../src/core/model/track'

const input: TrackPointsInput = {
  lon: [116.19, 116.20, 116.21],
  lat: [39.99, 39.995, 40.0],
  ele: [116, 120, 118],
  time: [1726128340000, 1726128341000, 1726128342000],
}

describe('createTrack', () => {
  it('builds typed-array track with metadata', () => {
    const t = createTrack(input, { name: '测试', format: 'gpx', fileName: 'a.gpx' })
    expect(trackPointCount(t)).toBe(3)
    expect(t.points.lon).toBeInstanceOf(Float64Array)
    expect(t.points.ele![1]).toBeCloseTo(120)
    expect(t.crs).toBe('wgs84')
    expect(t.id).toBeTruthy()
  })
  it('accepts missing ele/time as undefined', () => {
    const t = createTrack({ lon: [1], lat: [2] }, { name: 'x', format: 'kml', fileName: 'b.kml' })
    expect(t.points.ele).toBeUndefined()
  })
  it('throws on length mismatch', () => {
    expect(() => createTrack({ lon: [1, 2], lat: [3] }, { name: 'x', format: 'gpx', fileName: 'c' })).toThrow()
  })
})
