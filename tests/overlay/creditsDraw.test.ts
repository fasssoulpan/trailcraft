import { describe, it, expect, vi } from 'vitest'
import { drawCreditsCard } from '../../src/overlay/creditsDraw'
import { computeCreditsCardLayout } from '../../src/overlay/creditsLayout'
import { composeExportCredits } from '../../src/overlay/exportCredits'

/** Same fake-ctx pattern `tests/overlay/captureDraw.test.ts` established --
 * this repo's tests run in Node with no real canvas, so `drawCreditsCard`
 * (which deliberately targets an arbitrary context, see its own doc
 * comment) is exercised against a fake that records calls, and these tests
 * assert "doesn't throw" plus call-count/content invariants, not literal
 * pixel output. */
function makeFakeCtx() {
  const fillTextCalls: string[] = []
  const state = { fillRect: 0 }
  let font = ''
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(() => {
      state.fillRect++
    }),
    fillText: vi.fn((text: string) => {
      fillTextCalls.push(text)
    }),
    measureText: vi.fn((text: string) => ({ width: text.length * (parseInt(font, 10) || 16) * 0.55 })),
    set fillStyle(_v: string) {},
    set font(v: string) {
      font = v
    },
    set textAlign(_v: string) {},
    set textBaseline(_v: string) {},
  } as unknown as CanvasRenderingContext2D
  return { ctx, fillTextCalls, state }
}

describe('drawCreditsCard', () => {
  it('does not throw, fills the full-frame background, and draws every credit/note line', () => {
    const { ctx, fillTextCalls, state } = makeFakeCtx()
    const layout = computeCreditsCardLayout(1920, 1080)
    const credits = composeExportCredits({ terrain: 'esri', imagery: 'esri', basemapStyle: 'satellite' })
    expect(() => drawCreditsCard(ctx, 1920, 1080, credits, layout)).not.toThrow()
    expect(state.fillRect).toBe(1) // one full-frame background fill
    for (const line of credits.dataCredits) expect(fillTextCalls).toContain(line)
    expect(fillTextCalls.some((t) => t.includes('音乐'))).toBe(true)
  })

  it('draws the honest flat-terrain fallback note when present', () => {
    const { ctx, fillTextCalls } = makeFakeCtx()
    const layout = computeCreditsCardLayout(1080, 1920)
    const credits = composeExportCredits({ terrain: 'ellipsoid', imagery: 'esri', basemapStyle: 'satellite' })
    drawCreditsCard(ctx, 1080, 1920, credits, layout)
    expect(fillTextCalls.some((t) => t.includes('地形'))).toBe(true)
  })

  it('is stable across every supported preset (no throw, at least one line drawn) including degenerate layout input', () => {
    const credits = composeExportCredits({ terrain: 'maptiler', imagery: 'maptiler', basemapStyle: 'satellite' })
    for (const [w, h] of [
      [1920, 1080],
      [3840, 2160],
      [1080, 1920],
      [1080, 1080],
      [1080, 1440],
    ] as const) {
      const { ctx, fillTextCalls } = makeFakeCtx()
      const layout = computeCreditsCardLayout(w, h)
      expect(() => drawCreditsCard(ctx, w, h, credits, layout)).not.toThrow()
      expect(fillTextCalls.length).toBeGreaterThan(0)
    }
  })
})
