import { describe, it, expect } from 'vitest'
import { contourPresetForStyle } from '../../src/cesium/contourPreset'

describe('contourPresetForStyle', () => {
  it('returns a distinct preset per basemap style', () => {
    const satellite = contourPresetForStyle('satellite')
    const plan = contourPresetForStyle('plan')
    expect(satellite.colorCss).not.toBe(plan.colorCss)
  })

  it('satellite preset is bright, for legibility over dark/busy imagery', () => {
    const { colorCss } = contourPresetForStyle('satellite')
    expect(colorCss.toLowerCase()).toBe('#ffffff')
  })

  it('every preset has a valid alpha and a positive width', () => {
    for (const style of ['satellite', 'plan'] as const) {
      const preset = contourPresetForStyle(style)
      expect(preset.alpha).toBeGreaterThan(0)
      expect(preset.alpha).toBeLessThanOrEqual(1)
      expect(preset.widthPx).toBeGreaterThan(0)
    }
  })
})
