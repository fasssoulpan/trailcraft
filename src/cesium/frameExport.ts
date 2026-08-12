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
import { computeCaptureLayout } from '../overlay/captureLayout'
import { createOverlaySnapshotLatch, type OverlaySnapshotLatch } from './captureOverlaySnapshot'
import { runDeterministicRender } from './deterministicRenderer'
import { probeH264Support, Mp4Encoder } from './videoEncoder'
import { startRecording, checkRecordingSupport, type RecorderHandle } from './recorder'
import { sanitizeFilenameStem, filenameTimestamp, triggerBlobDownload } from './triggerBlobDownload'
import { EXPORT_FPS, type ExportResolution, type ExportProgressInfo, type ExportMode } from './exportResolutions'

export { EXPORT_FPS, EXPORT_RESOLUTIONS, type ExportResolution, type ExportResolutionKey, type ExportPhase, type ExportProgressInfo, type ExportMode } from './exportResolutions'

export interface StartExportOptions {
  viewer: Viewer
  engine: FlythroughEngine
  track: Track
  cps: CheckPoint[]
  statsOptions: StatsOptions
  radarEnabled: boolean
  resolution: ExportResolution
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
    const { viewer, engine, track, cps, statsOptions, radarEnabled, resolution } = options
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
      onFrame: (canvas, frameIndex) => encoder.encodeFrame(canvas, frameIndex),
    })

    activeLatch = undefined

    if (result === 'cancelled' || encoder.failed) {
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
