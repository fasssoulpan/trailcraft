import { describe, it, expect } from 'vitest'
import { computeCaptureLayout } from '../../src/overlay/captureLayout'

describe('computeCaptureLayout', () => {
  it('returns scale 1 at the reference resolution (1280x800)', () => {
    const layout = computeCaptureLayout(1280, 800)
    expect(layout.scale).toBeCloseTo(1, 6)
    expect(layout.hud.x).toBeCloseTo(8, 6)
    expect(layout.hud.y).toBeCloseTo(8, 6)
    expect(layout.radar.scopeSize).toBeCloseTo(150, 6)
    expect(layout.radar.readoutWidth).toBeCloseTo(150, 6)
  })

  it('scales every position/size linearly with a uniform resolution increase', () => {
    const base = computeCaptureLayout(1280, 800)
    const doubled = computeCaptureLayout(2560, 1600)
    expect(doubled.scale).toBeCloseTo(base.scale * 2, 6)
    expect(doubled.hud.x).toBeCloseTo(base.hud.x * 2, 6)
    expect(doubled.hud.chipWidthPx).toBeCloseTo(base.hud.chipWidthPx * 2, 6)
    expect(doubled.checkpointCard.width).toBeCloseTo(base.checkpointCard.width * 2, 6)
    expect(doubled.radar.scopeSize).toBeCloseTo(base.radar.scopeSize * 2, 6)
    expect(doubled.radar.readoutWidth).toBeCloseTo(base.radar.readoutWidth * 2, 6)
  })

  it('picks the SMALLER of the two axis ratios, so an unusually narrow/short target never pushes an overlay past the opposite edge', () => {
    // Much wider than tall relative to the 1280x800 reference -- height is
    // the constraining axis (1080/800 < 3840/1280).
    const layout = computeCaptureLayout(3840, 1080)
    expect(layout.scale).toBeCloseTo(1080 / 800, 6)
  })

  it('1080p (the milestone acceptance floor) keeps every overlay fully inside the frame', () => {
    const layout = computeCaptureLayout(1920, 1080)
    expect(layout.hud.x).toBeGreaterThanOrEqual(0)
    expect(layout.hud.y).toBeGreaterThanOrEqual(0)
    expect(layout.checkpointCard.x).toBeGreaterThanOrEqual(0)
    expect(layout.checkpointCard.x + layout.checkpointCard.width).toBeLessThanOrEqual(1920)
    expect(layout.checkpointCard.y + layout.checkpointCard.height).toBeLessThanOrEqual(1080)
    expect(layout.radar.x).toBeGreaterThanOrEqual(0)
    expect(layout.radar.y).toBeGreaterThanOrEqual(0)
    expect(layout.radar.readoutX + layout.radar.readoutWidth).toBeLessThanOrEqual(1920)
    expect(layout.radar.y + layout.radar.scopeSize).toBeLessThanOrEqual(1080)
  })

  it('the checkpoint card and radar are right-aligned (their right edge tracks width, not a fixed x)', () => {
    const a = computeCaptureLayout(1920, 1080)
    const b = computeCaptureLayout(2560, 1080)
    const aCardRight = a.checkpointCard.x + a.checkpointCard.width
    const bCardRight = b.checkpointCard.x + b.checkpointCard.width
    // Same scale (height unchanged, so height stays the binding axis and
    // scale is identical) -- only the right-edge margin shifts, not the
    // rendered size.
    expect(a.scale).toBeCloseTo(b.scale, 6)
    expect(bCardRight).toBeGreaterThan(aCardRight)
  })

  it('degenerate width/height (zero, negative, NaN) fall back to a safe, finite, positive scale instead of propagating NaN/Infinity', () => {
    for (const [w, h] of [
      [0, 0],
      [-100, 500],
      [NaN, 1080],
      [1920, NaN],
      [Infinity, 1080],
    ] as const) {
      const layout = computeCaptureLayout(w, h)
      expect(Number.isFinite(layout.scale)).toBe(true)
      expect(layout.scale).toBeGreaterThan(0)
      expect(Number.isFinite(layout.hud.x)).toBe(true)
      expect(Number.isFinite(layout.checkpointCard.x)).toBe(true)
      expect(Number.isFinite(layout.radar.x)).toBe(true)
    }
  })

  it('every sub-layout carries the same scale as the top level', () => {
    const layout = computeCaptureLayout(1920, 1080)
    expect(layout.hud.scale).toBe(layout.scale)
    expect(layout.checkpointCard.scale).toBe(layout.scale)
    expect(layout.radar.scale).toBe(layout.scale)
  })
})
