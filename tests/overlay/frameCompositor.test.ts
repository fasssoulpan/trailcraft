import { describe, it, expect, vi } from 'vitest'
import { compositeFrame } from '../../src/overlay/frameCompositor'

/**
 * Minimal stand-in for `CanvasRenderingContext2D`, recording call order --
 * same pattern `tests/overlay/radarRender.test.ts` establishes for testing
 * canvas-drawing code without a real canvas (this repo's tests run in Node,
 * see vite.config.ts's `test.environment`). `compositeFrame`'s whole job is
 * SEQUENCING (clear, then draw the source frame, then hand off to the
 * overlay callback) -- exactly what's isolable and worth asserting here,
 * per the milestone brief's explicit call for testing "frame-composition
 * sequencing if you can isolate it".
 */
function makeFakeCtx() {
  const calls: string[] = []
  const ctx = {
    save: vi.fn(() => calls.push('save')),
    restore: vi.fn(() => calls.push('restore')),
    clearRect: vi.fn(() => calls.push('clearRect')),
    drawImage: vi.fn(() => calls.push('drawImage')),
  } as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

describe('compositeFrame', () => {
  it('clears, then draws the source image, before handing off to drawOverlays', () => {
    const { ctx, calls } = makeFakeCtx()
    const source = {} as CanvasImageSource
    const drawOverlays = vi.fn(() => calls.push('drawOverlays'))

    compositeFrame(ctx, 1920, 1080, source, drawOverlays)

    expect(calls).toEqual(['save', 'clearRect', 'drawImage', 'restore', 'drawOverlays'])
  })

  it('passes the exact source, width and height through to drawImage', () => {
    const { ctx } = makeFakeCtx()
    const source = {} as CanvasImageSource

    compositeFrame(ctx, 1920, 1080, source, () => {})

    expect(ctx.drawImage).toHaveBeenCalledWith(source, 0, 0, 1920, 1080)
  })

  it('still calls drawOverlays -- overlays stay visible -- when the source is unavailable', () => {
    const { ctx, calls } = makeFakeCtx()
    const drawOverlays = vi.fn(() => calls.push('drawOverlays'))

    compositeFrame(ctx, 1920, 1080, undefined, drawOverlays)

    expect(ctx.drawImage).not.toHaveBeenCalled()
    expect(calls).toEqual(['save', 'clearRect', 'restore', 'drawOverlays'])
  })

  it('clears the full width/height exactly once regardless of source availability', () => {
    const { ctx } = makeFakeCtx()
    compositeFrame(ctx, 800, 600, {} as CanvasImageSource, () => {})
    expect(ctx.clearRect).toHaveBeenCalledTimes(1)
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 800, 600)
  })

  it('forwards width/height to drawOverlays', () => {
    const { ctx } = makeFakeCtx()
    const drawOverlays = vi.fn()
    compositeFrame(ctx, 1920, 1080, undefined, drawOverlays)
    expect(drawOverlays).toHaveBeenCalledWith(ctx, 1920, 1080)
  })
})
