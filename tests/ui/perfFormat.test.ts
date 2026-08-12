import { describe, it, expect } from 'vitest'
import {
  formatPaceMinPerKm,
  formatDurationHM,
  formatKm,
  formatMeters,
  formatGradePct,
  summarizeGradeBands,
  significantClimbs,
  envCompensationNote,
  perfAvailability,
  GRADE_BAND_ORDER,
} from '../../src/ui/perfFormat'
import type { GradeSegment } from '../../src/core/perf/climbs'
import type { EnvCompensation } from '../../src/core/perf/env'

function seg(partial: Partial<GradeSegment> & { type: GradeSegment['type'] }): GradeSegment {
  return {
    type: partial.type,
    startDist: partial.startDist ?? 0,
    endDist: partial.endDist ?? 1000,
    distance: partial.distance ?? 1000,
    time: partial.time,
    ascent: partial.ascent ?? 0,
    descent: partial.descent ?? 0,
    avgGrade: partial.avgGrade ?? 0,
    avgPace: partial.avgPace,
    avgHR: partial.avgHR,
  }
}

describe('formatPaceMinPerKm', () => {
  it('formats a positive pace as mm:ss/km', () => {
    expect(formatPaceMinPerKm(330)).toBe('5:30/km')
  })

  it('pads single-digit seconds', () => {
    expect(formatPaceMinPerKm(305)).toBe('5:05/km')
  })

  it('returns placeholder for undefined/zero/negative/non-finite', () => {
    expect(formatPaceMinPerKm(undefined)).toBe('--')
    expect(formatPaceMinPerKm(0)).toBe('--')
    expect(formatPaceMinPerKm(-10)).toBe('--')
    expect(formatPaceMinPerKm(NaN)).toBe('--')
  })
})

describe('formatDurationHM', () => {
  it('formats hours and minutes', () => {
    expect(formatDurationHM(3 * 3600 + 25 * 60)).toBe('3小时25分')
  })

  it('formats sub-hour durations without a 0小时 prefix', () => {
    expect(formatDurationHM(42 * 60)).toBe('42分钟')
  })

  it('rounds to the nearest minute', () => {
    // 90 seconds -> rounds up to 2 minutes, well under an hour.
    expect(formatDurationHM(90)).toBe('2分钟')
  })

  it('returns placeholder for undefined/negative/non-finite', () => {
    expect(formatDurationHM(undefined)).toBe('--')
    expect(formatDurationHM(-1)).toBe('--')
    expect(formatDurationHM(NaN)).toBe('--')
  })
})

describe('formatKm / formatMeters / formatGradePct', () => {
  it('formatKm converts metres to a 2-decimal km string', () => {
    expect(formatKm(12345)).toBe('12.35 km')
  })

  it('formatMeters rounds to the nearest metre', () => {
    expect(formatMeters(1234.6)).toBe('1235 m')
    expect(formatMeters(undefined)).toBe('--')
  })

  it('formatGradePct signs positive and negative grades', () => {
    expect(formatGradePct(12.34)).toBe('+12.3%')
    expect(formatGradePct(-4)).toBe('-4.0%')
    expect(formatGradePct(0)).toBe('+0.0%')
  })
})

describe('summarizeGradeBands', () => {
  it('buckets segments by type and computes percentage shares', () => {
    const segments = [
      seg({ type: 'uphill', distance: 3000 }),
      seg({ type: 'flat', distance: 1000 }),
      seg({ type: 'downhill', distance: 1000 }),
    ]
    const bands = summarizeGradeBands(segments)
    expect(bands.map((b) => b.type)).toEqual(GRADE_BAND_ORDER)
    const uphill = bands.find((b) => b.type === 'uphill')!
    expect(uphill.distanceM).toBe(3000)
    expect(uphill.pct).toBeCloseTo(60, 5)
    const flat = bands.find((b) => b.type === 'flat')!
    expect(flat.pct).toBeCloseTo(20, 5)
    const downhill = bands.find((b) => b.type === 'downhill')!
    expect(downhill.pct).toBeCloseTo(20, 5)
    // Percentages sum to 100 across all three bands.
    expect(bands.reduce((a, b) => a + b.pct, 0)).toBeCloseTo(100, 5)
  })

  it('returns all-zero percentages (never NaN) for an empty segment list', () => {
    const bands = summarizeGradeBands([])
    for (const b of bands) {
      expect(b.distanceM).toBe(0)
      expect(b.pct).toBe(0)
      expect(Number.isNaN(b.pct)).toBe(false)
    }
  })
})

describe('significantClimbs', () => {
  it('keeps only uphill segments at/above the ascent floor, sorted by start', () => {
    const segments = [
      seg({ type: 'uphill', startDist: 5000, ascent: 40 }),
      seg({ type: 'downhill', startDist: 0, ascent: 0 }),
      seg({ type: 'uphill', startDist: 0, ascent: 200 }),
      seg({ type: 'uphill', startDist: 2000, ascent: 10 }), // below the floor
      seg({ type: 'flat', startDist: 3000, ascent: 5 }),
    ]
    const climbs = significantClimbs(segments)
    expect(climbs.map((c) => c.startDist)).toEqual([0, 5000])
    expect(climbs.every((c) => c.type === 'uphill')).toBe(true)
  })

  it('returns an empty array when no climb clears the floor', () => {
    expect(significantClimbs([seg({ type: 'uphill', ascent: 5 })])).toEqual([])
  })
})

describe('envCompensationNote', () => {
  it('reports altitude and heat as neutral/inert when both factors are 1', () => {
    const env: EnvCompensation = { heatFactor: 1, altFactor: 1, totalFactor: 1 }
    const note = envCompensationNote(env)
    expect(note).toContain('×1.000')
    expect(note).toContain('未触发')
    expect(note).toContain('未输入气温/湿度')
  })

  it('reports a live altitude adjustment when altFactor > 1', () => {
    const env: EnvCompensation = { heatFactor: 1, altFactor: 1.08, totalFactor: 1.08 }
    const note = envCompensationNote(env)
    expect(note).toContain('1.080')
    expect(note).toContain('海拔')
  })
})

describe('perfAvailability', () => {
  it('is available with no explanatory copy for a recorded track', () => {
    const result = perfAvailability('recorded')
    expect(result.status).toBe('available')
    expect(result.title).toBe('')
    expect(result.message).toBe('')
  })

  it('explains the planned-route gate and points at the complementary panels', () => {
    const result = perfAvailability('planned')
    expect(result.status).toBe('planned')
    expect(result.message).toContain('配速与关门预警')
    expect(result.message).toContain('分段表')
    expect(result.message).toContain('跑得怎么样')
    expect(result.message).toContain('按时完赛')
  })

  it('prompts confirming the track kind for an uncertain track', () => {
    const result = perfAvailability('uncertain')
    expect(result.status).toBe('uncertain')
    expect(result.message).toContain('实跑')
  })
})
