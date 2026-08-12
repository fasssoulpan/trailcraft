/**
 * Shared "latch the current HUD/checkpoint-card/radar overlay content for a
 * video-capture compositor frame" logic -- factored out of P1's
 * `recorder.ts` (milestone N5) so P2's deterministic frame-by-frame renderer
 * (`deterministicRenderer.ts`, milestone Q4) can reuse it verbatim instead of
 * re-deriving the same ~30 lines a second time. Both capture paths need
 * EXACTLY the same "what does the overlay look like right now" computation
 * for a given `FlythroughProgressInfo` tick -- keyed off the same live
 * projection/track data the on-screen `HudOverlay`/`CheckpointCard`/
 * `RadarOverlay` components use -- so that a recorded frame (real-time OR
 * deterministic) never shows different numbers than what the live UI would
 * show at the same mileage, and so the two capture paths cannot silently
 * drift apart from each other over time.
 *
 * Lives under `cesium/` (not `overlay/`): it imports `cesium/radarProjection.ts`,
 * a real Cesium value import, so this module can only ever be reached
 * through the same dynamic `import()` boundary as the rest of the
 * Cesium-touching modules (`viewer.ts`, `flythrough.ts`, `recorder.ts`, ...)
 * -- see `ui/FlyView.tsx`'s own comment on that boundary. `overlay/*.ts`
 * stays deliberately Cesium-free because `ui/FlyView.tsx`/`ui/RadarOverlay.tsx`
 * import parts of it statically for the on-screen overlays.
 */
import type { Viewer } from 'cesium'
import { projectRadarCenter } from './radarProjection'
import type { FlythroughProgressInfo } from './flythrough'
import type { Track } from '../core/model/track'
import type { CheckPoint } from '../core/model/checkpoint'
import type { StatsOptions } from '../core/stats/segments'
import { getHudTrackStats, computeHudReadout, formatHudStats, type HudStatEntry } from '../ui/hudStats'
import { pickApproachingCheckpoint, buildCheckpointCardData, type CheckpointCardData } from '../ui/checkpointApproach'
import { chooseRadarRings, type RadarRingSet } from '../overlay/radarMath'
import { buildRadarTargets, type RadarTargetSet } from '../overlay/radarTargets'
import type { CaptureLayout } from '../overlay/captureLayout'

/** Matches `RadarOverlay.tsx`'s own `RADIUS_MARGIN_PX` (reserves room for
 * ring distance labels drawn just outside their own ring), scaled to the
 * capture resolution the same way every other capture constant is. Moved
 * here from `recorder.ts` alongside the rest of the radar-snapshot logic. */
const RADAR_LABEL_MARGIN_PX = 24

export interface RadarSnapshot {
  ringSet: RadarRingSet
  headingRad: number
  metersPerPixel: number
  targetSet: RadarTargetSet
}

/** The latched "what to draw right now" content -- read directly by a
 * compositor's `drawOverlays` callback (`overlay/captureDraw.ts`'s
 * `drawHudEntries`/`drawCheckpointCard`/`drawRadarCapture`), refreshed
 * in-place by `onProgress` below. Plain mutable object rather than three
 * separate closure variables (as `recorder.ts` originally had them) so it
 * can be handed to and read by a second module (`deterministicRenderer.ts`)
 * without exposing the setter. */
export interface OverlaySnapshot {
  hudEntries: HudStatEntry[]
  checkpointCard: CheckpointCardData | undefined
  radar: RadarSnapshot | undefined
}

export interface OverlaySnapshotLatch {
  /** Current overlay content -- always defined and always reflects the most
   * recent `onProgress` call (or the all-empty initial state before the
   * first one). */
  readonly snapshot: OverlaySnapshot
  /** Recomputes `snapshot` in place from one flythrough progress tick.
   * Idempotent for repeated calls with the same `info` (both capture paths
   * can end up invoking this more than once for what is logically the same
   * frame -- see `deterministicRenderer.ts`'s own doc comment on why -- so
   * this must never do anything that isn't safe to repeat). */
  onProgress(info: FlythroughProgressInfo): void
}

export interface OverlaySnapshotLatchOptions {
  viewer: Viewer
  track: Track
  /** Every CP in the project -- `pickApproachingCheckpoint` does its own
   * `trackId` filtering internally, same defensive convention
   * `CheckpointCard.tsx` follows. */
  cps: CheckPoint[]
  statsOptions: StatsOptions
  /** Whether to compute/draw the radar ring overlay at all -- read once at
   * latch-creation time, mirroring the live `radarEnabled` toggle at the
   * moment capture starts (neither capture path supports it changing
   * mid-capture; see `recorder.ts`'s own original doc comment for why that's
   * an acceptable limitation). */
  radarEnabled: boolean
  layout: CaptureLayout
}

/**
 * Builds a fresh, empty `OverlaySnapshotLatch` bound to one capture session's
 * viewer/track/cps/layout. Call `onProgress` once per flythrough tick that
 * should be reflected in the next composited frame; read `.snapshot` from
 * the compositor's `drawOverlays` callback.
 */
export function createOverlaySnapshotLatch(options: OverlaySnapshotLatchOptions): OverlaySnapshotLatch {
  const { viewer, track, cps, statsOptions, radarEnabled, layout } = options
  const hasHr = track.points.hr !== undefined

  const snapshot: OverlaySnapshot = {
    hudEntries: [],
    checkpointCard: undefined,
    radar: undefined,
  }

  return {
    snapshot,
    onProgress(info: FlythroughProgressInfo): void {
      const stats = getHudTrackStats(track, statsOptions)
      snapshot.hudEntries = formatHudStats(computeHudReadout(track, stats, info.pointIndex), hasHr)

      const approachingCp = pickApproachingCheckpoint(cps, track, info.mileageM)
      snapshot.checkpointCard = approachingCp ? buildCheckpointCardData(approachingCp, track) : undefined

      if (radarEnabled) {
        const projection = projectRadarCenter(viewer)
        const maxRadiusPx = layout.radar.scopeSize / 2 - RADAR_LABEL_MARGIN_PX * layout.scale
        snapshot.radar =
          projection && maxRadiusPx > 0
            ? {
                ringSet: chooseRadarRings(projection.metersPerPixel, maxRadiusPx),
                headingRad: projection.headingRad,
                metersPerPixel: projection.metersPerPixel,
                // Reuses `stats.gain` computed just above for the HUD's own
                // ascent figure (see `radarTargets.ts`'s file comment) --
                // same rationale as the original `recorder.ts` code this was
                // extracted from.
                targetSet: buildRadarTargets(track, cps, info.pointIndex, projection.headingRad, stats.gain),
              }
            : undefined
      } else {
        snapshot.radar = undefined
      }
    },
  }
}
