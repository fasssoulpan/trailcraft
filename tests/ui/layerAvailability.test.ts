import { describe, it, expect } from 'vitest'
import { layerAvailabilityForMode, drawAvailableForMode } from '../../src/ui/layerAvailability'

describe('layerAvailabilityForMode', () => {
  it('disables contours/radar in plan mode, with hints', () => {
    const a = layerAvailabilityForMode('plan')
    expect(a.contoursAvailable).toBe(false)
    expect(a.contoursHint).toBeTruthy()
    expect(a.radarAvailable).toBe(false)
    expect(a.radarHint).toBeTruthy()
  })

  it('enables contours/radar in fly mode, no hints', () => {
    const a = layerAvailabilityForMode('fly')
    expect(a.contoursAvailable).toBe(true)
    expect(a.contoursHint).toBeUndefined()
    expect(a.radarAvailable).toBe(true)
    expect(a.radarHint).toBeUndefined()
  })
})

describe('drawAvailableForMode', () => {
  it('is available in plan mode, no hint', () => {
    const a = drawAvailableForMode('plan')
    expect(a.available).toBe(true)
    expect(a.hint).toBeUndefined()
  })

  it('is unavailable in fly mode, with an explanatory hint', () => {
    const a = drawAvailableForMode('fly')
    expect(a.available).toBe(false)
    expect(a.hint).toBeTruthy()
  })
})
