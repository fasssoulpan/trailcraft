import { describe, it, expect } from 'vitest'
import { computeCreditsCardLayout } from '../../src/overlay/creditsLayout'

describe('computeCreditsCardLayout', () => {
  it('scales by the frame\'s SHORTER side, so 4K (double the short side of every other preset) doubles font sizes', () => {
    const a = computeCreditsCardLayout(1920, 1080)
    const fourK = computeCreditsCardLayout(3840, 2160)
    expect(fourK.scale).toBeCloseTo(a.scale * 2, 6)
    expect(fourK.titleFontPx).toBeCloseTo(a.titleFontPx * 2, 6)
  })

  it('gives every 1080-short-side preset (16:9 1080p, 9:16, 1:1, 3:4) the identical scale', () => {
    const presets: [number, number][] = [
      [1920, 1080],
      [1080, 1920],
      [1080, 1080],
      [1080, 1440],
    ]
    const scales = presets.map(([w, h]) => computeCreditsCardLayout(w, h).scale)
    for (const s of scales) expect(s).toBeCloseTo(scales[0], 6)
  })

  it('keeps maxTextWidthPx well short of the frame width so text never touches the edges', () => {
    const layout = computeCreditsCardLayout(1080, 1920)
    expect(layout.maxTextWidthPx).toBeLessThan(1080)
    expect(layout.maxTextWidthPx).toBeGreaterThan(1080 * 0.5)
  })

  it('degenerate width/height falls back to a safe, finite, positive scale', () => {
    for (const [w, h] of [
      [0, 0],
      [-100, 500],
      [NaN, 1080],
      [1920, NaN],
    ] as const) {
      const layout = computeCreditsCardLayout(w, h)
      expect(Number.isFinite(layout.scale)).toBe(true)
      expect(layout.scale).toBeGreaterThan(0)
      expect(Number.isFinite(layout.titleFontPx)).toBe(true)
    }
  })
})
