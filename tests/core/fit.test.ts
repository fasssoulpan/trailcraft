import { describe, it, expect } from 'vitest'
import { recordsToTrack } from '../../src/core/parsers/fit'

describe('recordsToTrack', () => {
  it('maps records to track arrays', () => {
    const records = [
      { position_lat: 39.99, position_long: 116.19, altitude: 116, timestamp: new Date('2024-09-12T08:05:40Z'), heart_rate: 91 },
      { position_lat: 39.995, position_long: 116.20, altitude: 120, timestamp: new Date('2024-09-12T08:05:41Z'), heart_rate: 92 },
      { altitude: 121, timestamp: new Date('2024-09-12T08:05:42Z') }, // 无坐标点应跳过
    ]
    const t = recordsToTrack(records, 'a.fit')
    expect(t.points.lon.length).toBe(2)
    expect(t.points.hr![1]).toBe(92)
    expect(t.meta.format).toBe('fit')
  })

  it('leaves ele undefined when no record has altitude', () => {
    const records = [
      { position_lat: 39.99, position_long: 116.19, timestamp: new Date('2024-09-12T08:05:40Z') },
      { position_lat: 39.995, position_long: 116.20, timestamp: new Date('2024-09-12T08:05:41Z') },
    ]
    const t = recordsToTrack(records, 'noele.fit')
    expect(t.points.ele).toBeUndefined()
  })

  it('leaves hr undefined when no record has heart_rate', () => {
    const records = [
      { position_lat: 39.99, position_long: 116.19, altitude: 116, timestamp: new Date('2024-09-12T08:05:40Z') },
      { position_lat: 39.995, position_long: 116.20, altitude: 120, timestamp: new Date('2024-09-12T08:05:41Z') },
    ]
    const t = recordsToTrack(records, 'nohr.fit')
    expect(t.points.hr).toBeUndefined()
  })

  it('leaves time undefined when no record has a timestamp', () => {
    const records = [
      { position_lat: 39.99, position_long: 116.19, altitude: 116 },
      { position_lat: 39.995, position_long: 116.20, altitude: 120 },
    ]
    const t = recordsToTrack(records, 'notime.fit')
    expect(t.points.time).toBeUndefined()
  })

  it('throws on empty records array', () => {
    expect(() => recordsToTrack([], 'empty.fit')).toThrow()
  })

  it('derives name from fileName with .fit stripped', () => {
    const records = [
      { position_lat: 39.99, position_long: 116.19, timestamp: new Date('2024-09-12T08:05:40Z') },
    ]
    const t = recordsToTrack(records, 'MyRoute.fit')
    expect(t.meta.name).toBe('MyRoute')
  })

  it('sets meta.creator when passed, leaves it undefined when omitted', () => {
    const records = [
      { position_lat: 39.99, position_long: 116.19, timestamp: new Date('2024-09-12T08:05:40Z') },
    ]
    expect(recordsToTrack(records, 'a.fit', 'COROS VERTIX 2S').meta.creator).toBe('COROS VERTIX 2S')
    expect(recordsToTrack(records, 'a.fit').meta.creator).toBeUndefined()
  })

  // P3-R5 commit 2: cadence/power/temperature sensor columns.
  describe('cadence/power/temperature', () => {
    it('maps records with cadence/power/temperature to their own columns', () => {
      const records = [
        { position_lat: 39.99, position_long: 116.19, timestamp: new Date('2024-09-12T08:05:40Z'), cadence: 82, power: 210, temperature: 18 },
        { position_lat: 39.995, position_long: 116.20, timestamp: new Date('2024-09-12T08:05:41Z'), cadence: 84, power: 215, temperature: 18.5 },
      ]
      const t = recordsToTrack(records, 'sensors.fit')
      expect(t.points.cadence![0]).toBe(82)
      expect(t.points.power![1]).toBe(215)
      expect(t.points.temperature![1]).toBeCloseTo(18.5, 5)
    })

    it('leaves cadence/power/temperature undefined (whole column) when no record has them', () => {
      const records = [
        { position_lat: 39.99, position_long: 116.19, timestamp: new Date('2024-09-12T08:05:40Z') },
        { position_lat: 39.995, position_long: 116.20, timestamp: new Date('2024-09-12T08:05:41Z') },
      ]
      const t = recordsToTrack(records, 'nosensor.fit')
      expect(t.points.cadence).toBeUndefined()
      expect(t.points.power).toBeUndefined()
      expect(t.points.temperature).toBeUndefined()
    })

    it('per-point missing cadence/power/temperature becomes NaN, not 0, once the column is present', () => {
      const records = [
        { position_lat: 39.99, position_long: 116.19, timestamp: new Date('2024-09-12T08:05:40Z'), cadence: 82, power: 210, temperature: 18 },
        { position_lat: 39.995, position_long: 116.20, timestamp: new Date('2024-09-12T08:05:41Z') }, // 本点没有传感器读数
      ]
      const t = recordsToTrack(records, 'partial.fit')
      expect(Number.isNaN(t.points.cadence![1])).toBe(true)
      expect(Number.isNaN(t.points.power![1])).toBe(true)
      expect(Number.isNaN(t.points.temperature![1])).toBe(true)
    })

    it('a real 0 reading is preserved, not conflated with the NaN missing sentinel', () => {
      const records = [
        { position_lat: 39.99, position_long: 116.19, timestamp: new Date('2024-09-12T08:05:40Z'), cadence: 0, power: 0, temperature: 0 },
        { position_lat: 39.995, position_long: 116.20, timestamp: new Date('2024-09-12T08:05:41Z'), cadence: 80, power: 100, temperature: 5 },
      ]
      const t = recordsToTrack(records, 'zero.fit')
      expect(t.points.cadence![0]).toBe(0)
      expect(t.points.power![0]).toBe(0)
      expect(t.points.temperature![0]).toBe(0)
    })
  })
})
