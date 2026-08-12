import { describe, it, expect } from 'vitest'
import { SPEED_OPTIONS, MIN_SPEED, MAX_SPEED, DEFAULT_SPEED, clampSpeed } from '../../src/cesium/speedOptions'

describe('speedOptions', () => {
  it('bounds are derived from the ladder, so the UI cannot offer a speed the engine clamps away', () => {
    expect(MIN_SPEED).toBe(SPEED_OPTIONS[0])
    expect(MAX_SPEED).toBe(SPEED_OPTIONS[SPEED_OPTIONS.length - 1])
    for (const s of SPEED_OPTIONS) expect(clampSpeed(s)).toBe(s)
  })

  it('ladder is strictly increasing', () => {
    for (let i = 1; i < SPEED_OPTIONS.length; i++) {
      expect(SPEED_OPTIONS[i]).toBeGreaterThan(SPEED_OPTIONS[i - 1])
    }
  })

  it('clamps out-of-range values to the bounds', () => {
    expect(clampSpeed(0)).toBe(MIN_SPEED)
    expect(clampSpeed(-5)).toBe(MIN_SPEED)
    expect(clampSpeed(MAX_SPEED * 10)).toBe(MAX_SPEED)
  })

  it('falls back to the default for non-finite input rather than producing NaN speed', () => {
    expect(clampSpeed(Number.NaN)).toBe(DEFAULT_SPEED)
    expect(clampSpeed(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SPEED)
  })

  it('the fastest option is genuinely reachable (regression: engine clamped to 20x while UI offered 500x)', () => {
    expect(clampSpeed(500)).toBe(500)
    expect(MAX_SPEED).toBeGreaterThan(20)
  })
})
