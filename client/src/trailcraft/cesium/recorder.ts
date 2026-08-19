/**
 * Flythrough video recording (P1 §2.1 交付物 8, milestone N5) -- records the
 * 3D flythrough as a downloadable WebM, from the start of the track to the
 * end, composited with the HUD/checkpoint-card/radar overlays (via
 * `overlay/frameCompositor.ts`/`overlay/captureDraw.ts`, milestone N5 commit
 * 1 -- see those modules' own doc comments for why a naive
 * `viewer.canvas.captureStream()` alone would drop the overlay layer
 * entirely, closing P1 plan risk R8).
 *
 * Ported from the reference implementation's `cyber-trail-hud/src/ui/
 * video-export.js` (`captureStream()` -> `MediaRecorder` -> `Blob` ->
 * download, VP9/VP8/webm codec fallback via `MediaRecorder.isTypeSupported`,
 * `requestRenderMode` toggled off for the duration) with two differences
 * beyond the overlay compositing:
 *
 * 1. No module-level mutable singleton (`_recorder`/`_chunks`/`_viewer`) --
 *    every piece of state lives in this function's closure, returned via
 *    `RecorderHandle`, matching `FlythroughEngine`'s own documented reason
 *    for the same choice (a singleton can't survive two Viewer instances or
 *    React 18 StrictMode's double-invoked effects, and can't be tested).
 * 2. Records from the very START of the track, not wherever playback
 *    happened to be left (the brief's explicit requirement) -- `seek(0)` is
 *    called before `play()` below.
 *
 * ---- 预览级 (preview-grade), not the quality ceiling ----
 * This is a REAL-TIME capture: `MediaRecorder` samples whatever the
 * compositor canvas looks like every ~33ms, so a slow frame (a big terrain
 * tile arriving, a GC pause) is a genuinely dropped/duplicated frame in the
 * output, not something a re-render can fix after the fact, and the output
 * resolution is bounded by what looks acceptable to real-time-encode at 30
 * fps, not by what the source scene could render given unlimited time per
 * frame. P1 plan §1.4/R4 is explicit that this is intentional for P1 --
 * the deterministic, frame-rate-decoupled frame-by-frame pipeline needed
 * for 4K/portrait/broadcast-quality output is P2 work (camera paths are
 * already mileage-parameterised, not frame-indexed, specifically so P2 can
 * reuse them -- see `cameraPath.ts`'s own doc comment). `ui/FlyControls.tsx`
 * labels the record button/output accordingly; this module does not try to
 * hide the limitation from the caller either (see `checkRecordingSupport`).
 *
 * ---- requestRenderMode: recorder vs. FlythroughEngine ----
 * `FlythroughEngine.play()`/`pause()` (flythrough.ts) already toggle
 * `viewer.scene.requestRenderMode` for their own reason (continuous
 * rendering only while actually animating). If the user pauses mid-
 * recording, `pause()` flips that flag back to `true`, and Cesium then
 * renders nothing further until something explicitly requests a frame --
 * silently freezing the recorded video on whatever was on screen at that
 * instant, not stopping cleanly. Rather than coordinating two independent
 * owners of one boolean, this module just re-asserts
 * `requestRenderMode = false` on every compositor frame for the entire
 * recording (cheap, idempotent) -- the engine is free to do whatever it
 * wants with the flag; the recorder's assertion always wins within one
 * animation frame. Restored to `true` (mirroring `FlythroughEngine.pause()`'s
 * own convention) exactly once, when the `MediaRecorder` actually stops.
 *
 * ---- P2 Q4 update: this is now the FALLBACK path, not the only path ----
 * `cesium/frameExport.ts` (P2 §3.4, milestone Q4) is the new primary export
 * pipeline: a deterministic, frame-rate-decoupled frame-by-frame renderer
 * producing H.264 MP4 via WebCodecs. This module's real-time
 * `MediaRecorder`-based capture is kept, unmodified in behaviour, as the
 * runtime fallback `frameExport.ts` uses when WebCodecs/H.264 isn't
 * available (see that module's own capability probe) -- so the file
 * comment above (the whole "预览级" explanation) is still accurate, just
 * scoped to "when this path is the one actually running" rather than "the
 * only path that exists". The HUD/checkpoint-card/radar latching logic that
 * used to live inline in `startRecording` below now lives in
 * `captureOverlaySnapshot.ts`, shared with `deterministicRenderer.ts` so the
 * two capture paths can never silently draw different overlay content for
 * the same mileage.
 */
import type { Viewer } from 'cesium'
import type { FlythroughEngine, FlythroughProgressInfo } from './flythrough'
import type { Track } from '../core/model/track'
import type { CheckPoint } from '../core/model/checkpoint'
import type { StatsOptions } from '../core/stats/segments'
import { computeCaptureLayout } from '../overlay/captureLayout'
import { drawHudEntries, drawCheckpointCard, drawRadarCapture } from '../overlay/captureDraw'
import { FrameCompositor } from '../overlay/frameCompositor'
import { createOverlaySnapshotLatch } from './captureOverlaySnapshot'
import { sanitizeFilenameStem, filenameTimestamp, triggerBlobDownload } from './triggerBlobDownload'

export type RecorderStatus = 'recording' | 'saving' | 'idle'

/** 1080p -- the milestone's acceptance floor (P1 §2.1 交付物 8). 4K/portrait
 * output is explicitly P2 (see this module's file comment). */
export const RECORDING_WIDTH = 1920
export const RECORDING_HEIGHT = 1080
const RECORDING_FPS = 30
const RECORDING_BITRATE_BPS = 8_000_000
const DATA_CHUNK_INTERVAL_MS = 200

const MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

function pickMimeType(): string {
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return 'video/webm'
}

export interface RecordingSupport {
  supported: boolean
  /** Human-readable, actionable reason -- present whenever `supported` is
   * false. Names the concrete requirement (matching the reference
   * implementation's own alert), not just "not supported". */
  reason?: string
}

/**
 * Environment guard -- `MediaRecorder`/`canvas.captureStream` are a
 * Chrome/Edge-94+-era API pair. Checked up front so `startRecording` can
 * fail with a clear, nameable message via `onError` instead of throwing
 * from deep inside `MediaRecorder`'s constructor or silently doing nothing.
 */
export function checkRecordingSupport(): RecordingSupport {
  if (typeof MediaRecorder === 'undefined') {
    return {
      supported: false,
      reason: '当前浏览器不支持视频录制（缺少 MediaRecorder API），请使用 Chrome / Edge 94 及以上版本',
    }
  }
  if (typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
    return {
      supported: false,
      reason: '当前浏览器不支持画布录制（缺少 canvas.captureStream），请使用 Chrome / Edge 94 及以上版本',
    }
  }
  return { supported: true }
}

export interface StartRecordingOptions {
  viewer: Viewer
  engine: FlythroughEngine
  track: Track
  /** Every CP in the project -- `pickApproachingCheckpoint` does its own
   * `trackId` filtering internally, same defensive convention
   * `CheckpointCard.tsx` follows. */
  cps: CheckPoint[]
  statsOptions: StatsOptions
  /** Whether to composite the radar ring overlay -- mirrors the live
   * `radarEnabled` LayerPanel toggle at the moment recording starts (read
   * once; the toggle isn't expected to change mid-recording, and the brief
   * doesn't ask for that). */
  radarEnabled: boolean
  /** Recording resolution -- defaults to RECORDING_WIDTH/RECORDING_HEIGHT. */
  width?: number
  height?: number
  onStateChange: (state: RecorderStatus) => void
  /** Called once, right after recording actually starts, with the codec
   * `MediaRecorder.isTypeSupported` picked (VP9 > VP8 > generic webm) -- the
   * brief's "report which codec was chosen". */
  onCodecChosen?: (mimeType: string) => void
  onError: (message: string) => void
}

export interface RecorderHandle {
  /** Feeds one flythrough progress tick -- FlyView.tsx calls this from the
   * SAME `onProgress` callback that already drives HudOverlay/
   * CheckpointCard/RadarOverlay (see that file's `rebuildFlythrough`), so
   * the compositor's overlay content can never show different numbers than
   * what's on screen for the same frame. Also where auto-stop-at-end is
   * detected (see this module's file comment). */
  onProgress(info: FlythroughProgressInfo): void
  /** Manual stop -- also invoked automatically once the flythrough reaches
   * the end of the track. Idempotent; safe to call from an unmount cleanup
   * even if recording already finished on its own. */
  stop(): void
}

/**
 * Starts recording. Returns `undefined` (after calling `options.onError`)
 * if the environment can't support recording at all, or if a 2D canvas
 * context couldn't be obtained for the compositor -- callers must not
 * assume a handle exists just because this was called.
 */
export function startRecording(options: StartRecordingOptions): RecorderHandle | undefined {
  const support = checkRecordingSupport()
  if (!support.supported) {
    options.onError(support.reason!)
    return undefined
  }

  const { viewer, engine, track, cps, statsOptions } = options
  const width = options.width ?? RECORDING_WIDTH
  const height = options.height ?? RECORDING_HEIGHT
  const layout = computeCaptureLayout(width, height)

  // Latest per-frame overlay content -- written by the latch's onProgress
  // (called from this handle's own onProgress below), read by the
  // compositor's drawOverlays callback. See `captureOverlaySnapshot.ts`'s
  // own doc comment for why this logic is shared with the deterministic
  // renderer rather than living here as before.
  const overlayLatch = createOverlaySnapshotLatch({ viewer, track, cps, statsOptions, radarEnabled: options.radarEnabled, layout })

  let compositor: FrameCompositor
  try {
    compositor = new FrameCompositor({
      width,
      height,
      getSource: () => (viewer.isDestroyed() ? undefined : viewer.canvas),
      drawOverlays: (ctx) => {
        // Re-asserted every frame -- see this module's file comment on why
        // this must not be a one-time assignment at start().
        if (!viewer.isDestroyed()) viewer.scene.requestRenderMode = false
        const { hudEntries, checkpointCard, radar } = overlayLatch.snapshot
        if (hudEntries.length > 0) drawHudEntries(ctx, hudEntries, layout.hud)
        if (checkpointCard) drawCheckpointCard(ctx, checkpointCard, layout.checkpointCard)
        if (radar) {
          drawRadarCapture(ctx, layout.radar, radar.ringSet, radar.headingRad, radar.metersPerPixel, radar.targetSet)
        }
      },
    })
  } catch (err) {
    options.onError(err instanceof Error ? err.message : String(err))
    return undefined
  }

  const stream = compositor.canvas.captureStream(RECORDING_FPS)
  const mimeType = pickMimeType()

  const chunks: Blob[] = []
  const mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: RECORDING_BITRATE_BPS })
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  let stopped = false

  mediaRecorder.onstop = () => {
    compositor.stop()
    if (!viewer.isDestroyed()) {
      viewer.scene.requestRenderMode = true
      viewer.scene.requestRender()
    }
    options.onStateChange('saving')

    const blob = new Blob(chunks, { type: mimeType })
    const filename = `${sanitizeFilenameStem(track.meta.name, 'flythrough')}-${filenameTimestamp()}.webm`
    triggerBlobDownload(blob, filename)

    options.onStateChange('idle')
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    if (mediaRecorder.state !== 'inactive') mediaRecorder.stop()
    else compositor.stop() // recorder never actually started (e.g. immediate construction failure elsewhere) -- still tear down the compositor's rAF loop.
  }

  compositor.start()
  mediaRecorder.start(DATA_CHUNK_INTERVAL_MS)
  options.onStateChange('recording')
  options.onCodecChosen?.(mimeType)

  // Starts from the very beginning of the track, per the brief -- NOT
  // wherever the scrubber was previously left (engine.play() alone only
  // resets to 0 if playback had already reached the end, see its own doc
  // comment).
  engine.seek(0)
  engine.play()

  let wasPlaying = false

  function onProgress(info: FlythroughProgressInfo): void {
    if (stopped) return

    overlayLatch.onProgress(info)

    // Auto-stop once the flythrough has actually finished. flythrough.ts's
    // handleTick flips isPlaying false exactly once, at the instant mileage
    // saturates at totalMileageM (see its own doc comment) -- the
    // `wasPlaying` transition-edge check (rather than just `!info.isPlaying`)
    // is what keeps a user's manual mid-recording pause from being
    // mistaken for "finished": a pause also reports isPlaying: false, but
    // never at exactly the end.
    if (wasPlaying && !info.isPlaying && info.mileageM >= engine.totalMileageM) {
      stop()
    }
    wasPlaying = info.isPlaying
  }

  return { onProgress, stop }
}
