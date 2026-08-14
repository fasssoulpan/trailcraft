/**
 * Top-level export orchestrator (P2 §3.4, milestone Q4) -- the single entry
 * point `ui/FlyView.tsx` calls to start a video export. Decides, at
 * export-start time, whether the deterministic frame-by-frame + WebCodecs/
 * MP4 pipeline (`deterministicRenderer.ts` + `videoEncoder.ts`) can run on
 * this browser/hardware, and if not, falls back to the P1 real-time
 * `MediaRecorder` path (`recorder.ts`) with a clear, honest reason -- per
 * the milestone brief's explicit "probe with `VideoEncoder.isConfigSupported`
 * and, when unavailable, fall back... do not fail silently or crash" and
 * 方案 V2.1's own risk register (R3).
 *
 * ---- Why this needs to exist, not just wire deterministicRenderer.ts directly ----
 * `ui/FlyControls.tsx`'s "导出视频" button cannot know in advance which path
 * will actually run -- that depends on runtime capability, discovered async.
 * This module hides that decision behind one `startExport`/`ExportHandle`
 * API shaped like `recorder.ts`'s own `startRecording`/`RecorderHandle` (an
 * `onProgress` passthrough for `ui/FlyView.tsx`'s existing engine-onProgress
 * wiring, plus `cancel`), so `FlyView.tsx` only ever has one recording
 * concept to hold a ref to, regardless of which pipeline ends up running.
 */
import type { Viewer } from 'cesium'
import type { FlythroughEngine, FlythroughProgressInfo } from './flythrough'
import type { Track } from '../core/model/track'
import type { CheckPoint } from '../core/model/checkpoint'
import type { StatsOptions } from '../core/stats/segments'
import type { ProviderReport } from './viewer'
import type { BasemapStyle } from '../state/basemapPref'
import { computeCaptureLayout } from '../overlay/captureLayout'
import { composeExportCredits } from '../overlay/exportCredits'
import { computeCreditsCardLayout } from '../overlay/creditsLayout'
import { drawCreditsCard } from '../overlay/creditsDraw'
import { createOverlaySnapshotLatch, type OverlaySnapshotLatch } from './captureOverlaySnapshot'
import { runDeterministicRender } from './deterministicRenderer'
import { probeH264Support, Mp4Encoder } from './videoEncoder'
import { startRecording, checkRecordingSupport, type RecorderHandle } from './recorder'
import { sanitizeFilenameStem, filenameTimestamp, triggerBlobDownload } from './triggerBlobDownload'
import { EXPORT_FPS, type ExportResolution, type ExportProgressInfo, type ExportMode } from './exportResolutions'

/** How many seconds of compliance credits tail (P2 §3.4 Q5 commit 3) to
 * append after the main flythrough frames -- long enough to actually read at
 * a glance, short enough not to feel like padding on a short clip. */
const CREDITS_TAIL_SECONDS = 3

/**
 * Renders and encodes the compliance credits tail: `CREDITS_TAIL_SECONDS *
 * fps` frames of the SAME static card (`overlay/creditsDraw.ts#
 * drawCreditsCard`), continuing the encoder's frame-index sequence from
 * wherever the main flythrough loop left off. Deliberately Cesium-free --
 * unlike the main loop, this needs no `Viewer`/`FlythroughEngine` at all,
 * just a plain offscreen 2D canvas, since the card's content is fixed for
 * the whole tail (drawn identically every frame, which is also exactly what
 * lets it compress to almost nothing extra in the H.264 stream).
 */
async function renderCreditsTail(opts: {
  width: number
  height: number
  fps: number
  credits: ReturnType<typeof composeExportCredits>
  startFrameIndex: number
  isCancelled: () => boolean
  onFrame: (canvas: HTMLCanvasElement, frameIndex: number) => Promise<void>
  onPhase: (index: number, total: number) => void
}): Promise<'completed' | 'cancelled'> {
  const canvas = document.createElement('canvas')
  canvas.width = opts.width
  canvas.height = opts.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建离屏画布（Canvas 2D 上下文不可用）')

  const layout = computeCreditsCardLayout(opts.width, opts.height)
  const totalFrames = Math.max(1, Math.round(CREDITS_TAIL_SECONDS * opts.fps))

  for (let i = 0; i < totalFrames; i++) {
    if (opts.isCancelled()) return 'cancelled'
    drawCreditsCard(ctx, opts.width, opts.height, opts.credits, layout)
    await opts.onFrame(canvas, opts.startFrameIndex + i)
    opts.onPhase(i + 1, totalFrames)
  }
  return 'completed'
}

export { EXPORT_FPS, EXPORT_RESOLUTIONS, type ExportResolution, type ExportResolutionKey, type ExportPhase, type ExportProgressInfo, type ExportMode } from './exportResolutions'

export interface StartExportOptions {
  viewer: Viewer
  engine: FlythroughEngine
  track: Track
  cps: CheckPoint[]
  statsOptions: StatsOptions
  radarEnabled: boolean
  resolution: ExportResolution
  /** Which terrain/imagery services `cesium/viewer.ts` actually selected --
   * the compliance credits tail (P2 §3.4 Q5 commit 3) reads this rather than
   * assuming Esri, so a MapTiler-backed session credits MapTiler and a
   * degraded-to-flat-ellipsoid session says so honestly instead of crediting
   * a terrain service that was never actually reached. */
  providers: ProviderReport
  /** Which of the two Cesium basemap styles is currently active -- see
   * `overlay/exportCredits.ts`'s own doc comment for why the credits tail
   * needs this IN ADDITION TO `providers`: the "plan" (二维平面图) style
   * always shows the Esri street layer over a flat ellipsoid regardless of
   * what `providers` reports for the satellite style. */
  basemapStyle: BasemapStyle
  onProgress: (p: ExportProgressInfo) => void
  /** Fired at most once, as soon as the pipeline is actually known -- never
   * fires at all if the export is cancelled before the capability probe
   * resolves. `detail` is a short human-readable string for the UI's
   * honest-labelling requirement (e.g. "H.264 MP4 · 4K · 30fps" or the
   * fallback's reason for not using WebCodecs). */
  onModeChosen: (mode: ExportMode, detail: string) => void
  onError: (message: string) => void
  /** Fired exactly once, when the export finishes for ANY reason
   * (completed, cancelled, or errored) -- `ui/FlyView.tsx` uses this as the
   * single place to clear its own `exportRef`, mirroring how `recorder.ts`'s
   * `onStateChange('idle')` already serves that role for the fallback path
   * alone. */
  onDone: () => void
}

export interface ExportHandle {
  /** Passthrough for `ui/FlyView.tsx`'s existing engine-onProgress wiring
   * (previously fed straight to `recorder.ts`'s own `RecorderHandle`) --
   * forwarded to whichever underlying path is actually running. A no-op
   * before the underlying path has been chosen yet (the async capability
   * probe hasn't resolved) or after the export has finished. */
  onProgress(info: FlythroughProgressInfo): void
  /** Requests cancellation. Safe to call at any point, including before the
   * capability probe has resolved (the probe result is simply discarded when
   * it lands) and after the export already finished on its own (a no-op). */
  cancel(): void
}

/**
 * Starts an export. Always returns a handle synchronously (never `undefined`
 * -- unlike `recorder.ts#startRecording`, this function cannot know up front
 * whether recording is supported at all; that failure, if it happens, is
 * reported later via `onError` + `onDone`, exactly like every other
 * mid-flight failure this module can hit).
 */
export function startExport(options: StartExportOptions): ExportHandle {
  let cancelled = false
  let done = false
  let activeLatch: OverlaySnapshotLatch | undefined
  let fallbackHandle: RecorderHandle | undefined

  const finish = () => {
    if (done) return
    done = true
    options.onDone()
  }

  void runExport()

  async function runExport(): Promise<void> {
    options.onProgress({ phase: 'probing', index: 0, total: 1 })
    const probe = await probeH264Support(options.resolution.width, options.resolution.height, EXPORT_FPS)
    if (cancelled) {
      finish()
      return
    }

    if (!probe.supported) {
      options.onModeChosen('fallback', probe.reason ?? 'WebCodecs 不可用')
      startFallback()
      return
    }

    options.onModeChosen('deterministic', `H.264 MP4 · ${options.resolution.label} · ${EXPORT_FPS}fps`)
    try {
      await runDeterministic(probe.config!)
    } catch (err) {
      if (!cancelled) options.onError(err instanceof Error ? err.message : String(err))
      finish()
    }
  }

  // The MediaRecorder fallback does NOT get a compliance credits tail
  // (P2 §3.4 Q5 commit 3): it's a real-time capture with no frame-index
  // encoder to append onto (recorder.ts drives its own MediaRecorder
  // directly from a live MediaStream, unlike Mp4Encoder's per-frame
  // `encodeFrame`), and it is already, permanently labelled "预览级" in
  // FlyControls -- P2's own plan frames the deterministic H.264 MP4 path as
  // the actual "成片" (publishable output) this deliverable is about.
  function startFallback(): void {
    const support = checkRecordingSupport()
    if (!support.supported) {
      options.onError(support.reason!)
      finish()
      return
    }
    fallbackHandle = startRecording({
      viewer: options.viewer,
      engine: options.engine,
      track: options.track,
      cps: options.cps,
      statsOptions: options.statsOptions,
      radarEnabled: options.radarEnabled,
      width: options.resolution.width,
      height: options.resolution.height,
      onStateChange: (s) => {
        if (s === 'recording') options.onProgress({ phase: 'rendering', index: 0, total: 0 })
        else if (s === 'saving') options.onProgress({ phase: 'saving', index: 0, total: 0 })
        else {
          options.onProgress({ phase: 'idle', index: 0, total: 0 })
          finish()
        }
      },
      onError: (message) => {
        options.onError(message)
        finish()
      },
    })
    if (!fallbackHandle) finish() // startRecording itself already reported onError synchronously.
  }

  async function runDeterministic(config: VideoEncoderConfig): Promise<void> {
    const { viewer, engine, track, cps, statsOptions, radarEnabled, resolution, providers, basemapStyle } = options
    const layout = computeCaptureLayout(resolution.width, resolution.height)
    const latch = createOverlaySnapshotLatch({ viewer, track, cps, statsOptions, radarEnabled, layout })
    activeLatch = latch

    const encoder = new Mp4Encoder({
      width: resolution.width,
      height: resolution.height,
      fps: EXPORT_FPS,
      config,
      onEncoderError: (message) => options.onError(message),
    })

    const speedMps = engine.baseSpeedMps * engine.getSpeed()

    // Tracks the last frame index the main loop actually encoded, so the
    // credits tail below can continue the SAME monotonic sequence
    // `Mp4Encoder#encodeFrame`'s presentation timestamps are derived from
    // (frameIndex / fps) -- restarting from 0 would rewind the tail's
    // timestamps to the middle of the flythrough instead of appending after
    // it.
    let lastFrameIndex = -1

    const result = await runDeterministicRender({
      viewer,
      engine,
      width: resolution.width,
      height: resolution.height,
      fps: EXPORT_FPS,
      speedMps,
      latch,
      // Also stops the render loop the moment the encoder's own `error`
      // callback has fired -- without this, a hardware-encoder failure
      // partway through would only be noticed AFTER every remaining frame
      // had already been rendered for nothing (a 4K export can be
      // thousands of frames deep at that point).
      isCancelled: () => cancelled || encoder.failed,
      onPhase: (phase, index, total) => options.onProgress({ phase, index, total }),
      onFrame: (canvas, frameIndex) => {
        lastFrameIndex = frameIndex
        return encoder.encodeFrame(canvas, frameIndex)
      },
    })

    activeLatch = undefined

    if (result === 'cancelled' || encoder.failed) {
      encoder.cancel()
      finish()
      return
    }

    // ---- Compliance credits tail (P2 §3.4 Q5 commit 3) --------------------
    const credits = composeExportCredits({ terrain: providers.terrain, imagery: providers.imagery, basemapStyle })
    const creditsResult = await renderCreditsTail({
      width: resolution.width,
      height: resolution.height,
      fps: EXPORT_FPS,
      credits,
      startFrameIndex: lastFrameIndex + 1,
      isCancelled: () => cancelled || encoder.failed,
      onFrame: (canvas, frameIndex) => encoder.encodeFrame(canvas, frameIndex),
      onPhase: (index, total) => options.onProgress({ phase: 'credits', index, total }),
    })

    if (creditsResult === 'cancelled' || encoder.failed) {
      encoder.cancel()
      finish()
      return
    }

    options.onProgress({ phase: 'finalizing', index: 1, total: 1 })
    const blob = await encoder.finalize()

    options.onProgress({ phase: 'saving', index: 1, total: 1 })
    const filename = `${sanitizeFilenameStem(track.meta.name, 'flythrough')}-${filenameTimestamp()}.mp4`
    triggerBlobDownload(blob, filename)

    options.onProgress({ phase: 'idle', index: 0, total: 0 })
    finish()
  }

  return {
    onProgress(info: FlythroughProgressInfo): void {
      activeLatch?.onProgress(info)
      fallbackHandle?.onProgress(info)
    },
    cancel(): void {
      cancelled = true
      fallbackHandle?.stop()
    },
  }
}
