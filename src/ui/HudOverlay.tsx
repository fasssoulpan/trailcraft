import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from 'react'
import type { Track } from '../core/model/track'
// Type-only import, erased at compile time -- does NOT create a static
// value import of 'cesium'. Same pattern FlyControls.tsx already
// established for this exact type.
import type { FlythroughProgressInfo } from '../cesium/flythrough'
import { useAppStore } from '../state/appStore'
import { getHudTrackStats, computeHudReadout, type HudReadout } from './hudStats'

export interface HudOverlayHandle {
  /** Imperative per-frame update, called directly from the flythrough
   * engine's `onProgress` callback (see `FlyView.tsx`) -- NOT via React
   * props/state. See this file's own comment below for why. */
  update(info: FlythroughProgressInfo): void
}

interface HudOverlayProps {
  track: Track | undefined
}

const PLACEHOLDER = '--'

/**
 * Flythrough HUD (P1 §3.1/§3.4, milestone N4 commit 2): current mileage,
 * elevation, cumulative ascent, gradient, and heart rate (when the track
 * has an `hr` column). Rendered as a child of `FlyOverlayLayer`, an
 * independent DOM layer over the Cesium canvas (see that file's doc
 * comment for why this is not drawn into the Cesium scene).
 *
 * ---- Per-frame rendering approach ----
 * A naive version would take `progress: FlythroughProgressInfo` as a prop
 * (mirroring `FlyControls.tsx`) and let React re-render on every tick --
 * fine for FlyControls' handful of simple elements, but the milestone
 * brief specifically flags frame-rate re-render as a concern for the HUD.
 * So this component instead exposes an IMPERATIVE `update()` (via
 * `useImperativeHandle`) that writes straight into a handful of `<span>`
 * refs' `textContent`, and `FlyView.tsx`'s engine `onProgress` callback
 * calls it directly -- alongside, not instead of, the existing
 * `setProgressInfo` that still drives `FlyControls`. This component's own
 * props (`track`) stay referentially stable across playback and it's
 * wrapped in `React.memo`, so React's reconciler never re-renders (or
 * re-diffs the DOM for) this subtree during playback: the only per-frame
 * DOM work is the handful of direct `textContent` assignments in
 * `applyReadout` below, no Virtual DOM diffing involved at all.
 *
 * Plain DOM text (not a `<canvas>`) was the other real choice here; text
 * was picked because the content is a handful of short labels, not a
 * graphic -- CSS `text-shadow` (see `App.css`'s `.hud-overlay__value`)
 * gives free, cheap legibility over busy satellite imagery without having
 * to hand-draw a shadow per glyph on every frame the way a canvas
 * implementation would.
 *
 * ---- Matching the 2D profile ----
 * Every figure is computed by `hudStats.ts#computeHudReadout`. Gradient
 * specifically reuses the exact decimated `ProfileData` and
 * `gradientAt`/`GRADIENT_WINDOW` that `ProfileCanvas.tsx`'s own hover
 * readout uses (see `core/stats/runningStats.ts`'s doc comments for how
 * that's guaranteed, not just aimed for). Ascent reuses the SAME
 * `statsOptions` (threshold/smoothWindow) the segment table's
 * `computeSegments` uses -- read live from `appStore` below, and
 * `hudStats.ts`'s cache is keyed on both the `Track` object and a
 * `threshold:smoothWindow` string so a mid-session recalibration (dragging
 * the segment table's threshold slider) invalidates it instead of serving
 * stale figures under the old settings.
 */
export const HudOverlay = memo(
  forwardRef<HudOverlayHandle, HudOverlayProps>(function HudOverlay({ track }, ref) {
    const statsOptions = useAppStore((s) => s.statsOptions)

    const mileageRef = useRef<HTMLSpanElement>(null)
    const eleRef = useRef<HTMLSpanElement>(null)
    const ascentRef = useRef<HTMLSpanElement>(null)
    const gradientRef = useRef<HTMLSpanElement>(null)
    const hrRef = useRef<HTMLSpanElement>(null)

    // Mirrors of the latest props/state for the imperative update()
    // closure below, exactly like FlyView.tsx/MapView.tsx's own *Ref
    // mirrors for callbacks that must always see current data without
    // being re-subscribed (useImperativeHandle's factory only re-runs when
    // its dependency array changes, which is deliberately `[]` here so the
    // handle identity -- and therefore FlyView's `hudRef.current` -- never
    // changes out from under the onProgress closure that holds it).
    const trackRef = useRef(track)
    trackRef.current = track
    const statsOptionsRef = useRef(statsOptions)
    statsOptionsRef.current = statsOptions

    function applyReadout(readout: HudReadout) {
      if (mileageRef.current) mileageRef.current.textContent = readout.mileageKm.toFixed(2)
      if (eleRef.current) {
        eleRef.current.textContent = readout.elevationM !== undefined ? String(Math.round(readout.elevationM)) : PLACEHOLDER
      }
      if (ascentRef.current) {
        ascentRef.current.textContent = readout.ascentM !== undefined ? String(Math.round(readout.ascentM)) : PLACEHOLDER
      }
      if (gradientRef.current) {
        gradientRef.current.textContent =
          readout.gradientPct !== undefined ? `${readout.gradientPct >= 0 ? '+' : ''}${readout.gradientPct.toFixed(1)}%` : PLACEHOLDER
      }
      if (hrRef.current) {
        hrRef.current.textContent = readout.heartRateBpm !== undefined ? String(readout.heartRateBpm) : PLACEHOLDER
      }
    }

    useImperativeHandle(
      ref,
      () => ({
        update(info) {
          const t = trackRef.current
          if (!t) return
          const stats = getHudTrackStats(t, statsOptionsRef.current)
          applyReadout(computeHudReadout(t, stats, info.pointIndex))
        },
      }),
      [],
    )

    // Paints an "at the start" reading immediately on mount / track switch
    // / statsOptions change, instead of leaving placeholder text on screen
    // until the engine's next tick -- which, per flythrough.ts's
    // requestRenderMode discipline, may not come until the user presses
    // play or drags the scrubber. Low-frequency (fires only on track/
    // statsOptions identity change, never per playback frame), so this
    // does not reintroduce the per-tick re-render this component otherwise
    // avoids.
    useEffect(() => {
      if (!track) return
      const stats = getHudTrackStats(track, statsOptions)
      applyReadout(computeHudReadout(track, stats, 0))
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [track, statsOptions])

    if (!track) return null
    const hasHr = track.points.hr !== undefined

    // aria-hidden: this repaints up to 60 times/second while playing --
    // exposing it to assistive tech as a live region would spam updates
    // with no practical way to keep up; FlyControls' play/pause/scrubber
    // remain the accessible controls for this view.
    return (
      <div className="hud-overlay" aria-hidden="true">
        <div className="hud-overlay__stat">
          <span className="hud-overlay__label">里程</span>
          <span ref={mileageRef} className="hud-overlay__value">
            0.00
          </span>
          <span className="hud-overlay__unit">km</span>
        </div>
        <div className="hud-overlay__stat">
          <span className="hud-overlay__label">海拔</span>
          <span ref={eleRef} className="hud-overlay__value">
            {PLACEHOLDER}
          </span>
          <span className="hud-overlay__unit">m</span>
        </div>
        <div className="hud-overlay__stat">
          <span className="hud-overlay__label">累计爬升</span>
          <span ref={ascentRef} className="hud-overlay__value">
            {PLACEHOLDER}
          </span>
          <span className="hud-overlay__unit">m</span>
        </div>
        <div className="hud-overlay__stat">
          <span className="hud-overlay__label">坡度</span>
          <span ref={gradientRef} className="hud-overlay__value">
            {PLACEHOLDER}
          </span>
        </div>
        {hasHr && (
          <div className="hud-overlay__stat">
            <span className="hud-overlay__label">心率</span>
            <span ref={hrRef} className="hud-overlay__value">
              {PLACEHOLDER}
            </span>
            <span className="hud-overlay__unit">bpm</span>
          </div>
        )}
      </div>
    )
  }),
)
