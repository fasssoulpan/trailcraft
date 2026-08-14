import { describe, it, expect } from 'vitest'
import {
  EXPORT_RESOLUTIONS,
  EXPORT_ASPECT_RATIO_ORDER,
  resolutionKeysForRatio,
  type ExportResolutionKey,
} from '../../src/cesium/exportResolutions'

describe('EXPORT_RESOLUTIONS', () => {
  it('carries the exact width/height table the milestone brief specifies', () => {
    expect(EXPORT_RESOLUTIONS['16:9-1080p']).toMatchObject({ width: 1920, height: 1080, ratio: '16:9' })
    expect(EXPORT_RESOLUTIONS['16:9-4k']).toMatchObject({ width: 3840, height: 2160, ratio: '16:9' })
    expect(EXPORT_RESOLUTIONS['9:16-1080p']).toMatchObject({ width: 1080, height: 1920, ratio: '9:16' })
    expect(EXPORT_RESOLUTIONS['1:1-1080p']).toMatchObject({ width: 1080, height: 1080, ratio: '1:1' })
    expect(EXPORT_RESOLUTIONS['3:4-1080p']).toMatchObject({ width: 1080, height: 1440, ratio: '3:4' })
  })

  it('every preset\'s width/height actually reduces to its own declared ratio', () => {
    const expected: Record<string, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '3:4': 3 / 4 }
    for (const key of Object.keys(EXPORT_RESOLUTIONS) as ExportResolutionKey[]) {
      const r = EXPORT_RESOLUTIONS[key]
      expect(r.width / r.height).toBeCloseTo(expected[r.ratio], 3)
    }
  })
})

describe('resolutionKeysForRatio', () => {
  it('groups 16:9 as the only ratio with two resolution choices', () => {
    expect(resolutionKeysForRatio('16:9').sort()).toEqual(['16:9-1080p', '16:9-4k'].sort())
  })

  it('gives every other ratio exactly one resolution choice', () => {
    expect(resolutionKeysForRatio('9:16')).toEqual(['9:16-1080p'])
    expect(resolutionKeysForRatio('1:1')).toEqual(['1:1-1080p'])
    expect(resolutionKeysForRatio('3:4')).toEqual(['3:4-1080p'])
  })

  it('covers every declared ratio with at least one key, and every key with exactly one ratio', () => {
    const seen = new Set<string>()
    for (const ratio of EXPORT_ASPECT_RATIO_ORDER) {
      const keys = resolutionKeysForRatio(ratio)
      expect(keys.length).toBeGreaterThan(0)
      for (const k of keys) {
        expect(seen.has(k)).toBe(false)
        seen.add(k)
      }
    }
    expect(seen.size).toBe(Object.keys(EXPORT_RESOLUTIONS).length)
  })
})
