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
  it('throws on hr length mismatch', () => {
    expect(() =>
      createTrack({ lon: [1, 2, 3], lat: [1, 2, 3], hr: [100, 110] }, { name: 'x', format: 'gpx', fileName: 'd' }),
    ).toThrow()
  })

  // P3-R5 commit 2: cadence/power/temperature sensor columns.
  it('builds cadence/power/temperature as Float32Array, undefined when omitted', () => {
    const t = createTrack({ lon: [1, 2], lat: [3, 4] }, { name: 'x', format: 'fit', fileName: 'e.fit' })
    expect(t.points.cadence).toBeUndefined()
    expect(t.points.power).toBeUndefined()
    expect(t.points.temperature).toBeUndefined()
  })

  it('accepts cadence/power/temperature, including per-point NaN for missing readings', () => {
    const t = createTrack(
      {
        lon: [1, 2, 3], lat: [1, 2, 3],
        cadence: [80, NaN, 90],
        power: [NaN, 150, 160],
        temperature: [0, NaN, -3.5], // 0°C / 负数都是合法读数，不是缺失哨兵
      },
      { name: 'x', format: 'fit', fileName: 'f.fit' },
    )
    expect(t.points.cadence).toBeInstanceOf(Float32Array)
    expect(t.points.power).toBeInstanceOf(Float32Array)
    expect(t.points.temperature).toBeInstanceOf(Float32Array)
    expect(t.points.cadence![0]).toBe(80)
    expect(Number.isNaN(t.points.cadence![1])).toBe(true)
    expect(t.points.power![0]).toBeNaN()
    expect(t.points.temperature![0]).toBe(0)
    expect(t.points.temperature![2]).toBeCloseTo(-3.5, 5)
  })

  it('throws on cadence/power/temperature length mismatch', () => {
    expect(() =>
      createTrack(
        { lon: [1, 2, 3], lat: [1, 2, 3], cadence: [80, 90] },
        { name: 'x', format: 'fit', fileName: 'g.fit' },
      ),
    ).toThrow()
    expect(() =>
      createTrack(
        { lon: [1, 2, 3], lat: [1, 2, 3], power: [80, 90] },
        { name: 'x', format: 'fit', fileName: 'h.fit' },
      ),
    ).toThrow()
    expect(() =>
      createTrack(
        { lon: [1, 2, 3], lat: [1, 2, 3], temperature: [80, 90] },
        { name: 'x', format: 'fit', fileName: 'i.fit' },
      ),
    ).toThrow()
  })
})
