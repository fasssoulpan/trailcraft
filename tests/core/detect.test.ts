import { describe, it, expect } from 'vitest'
import { detectCrs } from '../../src/core/crs/detect'

describe('detectCrs', () => {
  it('COROS creator → wgs84 high', () => {
    const r = detectCrs({ creator: 'COROS Wearables', fileName: 'a.gpx' }, {})
    expect(r.crs).toBe('wgs84')
    expect(r.confidence).toBe('high')
  })
  it('两步路 filename → gcj02 high', () => {
    expect(detectCrs({ fileName: 'foooooot_12345.kml' }, {}).crs).toBe('gcj02')
  })
  it('remembered source overrides pattern match', () => {
    expect(detectCrs({ creator: 'SomeApp' }, { SomeApp: 'bd09' }).crs).toBe('bd09')
  })
  it('unknown creator → unknown confidence', () => {
    expect(detectCrs({ creator: '神秘App' }, {}).confidence).toBe('unknown')
  })
  it('remembered source wins even when creator also matches a built-in pattern (user-corrected detection)', () => {
    const r = detectCrs({ creator: 'COROS Wearables' }, { 'COROS Wearables': 'gcj02' })
    expect(r.crs).toBe('gcj02')
    expect(r.confidence).toBe('high')
    expect(r.reason).toBe('remembered source')
  })
  it('baidu-matching signature beats a cn-app-matching one when both appear', () => {
    const r = detectCrs({ creator: '百度地图 高德' }, {})
    expect(r.crs).toBe('bd09')
  })

  it('"Snapple Fitness" does not falsely match the "apple" pattern as a substring', () => {
    // Falls through to the default wgs84/unknown - the point is it must NOT be
    // a high-confidence match caused by "apple" matching inside "Snapple".
    const r = detectCrs({ creator: 'Snapple Fitness', fileName: 'a.gpx' }, {})
    expect(r.confidence).toBe('unknown')
    expect(r.reason).toBe('no signal; require user confirm')
  })

  it('existing positive cases still match after adding word boundaries', () => {
    expect(detectCrs({ creator: 'COROS Wearables', fileName: 'a.gpx' }, {}).crs).toBe('wgs84')
    expect(detectCrs({ creator: 'COROS Wearables', fileName: 'a.gpx' }, {}).confidence).toBe('high')
    expect(detectCrs({ fileName: 'foooooot_12345.kml' }, {}).crs).toBe('gcj02')
    expect(detectCrs({ fileName: 'baidu_track_2024.gpx' }, {}).crs).toBe('bd09')
    expect(detectCrs({ fileName: 'baidu_track_2024.gpx' }, {}).confidence).toBe('high')
    expect(detectCrs({ fileName: '我的两步路轨迹记录20240912.gpx' }, {}).crs).toBe('gcj02')
    expect(detectCrs({ fileName: '我的两步路轨迹记录20240912.gpx' }, {}).confidence).toBe('high')
  })
})
