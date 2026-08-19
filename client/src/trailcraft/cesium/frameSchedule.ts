/**
 * Pure virtual-time frame schedule for the deterministic frame-by-frame
 * renderer (P2 §3.4, milestone Q4 commit 1) -- "given a total mileage, an
 * effective playback speed, and a frame rate, what mileage does frame N sit
 * at" plus the export job's cancellation state machine.
 *
 * Free of any `cesium` import (same rule `cameraPath.ts` documents for
 * itself), so this is fully unit-testable under Vitest's `node` environment.
 * `deterministicRenderer.ts` is the "untestable in Node" half that actually
 * drives a real `Viewer`/`FlythroughEngine` frame by frame using the numbers
 * this module computes.
 *
 * ---- Why a closed-form function of frame index, not accumulated deltas ----
 * The brief's acceptance bar is "frame N maps to a deterministic mileage,
 * independent of fps and of any real clock". `cameraPath.ts#speedToMileageDelta`
 * already establishes the *rate* (metres per second of virtual time) via
 * `averageSpeedMps` and the user's chosen playback multiplier -- but P1's
 * live playback consumes that rate by *accumulating* per-tick deltas
 * (`FlythroughEngine.handleTick`), which is appropriate for real-time
 * playback (ticks arrive whenever Cesium happens to render) but is the wrong
 * shape for an offline renderer: accumulating N small floating-point deltas
 * is not guaranteed to produce the exact same total as one multiplication,
 * and worse, the *set* of deltas accumulated depends on fps (60 small ticks
 * summed to reach one second is not bit-identical to 30 larger ones).
 *
 * Instead, `mileageForFrame` below evaluates the position directly as a pure
 * function of elapsed *virtual* time: `mileage(t) = speedMps * t`, clamped to
 * the track's total length. Sampling this one continuous function at
 * `t = frameIndex / fps` is what actually makes the schedule
 * fps-independent in the sense the brief means: the same virtual instant
 * `t` (e.g. "3.5 seconds into the export") always resolves to the exact same
 * mileage, whether that instant happens to land on frame 105 at 30fps or
 * frame 210 at 60fps. This is the *only* place playback speed enters the
 * schedule, mirroring `cameraPath.ts#speedToMileageDelta`'s own "only place
 * speed enters the picture" convention.
 */

// ---- Frame count / mileage schedule ---------------------------------------

export interface FrameScheduleConfig {
  /** Total mileage of the track/camera path being exported, metres. */
  totalMileageM: number
  /** Effective playback speed in metres of mileage per second of VIRTUAL
   * time -- i.e. `FlythroughEngine`'s own `baseSpeedMps * speedMultiplier`
   * (the same product `cameraPath.ts#speedToMileageDelta` would multiply by
   * elapsed real seconds during live playback). The renderer derives this
   * once, up front, from the engine's public `baseSpeedMps`/`getSpeed()` --
   * never from a wall clock while frames are being produced. */
  speedMps: number
  /** Frames per second of the exported video. Must be > 0 for a non-trivial
   * schedule; a non-positive value degrades to a single frame at mileage 0
   * rather than dividing by zero (see `virtualTimeForFrame`). */
  fps: number
}

/** Total virtual-time duration (seconds) a full traversal at `config.speedMps`
 * takes. `0` for a degenerate config (no mileage, or no speed -- e.g. the
 * track hasn't loaded, or the engine reported a zero base speed) rather than
 * `Infinity`/`NaN`, so `computeFrameCount` always has a finite answer. */
export function computeTotalDurationSeconds(config: FrameScheduleConfig): number {
  if (config.totalMileageM <= 0 || config.speedMps <= 0) return 0
  return config.totalMileageM / config.speedMps
}

/**
 * Total number of frames the export needs, given `config`. Always >= 1 (even
 * a zero-length track still gets one frame, at mileage 0) so callers never
 * have to special-case an empty loop.
 *
 * `Math.ceil(duration * fps) + 1` rather than just `Math.ceil(...)`: the `+1`
 * guarantees the schedule includes a frame at virtual time 0 (frame 0) AND a
 * final frame whose virtual time is >= `duration` (so `mileageForFrame`'s own
 * clamp lands it exactly on `totalMileageM`, i.e. the video's last frame is
 * always the end of the track, never a hair short of it due to floating-point
 * rounding in `duration * fps`).
 */
export function computeFrameCount(config: FrameScheduleConfig): number {
  if (!(config.fps > 0)) return 1
  const duration = computeTotalDurationSeconds(config)
  return Math.max(1, Math.ceil(duration * config.fps) + 1)
}

/** Virtual time (seconds) at `frameIndex` for a `fps`-rate schedule --
 * `frameIndex / fps`, clamped to >= 0. `fps <= 0` degrades to a constant 0
 * (see `FrameScheduleConfig.fps`'s own doc comment) instead of `Infinity`. */
export function virtualTimeForFrame(frameIndex: number, fps: number): number {
  if (!(fps > 0)) return 0
  return Math.max(0, frameIndex) / fps
}

/**
 * The mileage (metres) frame `frameIndex` sits at, per this module's file
 * comment: a pure function of `frameIndex`, `config.fps`, `config.speedMps`
 * and `config.totalMileageM` only -- never of `Date.now()`,
 * `performance.now()`, or any rAF timestamp. Clamped to
 * `[0, config.totalMileageM]`, so an out-of-range `frameIndex` (e.g. one past
 * `computeFrameCount`'s own result, or a caller passing a negative index)
 * still returns a sane in-track value rather than propagating outside it.
 */
export function mileageForFrame(frameIndex: number, config: FrameScheduleConfig): number {
  const t = virtualTimeForFrame(frameIndex, config.fps)
  const raw = config.speedMps * t
  return Math.min(config.totalMileageM, Math.max(0, raw))
}

// ---- Export job cancellation state machine ---------------------------------

/**
 * Lifecycle of one export job (prefetch -> render -> finalize), plus the
 * three ways it can end early. Terminal states (`completed`/`cancelled`/
 * `error`) are absorbing -- `nextExportPhase` ignores every further event
 * once one is reached, so a stray late event (e.g. a cancel request that
 * arrives just after the job already finished on its own) can never resurrect
 * or corrupt an already-settled job.
 */
// Renamed from `RenderLoopPhase` to end a name collision with the LIVE
// `RenderLoopPhase` in `exportResolutions.ts` (a different, actively-used union).
// Two same-named types describing different things is a trap for whoever
// edits next; this one models the cancellation state machine, not the UI's
// progress phases.
export type RenderLoopPhase = 'idle' | 'prefetching' | 'rendering' | 'finalizing' | 'completed' | 'cancelled' | 'error'

export type ExportEvent =
  | { type: 'start' }
  | { type: 'prefetchDone' }
  | { type: 'framesDone' }
  | { type: 'finalizeDone' }
  | { type: 'cancel' }
  | { type: 'fail' }

const TERMINAL_PHASES: ReadonlySet<RenderLoopPhase> = new Set<RenderLoopPhase>(['completed', 'cancelled', 'error'])

/** True for the three phases `nextExportPhase` never transitions out of. */
export function isTerminalExportPhase(phase: RenderLoopPhase): boolean {
  return TERMINAL_PHASES.has(phase)
}

/**
 * Pure state-transition function for one export job. `cancel`/`fail` are
 * handled uniformly ahead of the per-phase switch below because both are
 * valid from every non-terminal phase (a user can cancel during prefetch,
 * during rendering, or while the encoder is flushing during finalize; a
 * failure -- e.g. the encoder's `error` callback firing -- can likewise
 * surface at any of those points) -- duplicating that in every `case` would
 * just be the same two lines four times over.
 *
 * An event that doesn't apply to the current phase (e.g. `framesDone` while
 * still `prefetching`) is a no-op, returning `phase` unchanged, rather than
 * throwing -- callers drive this from asynchronous, occasionally
 * out-of-order-feeling sources (a cancel request racing the last frame's own
 * completion), and silently ignoring an event that doesn't apply to the
 * current phase is the correct behaviour for a state machine that must never
 * itself throw mid-export.
 */
export function nextExportPhase(phase: RenderLoopPhase, event: ExportEvent): RenderLoopPhase {
  if (isTerminalExportPhase(phase)) return phase
  if (event.type === 'cancel') return 'cancelled'
  if (event.type === 'fail') return 'error'

  switch (phase) {
    case 'idle':
      return event.type === 'start' ? 'prefetching' : phase
    case 'prefetching':
      return event.type === 'prefetchDone' ? 'rendering' : phase
    case 'rendering':
      return event.type === 'framesDone' ? 'finalizing' : phase
    case 'finalizing':
      return event.type === 'finalizeDone' ? 'completed' : phase
    default:
      return phase
  }
}
