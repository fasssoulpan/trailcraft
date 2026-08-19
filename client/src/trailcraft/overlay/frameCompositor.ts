/**
 * Frame compositing for the video-recording pipeline (P1 §2.1 交付物 8, §6
 * R8, milestone N5) -- the piece that closes the gap the milestone brief
 * calls out explicitly: `viewer.canvas.captureStream()` alone only ever
 * captures the raw Cesium frame, never the independent DOM/canvas overlay
 * layer (`ui/FlyOverlayLayer.tsx`'s own doc comment explains why that layer
 * is independent in the first place). `cesium/recorder.ts` calls
 * `captureStream()` on the canvas THIS module owns/repaints instead of on
 * `viewer.canvas` directly.
 *
 * Split into two pieces for testability, the same "pure decision vs
 * untestable-in-Node execution" split every other overlay module in this
 * codebase follows (`overlay/radarMath.ts` vs `overlay/radarRender.ts`,
 * `cesium/terrainSelection.ts` vs `cesium/viewer.ts`, ...):
 *
 * - `compositeFrame` -- pure sequencing (draw the source frame, then the
 *   overlay content, in that order, onto a context handed to it). Takes an
 *   arbitrary `CanvasRenderingContext2D` and an arbitrary
 *   `CanvasImageSource`, so it's testable against a fake context with no
 *   real canvas/WebGL involved (see `tests/overlay/frameCompositor.test.ts`).
 * - `FrameCompositor` -- the untestable-in-Node half: owns a real
 *   `HTMLCanvasElement` and a `requestAnimationFrame` loop that calls
 *   `compositeFrame` once per animation frame while running.
 */

export type OverlayDrawFn = (ctx: CanvasRenderingContext2D, width: number, height: number) => void

/**
 * Draws one composited frame into `ctx`: clears the full `width`x`height`
 * extent, blits `source` (the live Cesium canvas, or `undefined` if it
 * isn't available yet/anymore -- e.g. a viewer torn down mid-recording)
 * scaled to fill that same extent, then calls `drawOverlays` to paint the
 * HUD/checkpoint-card/radar content on top. Overlay content is always drawn
 * AFTER the source frame regardless of whether `source` was actually
 * available, so a momentarily-missing Cesium frame still leaves the
 * overlays visible rather than blanking the whole composited frame.
 */
export function compositeFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  source: CanvasImageSource | undefined,
  drawOverlays: OverlayDrawFn,
): void {
  ctx.save()
  ctx.clearRect(0, 0, width, height)
  if (source) ctx.drawImage(source, 0, 0, width, height)
  ctx.restore()
  drawOverlays(ctx, width, height)
}

export interface FrameCompositorOptions {
  width: number
  height: number
  /** Returns the current Cesium canvas to blit, or `undefined` if there is
   * none right now -- read fresh on every frame (not captured once) so a
   * caller can hand this a ref-style accessor without needing to rebuild
   * the compositor if the underlying element ever changed. */
  getSource: () => CanvasImageSource | undefined
  drawOverlays: OverlayDrawFn
}

/**
 * Owns an offscreen `<canvas>` at `(width, height)` and repaints it once per
 * animation frame (via `compositeFrame`) for as long as `start()`..`stop()`
 * brackets. `cesium/recorder.ts` calls `canvas.captureStream(30)` on the
 * `.canvas` this exposes, not on `viewer.canvas` directly -- that's the
 * whole point of this class existing.
 *
 * Kept deliberately dumb: no knowledge of Cesium, `MediaRecorder`, or the
 * flythrough engine at all. `recorder.ts` is the one place that wires this
 * together with those; this class's only job is "keep an offscreen canvas
 * looking like `getSource()` + whatever `drawOverlays` paints, as cheaply as
 * calling `compositeFrame` once per frame allows, and stop cleanly".
 */
export class FrameCompositor {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly opts: FrameCompositorOptions
  private rafId: number | undefined
  private running = false

  constructor(opts: FrameCompositorOptions) {
    this.opts = opts
    this.canvas = document.createElement('canvas')
    this.canvas.width = opts.width
    this.canvas.height = opts.height
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建离屏画布（Canvas 2D 上下文不可用）')
    this.ctx = ctx
  }

  /** Idempotent -- a second call while already running is a no-op, not a
   * second overlapping `requestAnimationFrame` chain. */
  start(): void {
    if (this.running) return
    this.running = true
    const loop = () => {
      if (!this.running) return
      compositeFrame(this.ctx, this.opts.width, this.opts.height, this.opts.getSource(), this.opts.drawOverlays)
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  /** Idempotent -- safe to call on an already-stopped (or never-started)
   * compositor, which `cesium/recorder.ts`'s own stop path relies on (a
   * user clicking "停止录制" and the flythrough reaching the end on its own
   * can race). */
  stop(): void {
    this.running = false
    if (this.rafId !== undefined) cancelAnimationFrame(this.rafId)
    this.rafId = undefined
  }
}
