/**
 * H.264/MP4 encoding for the deterministic export pipeline (P2 §3.4,
 * milestone Q4 commit 2) -- `VideoEncoder` (WebCodecs) producing
 * `EncodedVideoChunk`s, muxed into an MP4 container by `mp4-muxer` (方案
 * V2.1's stated codec choice, not `MediaRecorder`; see `recorder.ts`'s file
 * comment for why that module is now the fallback, not the primary path).
 *
 * ---- Capability probe ----
 * WebCodecs' existence (`typeof VideoEncoder`) and H.264 hardware/software
 * support both vary across browsers and machines (方案 V2.1's risk register,
 * R3). `probeH264Support` below tries a descending list of AVC
 * profile/level codec strings through the STANDARD
 * `VideoEncoder.isConfigSupported` static method and returns the first one
 * the current browser/hardware actually accepts, or an explicit
 * `{ supported: false, reason }` if none are -- `frameExport.ts` uses that
 * result to decide whether to run this module at all or fall back to
 * `recorder.ts`'s `MediaRecorder` path, per the brief's explicit "do not
 * fail silently or crash" instruction.
 *
 * ---- Memory: never buffering raw frames ----
 * A 10-minute 4K export is on the order of 18 000 frames; a 3840x2160 RGBA
 * frame is ~33 MB, so buffering even a few hundred of them would exhaust
 * realistic browser memory long before the export finished. This module
 * never holds more than the encoder's own internal (small, bounded) queue
 * of in-flight `VideoFrame`s: `Mp4Encoder#encodeFrame` constructs exactly
 * one `VideoFrame` from the caller's canvas, hands it to `encoder.encode()`,
 * and `close()`s it in a `finally` immediately after -- `VideoFrame.close()`
 * releases the frame's underlying image data right away rather than waiting
 * for GC, so the raw-pixel cost per frame is momentary, not accumulated.
 * `BACKPRESSURE_QUEUE_DEPTH` bounds how many *encode requests* (not raw
 * frames -- those are already released) can be in flight at once, so a
 * temporarily slow encoder can't let the queue grow unbounded either.
 *
 * The MUXED (compressed) output is a separate, much smaller concern --
 * `mp4-muxer`'s `StreamTarget` (NOT `ArrayBufferTarget`/`fastStart:
 * 'in-memory'`, both of which ask the muxer itself to hold the whole file in
 * one contiguous buffer) with `fastStart: 'fragmented'` streams
 * append-only, compressed byte chunks out as they're produced; this module
 * collects those chunks into a `Blob` for a normal browser download once
 * the export finishes, rather than ever asking the muxer to assemble one
 * huge buffer itself. That `Blob` is bounded by the file's own compressed
 * size (roughly `bitrate * durationSeconds / 8` -- see `Mp4Encoder`'s own
 * doc comment for concrete numbers), not by frame count or resolution the
 * way raw frames would be -- e.g. a 10-minute 1080p export is on the order
 * of ~900 MB of compressed bytes, comfortably within what a `Blob` can hold,
 * versus multiple TERABYTES if the same duration's raw RGBA frames were ever
 * buffered instead.
 */
import { Muxer, StreamTarget } from 'mp4-muxer'

/** Descending list of AVC (H.264) profile/level codec strings, richest to
 * safest -- tried in order via `VideoEncoder.isConfigSupported` so the
 * result is the best this browser/hardware actually supports, never an
 * assumption. Level suffixes are hex per the WebCodecs/RFC 6381 codec
 * string convention: `34` = Level 5.2 (comfortably covers 4K), `33` =
 * Level 5.1 (4K at moderate frame rates), `1f`/`1e` = Level 3.1/3.0 (a safe
 * floor that virtually every H.264 decoder, hardware or software, accepts,
 * appropriate for 1080p). */
const AVC_CODEC_CANDIDATES = [
  'avc1.640034', // High @ L5.2
  'avc1.640033', // High @ L5.1
  'avc1.4d0034', // Main @ L5.2
  'avc1.4d0033', // Main @ L5.1
  'avc1.42e01f', // Baseline @ L3.1
  'avc1.42e01e', // Baseline @ L3.0
]

/** Roughly-reasonable constant bitrates by target height -- generous enough
 * for the HUD/checkpoint-card text overlays to stay legible (a much bigger
 * quality risk for compression artefacts than the terrain footage itself)
 * without producing unreasonably large files for a multi-minute export. */
function pickBitrateBps(height: number): number {
  if (height <= 1080) return 12_000_000
  return 40_000_000
}

export interface H264ProbeResult {
  supported: boolean
  /** The exact config `isConfigSupported` accepted -- pass this straight to
   * `Mp4Encoder`'s constructor. `undefined` iff `supported` is false. */
  config?: VideoEncoderConfig
  /** Human-readable, actionable reason -- present whenever `supported` is
   * false, mirroring `recorder.ts#RecordingSupport`'s own convention. */
  reason?: string
}

/**
 * Probes whether this browser/hardware can encode H.264 at `width`x`height`
 * at `fps` at all, and if so with which exact codec string. Never throws --
 * `VideoEncoder.isConfigSupported` rejecting or throwing for one candidate
 * (some browsers do this for a codec string they don't recognise, instead of
 * resolving `{supported:false}`) is treated identically to an unsupported
 * result and the next candidate is tried.
 */
export async function probeH264Support(width: number, height: number, fps: number): Promise<H264ProbeResult> {
  if (typeof VideoEncoder === 'undefined') {
    return { supported: false, reason: '当前浏览器不支持 WebCodecs（缺少 VideoEncoder API）' }
  }
  const bitrate = pickBitrateBps(height)
  for (const codec of AVC_CODEC_CANDIDATES) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      bitrateMode: 'variable',
      hardwareAcceleration: 'no-preference',
      avc: { format: 'avc' }, // avcC (length-prefixed) bitstream -- what mp4-muxer expects, not Annex B.
    }
    try {
      const support = await VideoEncoder.isConfigSupported(config)
      if (support.supported) return { supported: true, config: support.config ?? config }
    } catch {
      // Treated as "this candidate isn't supported" -- see this function's
      // own doc comment.
    }
  }
  return {
    supported: false,
    reason: `当前浏览器/硬件不支持 H.264 编码（已尝试 ${AVC_CODEC_CANDIDATES.length} 种配置）`,
  }
}

/** How many outstanding `encode()` requests are allowed to queue up inside
 * the `VideoEncoder` before `encodeFrame` awaits a `flush()` -- bounds
 * encoder-side backpressure without serialising capture and encode on every
 * single frame (which would forfeit any pipelining the browser's encoder
 * implementation could otherwise do). */
const BACKPRESSURE_QUEUE_DEPTH = 4

/** Force a keyframe roughly every 2 seconds -- frequent enough to keep
 * seeking/scrubbing the exported file reasonable, infrequent enough not to
 * meaningfully bloat file size for a multi-minute export. */
function keyframeIntervalFrames(fps: number): number {
  return Math.max(1, Math.round(fps * 2))
}

export interface Mp4EncoderOptions {
  width: number
  height: number
  fps: number
  /** The exact config `probeH264Support` returned -- this module does not
   * re-probe or second-guess it. */
  config: VideoEncoderConfig
  onEncoderError: (message: string) => void
}

/**
 * Owns one `VideoEncoder` + `mp4-muxer` `Muxer` pair for exactly one export.
 * `encodeFrame` is called once per captured frame (from
 * `deterministicRenderer.ts`'s `onFrame` callback); `finalize` flushes and
 * closes both, returning the assembled `Blob` for `frameExport.ts` to hand
 * to `triggerBlobDownload`.
 */
export class Mp4Encoder {
  private readonly muxer: Muxer<StreamTarget>
  private readonly encoder: VideoEncoder
  private readonly fps: number
  private readonly keyframeInterval: number
  private readonly chunks: Uint8Array[] = []
  private erroredMessage: string | undefined

  constructor(opts: Mp4EncoderOptions) {
    this.fps = opts.fps
    this.keyframeInterval = keyframeIntervalFrames(opts.fps)

    const target = new StreamTarget({
      // `.slice()`: defensive copy -- StreamTarget's own docs don't
      // guarantee the `Uint8Array` handed to `onData` stays valid/unique
      // after the callback returns, and this module needs to own these
      // bytes until `finalize()` assembles them into a `Blob`.
      onData: (data) => this.chunks.push(data.slice()),
      chunked: true,
    })

    this.muxer = new Muxer({
      target,
      video: { codec: 'avc', width: opts.width, height: opts.height, frameRate: opts.fps },
      // 'fragmented': the ONLY `fastStart` mode that never requires seeking
      // backward to patch an already-written box -- required here since
      // `StreamTarget#onData` above is append-only, it cannot honour a later
      // out-of-order write at an earlier byte offset the way a
      // moov-at-front/at-end file's finalization step would need. Trade-off
      // (documented, not hidden): fragmented MP4 is slightly less
      // universally supported by older players than a regular MP4 file, per
      // mp4-muxer's own docs.
      fastStart: 'fragmented',
    })

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        this.erroredMessage = e.message
        opts.onEncoderError(e.message)
      },
    })
    this.encoder.configure(opts.config)
  }

  /** True once the encoder's `error` callback has fired -- callers should
   * stop feeding frames and go straight to `cancel()` rather than
   * `finalize()`. */
  get failed(): boolean {
    return this.erroredMessage !== undefined
  }

  /**
   * Encodes one frame from `source` (the deterministic renderer's reused
   * offscreen canvas) at `frameIndex`. The presentation timestamp is
   * DERIVED from `frameIndex / fps` (microseconds) -- never from a wall
   * clock -- keeping the encoded stream's own timestamps exactly as
   * deterministic as the schedule that produced the frame
   * (`frameSchedule.ts`). The `VideoFrame` is always `close()`d before this
   * returns, regardless of whether `encode()` itself threw, per this
   * module's file comment on memory.
   */
  async encodeFrame(source: CanvasImageSource, frameIndex: number): Promise<void> {
    if (this.encoder.encodeQueueSize > BACKPRESSURE_QUEUE_DEPTH) {
      await this.encoder.flush()
    }
    const timestampUs = Math.round((frameIndex / this.fps) * 1_000_000)
    const frame = new VideoFrame(source, { timestamp: timestampUs })
    try {
      this.encoder.encode(frame, { keyFrame: frameIndex % this.keyframeInterval === 0 })
    } finally {
      frame.close()
    }
  }

  /** Flushes and closes the encoder, finalizes the muxer, and returns the
   * assembled `Blob`. */
  async finalize(): Promise<Blob> {
    await this.encoder.flush()
    this.encoder.close()
    this.muxer.finalize()
    return new Blob(this.chunks as BlobPart[], { type: 'video/mp4' })
  }

  /** Best-effort teardown for a cancelled export -- tolerates the encoder
   * already being closed/errored (either `finally` branch above, or the
   * `error` callback having already run once). */
  cancel(): void {
    try {
      this.encoder.close()
    } catch {
      // Already closed/errored -- fine, this is best-effort teardown.
    }
  }
}
