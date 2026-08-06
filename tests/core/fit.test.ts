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
})
