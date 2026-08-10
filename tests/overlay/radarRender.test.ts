import { describe, it, expect, vi } from 'vitest'
import { drawRadar } from '../../src/overlay/radarRender'
import { chooseRadarRings, type RadarRingSet } from '../../src/overlay/radarMath'

/**
 * A minimal stand-in for `CanvasRenderingContext2D`, recording calls rather
 * than actually rendering anything -- this repo's tests run in Node (see
 * vite.config.ts's `test.environment`), with no real canvas available.
 * `drawRadar`'s whole point is that it targets an arbitrary context object
 * rather than reaching for a specific on-screen canvas (see that file's own
 * doc comment for why, and the milestone brief's explicit requirement) --
 * this fake is exactly the kind of "arbitrary context" that requirement is
 * meant to make possible to test against.
 */
function makeFakeCtx() {
  const calls: { arc: number; fillText: string[]; stroke: number; fill: number; clearRect: number } = {
    arc: 0,
    fillText: [],
    stroke: 0,
    fill: 0,
    clearRect: 0,
  }
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(() => {
      calls.clearRect++
    }),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(() => {
      calls.arc++
    }),
    stroke: vi.fn(() => {
      calls.stroke++
    }),
    fill: vi.fn(() => {
      calls.fill++
    }),
    fillText: vi.fn((text: string) => {
      calls.fillText.push(text)
    }),
    set strokeStyle(_v: string) {},
    set fillStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set font(_v: string) {},
    set textAlign(_v: string) {},
    set textBaseline(_v: string) {},
  } as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

function ringSetOf(count: number): RadarRingSet {
  return chooseRadarRings(2, 100, count)
}

describe('drawRadar', () => {
  it('does not throw for a normal ring set', () => {
    const { ctx } = makeFakeCtx()
    expect(() => drawRadar(ctx, 200, 200, ringSetOf(4), { centerX: 100, centerY: 100, headingRad: 0 })).not.toThrow()
  })

  it('clears the given width/height exactly once, regardless of ring count', () => {
    const { ctx, calls } = makeFakeCtx()
    drawRadar(ctx, 150, 150, ringSetOf(3), { centerX: 75, centerY: 75, headingRad: 0 })
    expect(calls.clearRect).toBe(1)
  })

  it('draws one circle per ring, plus the backing disc and the centre dot', () => {
    const { ctx, calls } = makeFakeCtx()
    const ringSet = ringSetOf(4)
    drawRadar(ctx, 200, 200, ringSet, { centerX: 100, centerY: 100, headingRad: 0 })
    // backing disc + one per ring + centre dot
    expect(calls.arc).toBe(1 + ringSet.rings.length + 1)
  })

  it('draws one distance label per ring, plus the "N" north marker', () => {
    const { ctx, calls } = makeFakeCtx()
    const ringSet = ringSetOf(4)
    drawRadar(ctx, 200, 200, ringSet, { centerX: 100, centerY: 100, headingRad: 0 })
    expect(calls.fillText.length).toBe(ringSet.rings.length + 1)
    expect(calls.fillText).toContain('N')
    for (const ring of ringSet.rings) expect(calls.fillText).toContain(ring.label)
  })

  it('handles a degenerate empty ring set without throwing and skips ticks/north marker', () => {
    const { ctx, calls } = makeFakeCtx()
    const emptyRingSet: RadarRingSet = { stepM: 10, rings: [] }
    expect(() => drawRadar(ctx, 200, 200, emptyRingSet, { centerX: 100, centerY: 100, headingRad: 0 })).not.toThrow()
    // no backing disc (outerR === 0), no ring labels, no north marker -- just the centre dot.
    expect(calls.arc).toBe(1)
    expect(calls.fillText).toEqual([])
  })

  it('accepts any finite heading without throwing, including negative/large values', () => {
    const { ctx } = makeFakeCtx()
    const ringSet = ringSetOf(4)
    for (const heading of [0, Math.PI / 2, -Math.PI, Math.PI * 5]) {
      expect(() => drawRadar(ctx, 200, 200, ringSet, { centerX: 100, centerY: 100, headingRad: heading })).not.toThrow()
    }
  })
})
