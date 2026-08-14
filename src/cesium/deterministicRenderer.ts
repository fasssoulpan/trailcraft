/**
 * Deterministic, frame-rate-decoupled frame-by-frame renderer (P2 §3.4,
 * milestone Q4 commit 1) -- P2's technical centrepiece and the whole reason
 * `cameraPath.ts` was built mileage-parameterised in P1: "推进相机 -> 等待
 * Cesium 完成该帧渲染 -> 读取画布 -> 与叠加层合成 -> 送入编码器", one frame at
 * a time, driven by `frameSchedule.ts`'s virtual-time schedule instead of by
 * `viewer.clock.onTick`/`requestAnimationFrame`/real elapsed time.
 *
 * This is the "untestable in Node" half (same split every Cesium-touching
 * module in this codebase follows): it drives a real `Viewer` and a real
 * `FlythroughEngine`. `frameSchedule.ts` is the pure half this reads its
 * per-frame mileage from; `cesium/videoEncoder.ts` is the encoder this hands
 * composited canvases to (via the caller-supplied `onFrame`, not imported
 * here directly -- see this module's own "why onFrame is a callback" note
 * below).
 *
 * ---- Camera placement: reused, not re-derived ----
 * Each frame calls `FlythroughEngine.seek(progress)` -- the SAME method
 * `FlyControls.tsx`'s scrubber already uses -- which synchronously samples
 * `cameraPath.ts` at the given mileage and applies the resulting camera
 * pose. Nothing in this file touches `Cartesian3`/camera maths itself; the
 * acceptance criterion ("nothing in the capture path reads
 * `Date.now()`/`performance.now()`/a rAF timestamp to decide camera
 * position") is satisfied simply by never doing so, since `seek()` derives
 * position purely from the mileage `frameSchedule.ts` computed.
 *
 * `engine.pause()` is called before the first frame and left paused for the
 * whole render: while paused, `FlythroughEngine`'s own `viewer.clock.onTick`
 * handler still fires (once per actual Cesium render) but takes the
 * `!this.playing` branch, which only re-applies the CURRENT `mileageM` --
 * it never advances it on its own. The only thing that ever changes
 * `mileageM` during a deterministic render is this module's own explicit
 * `engine.seek(progress)` call, once per frame.
 *
 * ---- Waiting for a completed frame: `scene.postRender` ----
 * Verified against the installed `cesium@1.144.0`'s own shipped
 * `Cesium.d.ts` (not assumed from memory): `Scene#postRender: Event`
 * ("The event fired at the end of the scene's frame update", fired once per
 * actually-rendered frame) and `Scene#requestRender(): void` ("Requests a
 * new rendered frame when `requestRenderMode` is true") both exist exactly
 * as expected on this version. `waitForRenderedFrame` below registers a
 * ONE-SHOT `postRender` listener *before* calling `requestRender()`, so
 * there is no window in which the request could fire and resolve before the
 * listener is attached. Reading `viewer.canvas` any earlier -- e.g. right
 * after `seek()` returns, before `postRender` has fired even once for the
 * new camera pose -- would silently composite whatever the PREVIOUS frame's
 * pixels happened to be, which is exactly the "worse than an obvious
 * failure" corruption mode the milestone brief calls out.
 *
 * ---- Tile-readiness policy ----
 * After a frame renders, `Globe#tilesLoaded` (verified present on this
 * version's `Globe` class) reports whether terrain/imagery for the current
 * view has finished loading. Policy: if not yet loaded, wait (via
 * `Globe#tileLoadProgressEvent`, also verified present) for up to
 * `TILE_READY_TIMEOUT_MS` -- a named constant, not a magic number -- for the
 * queue to drain, then proceed with whatever is resident either way. A
 * single stubborn/unreachable tile must never hang a multi-thousand-frame
 * export indefinitely; a soft, bounded wait is the documented trade-off
 * (some frames may show lower-detail imagery if the timeout is hit, which is
 * still strictly better than dropping the frame or blocking forever). If
 * tiles DID finish loading during the wait, one further `requestRender` +
 * `postRender` cycle is issued before capturing -- with `requestRenderMode`
 * true, Cesium does not eagerly re-render just because a tile arrived, so
 * without this the newly-loaded detail would never actually reach the
 * captured canvas for this frame.
 *
 * ---- Prefetch ----
 * Before the first captured frame, `prefetchAlongPath` walks
 * `PREFETCH_SAMPLE_COUNT` (a named constant) evenly-spaced points along the
 * full 0..1 progress range, seeking + rendering + waiting for tiles at each
 * one. This "primes" Cesium's own tile request queue for the whole route in
 * advance, per 方案 V2.1's 「录制前沿相机路径预取全部瓦片」 -- it is a
 * best-effort warm-up (coarser than the actual per-frame schedule; a route
 * with very sharp terrain/imagery detail changes between two prefetch
 * samples can still hit the per-frame timeout later), not a guarantee that
 * every tile is resident before frame 0.
 *
 * ---- Rendering at the target aspect ratio (P2 §3.4, milestone Q5) ----
 * Before Q5, this module captured whatever the on-screen `viewer.canvas`
 * happened to be sized to (the `fly-view__container`'s actual box, normally
 * close to the browser window's own aspect ratio) and let `compositeFrame`'s
 * `drawImage(source, 0, 0, width, height)` stretch that into the requested
 * `width`x`height` -- unnoticeable for 16:9 exports on a roughly-16:9
 * window, but exactly the "rendered 16:9 and cropped/stretched" failure mode
 * the Q5 brief calls out for the new portrait/square ratios. The fix is to
 * make Cesium itself render at `width`x`height` (so the captured pixels
 * already have the right aspect ratio and `drawImage` above is a lossless
 * 1:1 blit, not a distortion), by driving `viewer.canvas`'s OWN size rather
 * than reading it as a fixed given:
 *
 * Verified against the installed `cesium@1.144.0` build
 * (`node_modules/cesium/Build/CesiumUnminified/Cesium.js`, not assumed from
 * memory): `CesiumWidget`'s internal `configureCanvasSize`/
 * `configureCameraFrustum` derive the drawing-buffer size AND
 * `camera.frustum.aspectRatio` from `canvas.clientWidth`/`clientHeight`
 * (times a pixel ratio that resolves to exactly `1` here, since `viewer.ts`
 * never sets `useBrowserRecommendedResolution: false` or a
 * `resolutionScale`) -- and `Viewer.prototype.resize`, which calls
 * `cesiumWidget.resize()` unconditionally, is wired to `scene.postUpdate`,
 * which always fires before `scene.postRender` in every render cycle. So
 * simply overriding the canvas's own CSS box size once, before the first
 * `waitForRenderedFrame` call, is sufficient: the very first `postUpdate`
 * this triggers reconfigures both `canvas.width`/`height` (the actual
 * drawing buffer -- what `compositeFrame` reads) and the frustum's aspect
 * ratio to match, with no separate manual frustum math needed here.
 *
 * `applyExportCanvasSize`/`restoreExportCanvasSize` below do this by taking
 * the canvas out of normal document flow (`position: absolute`) and sizing
 * it to the exact target CSS pixel dimensions -- which can exceed the
 * on-screen container (e.g. a 3840x2160 export inside a much smaller browser
 * window). This deliberately does NOT reflow the surrounding app layout:
 * Cesium's own `CesiumWidget.css` already gives the canvas's parent
 * (`.cesium-widget`) `overflow: hidden` + `position: relative`, so an
 * absolutely-positioned, oversized canvas is simply clipped to whatever
 * portion is visible on screen -- the FULL drawing buffer still renders at
 * the requested resolution regardless of how much of it is visible, which is
 * exactly what gets captured via `viewer.canvas` below (a canvas element's
 * pixel content is not affected by CSS clipping). The original inline style
 * is restored (not just cleared) once the export ends, for any reason
 * (completed, cancelled, or thrown), so playback returns to filling its
 * container exactly as before.
 */
interface CanvasStyleSnapshot {
  position: string
  top: string
  left: string
  width: string
  height: string
}

function snapshotCanvasStyle(canvas: HTMLCanvasElement): CanvasStyleSnapshot {
  return {
    position: canvas.style.position,
    top: canvas.style.top,
    left: canvas.style.left,
    width: canvas.style.width,
    height: canvas.style.height,
  }
}

function applyExportCanvasSize(canvas: HTMLCanvasElement, width: number, height: number): void {
  canvas.style.position = 'absolute'
  canvas.style.top = '0'
  canvas.style.left = '0'
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
}

function restoreCanvasStyle(canvas: HTMLCanvasElement, snapshot: CanvasStyleSnapshot): void {
  canvas.style.position = snapshot.position
  canvas.style.top = snapshot.top
  canvas.style.left = snapshot.left
  canvas.style.width = snapshot.width
  canvas.style.height = snapshot.height
}
import type { Viewer } from 'cesium'
import type { FlythroughEngine } from './flythrough'
import { computeCaptureLayout } from '../overlay/captureLayout'
import { drawHudEntries, drawCheckpointCard, drawRadarCapture } from '../overlay/captureDraw'
import { compositeFrame } from '../overlay/frameCompositor'
import type { OverlaySnapshotLatch } from './captureOverlaySnapshot'
import { computeFrameCount, mileageForFrame, type FrameScheduleConfig } from './frameSchedule'

/** Bounded per-frame wait for the tile-load queue to drain -- see this
 * module's file comment for the full policy. */
export const TILE_READY_TIMEOUT_MS = 3_000
/** Bounded per-sample wait during the pre-render prefetch pass -- longer
 * than the per-frame timeout since prefetch happens once, up front, and can
 * afford to be more patient than a step inside the main per-frame loop. */
export const PREFETCH_TILE_TIMEOUT_MS = 5_000
/** Number of evenly-spaced points along the route sampled during prefetch --
 * deliberately much coarser than the actual per-frame schedule (which can be
 * tens of thousands of frames): this is a warm-up pass, not a re-render of
 * the whole route at full density. */
export const PREFETCH_SAMPLE_COUNT = 48

/**
 * Requests a new render and resolves once Cesium has actually finished it
 * (one `postRender` firing) -- the "wait for Cesium to actually finish
 * rendering that frame" step the milestone brief calls the crux of this
 * whole pipeline. See this module's file comment for the verified API and
 * why the listener is attached before the request.
 */
function waitForRenderedFrame(viewer: Viewer): Promise<void> {
  return new Promise((resolve) => {
    const remove = viewer.scene.postRender.addEventListener(() => {
      remove()
      resolve()
    })
    viewer.scene.requestRender()
  })
}

/** See this module's file comment's "Tile-readiness policy" section. */
async function waitForTilesReady(viewer: Viewer, timeoutMs: number): Promise<void> {
  if (viewer.isDestroyed() || viewer.scene.globe.tilesLoaded) return
  const becameReady = await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      viewer.scene.globe.tileLoadProgressEvent.removeEventListener(listener)
      clearTimeout(timer)
      resolve(ready)
    }
    const listener = (pendingTiles: number) => {
      if (pendingTiles === 0) finish(true)
    }
    viewer.scene.globe.tileLoadProgressEvent.addEventListener(listener)
    const timer = setTimeout(() => finish(false), timeoutMs)
  })
  if (becameReady && !viewer.isDestroyed()) await waitForRenderedFrame(viewer)
}

export type DeterministicRenderPhase = 'prefetching' | 'rendering'

export interface DeterministicRenderOptions {
  viewer: Viewer
  engine: FlythroughEngine
  width: number
  height: number
  fps: number
  /** Effective playback speed (metres of mileage per second of virtual
   * time) -- see `frameSchedule.ts#FrameScheduleConfig.speedMps`'s own doc
   * comment for exactly what this must be (`engine.baseSpeedMps *
   * engine.getSpeed()`, computed once by the caller). */
  speedMps: number
  /** Pre-built overlay latch (see `captureOverlaySnapshot.ts`) -- the
   * caller creates this (and is responsible for wiring `engine`'s
   * constructor-time `onProgress` callback to also call
   * `latch.onProgress`, exactly the way `ui/FlyView.tsx` already wires
   * `recorder.ts`'s own `onProgress`) so this module never has to know
   * about that plumbing itself. `engine.seek(progress)` below fires that
   * chain synchronously, so by the time each `seek` call returns,
   * `latch.snapshot` is already current for the frame this loop is about to
   * capture. */
  latch: OverlaySnapshotLatch
  /** Polled between prefetch samples and between frames -- returning `true`
   * stops the render loop at the next safe checkpoint (never mid-frame). */
  isCancelled: () => boolean
  onPhase: (phase: DeterministicRenderPhase, index: number, total: number) => void
  /** Receives one composited frame at a time. The SAME `HTMLCanvasElement`
   * instance is reused across every call (mirrors `overlay/frameCompositor.ts#FrameCompositor`'s
   * own single reused canvas) -- callers must synchronously extract what
   * they need (e.g. construct a `VideoFrame` from it, which snapshots the
   * pixel content at construction time) before returning, since the next
   * frame's `compositeFrame` call will overwrite it. A callback (rather than
   * this module importing `videoEncoder.ts` directly) keeps this module
   * ignorant of WebCodecs/mp4-muxer entirely -- it only knows how to produce
   * frames, matching the "keep resolution a parameter, don't couple stages"
   * instruction for what P2 Q5 will later need to change independently
   * (encoder stays the same; only the frame content and aspect ratio change).
   */
  onFrame: (canvas: HTMLCanvasElement, frameIndex: number, frameCount: number) => Promise<void>
}

export type DeterministicRenderResult = 'completed' | 'cancelled'

/**
 * Runs the full deterministic export: prefetch, then one `seek` + wait +
 * composite + `onFrame` cycle per scheduled frame. Leaves `engine` paused
 * and at whatever mileage the last processed frame/sample landed on
 * (matching `FlythroughEngine.seek`'s own "apply immediately, even while
 * paused" behaviour) -- callers that want playback to resume from the start
 * afterwards should `engine.seek(0)` themselves.
 */
export async function runDeterministicRender(options: DeterministicRenderOptions): Promise<DeterministicRenderResult> {
  const { viewer, engine, width, height, fps, speedMps, latch, isCancelled, onPhase, onFrame } = options

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建离屏画布（Canvas 2D 上下文不可用）')

  const layout = computeCaptureLayout(width, height)
  const drawOverlays = (c: CanvasRenderingContext2D) => {
    const { hudEntries, checkpointCard, radar } = latch.snapshot
    if (hudEntries.length > 0) drawHudEntries(c, hudEntries, layout.hud)
    if (checkpointCard) drawCheckpointCard(c, checkpointCard, layout.checkpointCard)
    if (radar) drawRadarCapture(c, layout.radar, radar.ringSet, radar.headingRad, radar.metersPerPixel, radar.targetSet)
  }

  // Deterministic capture wants EXPLICIT rendering only -- the opposite of
  // recorder.ts's real-time path, which re-asserts `requestRenderMode =
  // false` every frame for continuous rendering. `engine.pause()` already
  // sets `requestRenderMode = true`; asserted again here defensively so a
  // caller that forgot to pause first still gets the right mode.
  engine.pause()
  if (!viewer.isDestroyed()) viewer.scene.requestRenderMode = true

  // Force the LIVE Cesium canvas to the export's own target aspect ratio --
  // see this module's file comment ("Rendering at the target aspect ratio")
  // for why this alone (no manual frustum math) is sufficient, and why it
  // never reflows the surrounding app layout. Snapshotted/restored around
  // the whole render via try/finally below so every exit path (completed,
  // cancelled, or thrown) leaves on-screen playback exactly as it was.
  const liveCanvas = viewer.isDestroyed() ? undefined : viewer.canvas
  const canvasStyleSnapshot = liveCanvas ? snapshotCanvasStyle(liveCanvas) : undefined
  if (liveCanvas) applyExportCanvasSize(liveCanvas, width, height)

  try {
    const scheduleConfig: FrameScheduleConfig = { totalMileageM: engine.totalMileageM, speedMps, fps }

    // ---- Prefetch --------------------------------------------------------
    for (let i = 0; i <= PREFETCH_SAMPLE_COUNT; i++) {
      if (isCancelled() || viewer.isDestroyed()) return 'cancelled'
      const progress = PREFETCH_SAMPLE_COUNT > 0 ? i / PREFETCH_SAMPLE_COUNT : 0
      engine.seek(progress)
      await waitForRenderedFrame(viewer)
      await waitForTilesReady(viewer, PREFETCH_TILE_TIMEOUT_MS)
      onPhase('prefetching', i + 1, PREFETCH_SAMPLE_COUNT + 1)
    }

    if (isCancelled() || viewer.isDestroyed()) return 'cancelled'

    // ---- Frame-by-frame capture -------------------------------------------
    const frameCount = computeFrameCount(scheduleConfig)
    engine.seek(0)

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      if (isCancelled() || viewer.isDestroyed()) return 'cancelled'

      const mileageM = mileageForFrame(frameIndex, scheduleConfig)
      const progress = scheduleConfig.totalMileageM > 0 ? mileageM / scheduleConfig.totalMileageM : 0
      engine.seek(progress)

      await waitForRenderedFrame(viewer)
      await waitForTilesReady(viewer, TILE_READY_TIMEOUT_MS)

      if (isCancelled() || viewer.isDestroyed()) return 'cancelled'

      compositeFrame(ctx, width, height, viewer.isDestroyed() ? undefined : viewer.canvas, drawOverlays)
      await onFrame(canvas, frameIndex, frameCount)

      onPhase('rendering', frameIndex + 1, frameCount)
    }

    return 'completed'
  } finally {
    if (liveCanvas && canvasStyleSnapshot && !viewer.isDestroyed()) restoreCanvasStyle(liveCanvas, canvasStyleSnapshot)
  }
}
