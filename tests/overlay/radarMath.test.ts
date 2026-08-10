import { describe, expect, it } from 'vitest'
import { chooseRadarRings, formatRadarDistance, RADAR_STEP_LADDER_M } from '../../src/overlay/radarMath'

describe('chooseRadarRings', () => {
  it('always yields at least one ring', () => {
    expect(chooseRadarRings(1, 100).rings.length).toBeGreaterThan(0)
    expect(chooseRadarRings(1, 100, 0).rings.length).toBeGreaterThan(0)
    expect(chooseRadarRings(1, 100, -5).rings.length).toBeGreaterThan(0)
  })

  it('never produces overlapping/duplicate ring radii or distances', () => {
    const scales = [0.5, 1, 2, 5, 13, 47, 300, 5000]
    for (const mpp of scales) {
      const { rings } = chooseRadarRings(mpp, 400)
      for (let i = 1; i < rings.length; i++) {
        expect(rings[i].distanceM).toBeGreaterThan(rings[i - 1].distanceM)
        expect(rings[i].radiusPx).toBeGreaterThan(rings[i - 1].radiusPx)
      }
    }
  })

  it('picks larger steps as the scale coarsens (more metres per pixel)', () => {
    const maxRadiusPx = 300
    const fine = chooseRadarRings(1, maxRadiusPx)
    const medium = chooseRadarRings(50, maxRadiusPx)
    const coarse = chooseRadarRings(5000, maxRadiusPx)
    expect(medium.stepM).toBeGreaterThanOrEqual(fine.stepM)
    expect(coarse.stepM).toBeGreaterThanOrEqual(medium.stepM)
    expect(coarse.stepM).toBeGreaterThan(fine.stepM)
  })

  it('every chosen step is on the "nice number" ladder', () => {
    const scales = [0.1, 3, 17, 123, 9999]
    for (const mpp of scales) {
      const { stepM } = chooseRadarRings(mpp, 250)
      expect(RADAR_STEP_LADDER_M).toContain(stepM)
    }
  })

  it('handles degenerate scales without producing NaN/Infinity', () => {
    const degenerateInputs: Array<[number, number]> = [
      [0, 100],
      [-1, 100],
      [Number.NaN, 100],
      [Number.POSITIVE_INFINITY, 100],
      [1, 0],
      [1, -1],
      [1, Number.NaN],
      [Number.NaN, Number.NaN],
    ]
    for (const [mpp, maxRadiusPx] of degenerateInputs) {
      const { stepM, rings } = chooseRadarRings(mpp, maxRadiusPx)
      expect(Number.isFinite(stepM)).toBe(true)
      expect(rings.length).toBeGreaterThan(0)
      for (const ring of rings) {
        expect(Number.isFinite(ring.distanceM)).toBe(true)
        expect(Number.isFinite(ring.radiusPx)).toBe(true)
        expect(typeof ring.label).toBe('string')
      }
    }
  })

  it('respects a custom ring count', () => {
    expect(chooseRadarRings(1, 400, 3).rings).toHaveLength(3)
    expect(chooseRadarRings(1, 400, 6).rings).toHaveLength(6)
  })
})

describe('formatRadarDistance', () => {
  it('formats sub-kilometre distances in metres', () => {
    expect(formatRadarDistance(100)).toBe('100 m')
    expect(formatRadarDistance(850)).toBe('850 m')
  })

  it('formats kilometre-and-above distances in kilometres, trimming trailing zeros', () => {
    expect(formatRadarDistance(1000)).toBe('1 km')
    expect(formatRadarDistance(2500)).toBe('2.5 km')
    expect(formatRadarDistance(10000)).toBe('10 km')
  })

  it('never returns NaN text for degenerate input', () => {
    expect(formatRadarDistance(Number.NaN)).toBe('--')
    expect(formatRadarDistance(-5)).toBe('--')
  })
})
