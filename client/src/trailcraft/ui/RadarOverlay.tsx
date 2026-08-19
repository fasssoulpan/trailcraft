import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
// Type-only import, erased at compile time -- does NOT create a static
// value import of 'cesium'. Same pattern HudOverlay.tsx/CheckpointCard.tsx
// already established for FlythroughProgressInfo; see cesium/
// radarProjection.ts's own doc comment for why this module in particular is
// safe to import a type from but never a value.
import type { RadarProjection } from '../cesium/radarProjection'
import { chooseRadarRings } from '../overlay/radarMath'
import { drawRadar, drawNextCheckpointReadout } from '../overlay/radarRender'
import type { RadarTargetSet } from '../overlay/radarTargets'

export interface RadarOverlayHandle {
  /** Imperative per-frame update, called directly from the flythrough
   * engine's `onProgress` callback via `FlyView.tsx` -- same
   * `useImperativeHandle` pattern as `HudOverlayHandle`/
   * `CheckpointCardHandle`, and for the identical reason: this repaints up
   * to 60Hz while playing, which must not go through React `setState`/
   * re-render. `projection` is `undefined` whenever there's nothing
   * meaningful to draw right now (see `cesium/radarProjection.ts`); the
   * canvas is cleared in that case rather than left showing a stale scope.
   * `targets` is `FlyView.tsx`'s already-computed
   * `radarTargets.ts#buildRadarTargets` result for the SAME tick -- this
   * component stays a "dumb" renderer of whatever it's handed, exactly like
   * it already was for `projection`, rather than reaching for `track`/`cps`
   * itself. */
  update(projection: RadarProjection | undefined, targets: RadarTargetSet): void
}

export interface RadarOverlayProps {
  enabled: boolean
}

/** Reserves room for ring distance labels, which are drawn slightly outside
 * their own ring's radius (see radarRender.ts). */
const RADIUS_MARGIN_PX = 24
/** Gap between the ring scope and the next-checkpoint readout panel beside
 * it, CSS pixels -- matches `overlay/captureLayout.ts`'s `RADAR_GAP_PX` so
 * the on-screen and recorded layouts read the same. */
const READOUT_GAP_PX = 10

/**
 * Distance-radar overlay (P1 §3.7, milestone N6 commit 4; checkpoint
 * targets/next-checkpoint readout added as a P1 follow-up -- see
 * `overlay/radarTargets.ts`'s file comment for the resolved design
 * question): a concentric range-ring scope, plotting checkpoints ahead as
 * targets and the next one as the primary readout, centred on the
 * flythrough marker and rendered as a child of `FlyOverlayLayer` alongside
 * `HudOverlay`/`CheckpointCard`. Owns exactly one on-screen `<canvas>`,
 * sized/DPR-corrected the same way `profile/ProfileCanvas.tsx` handles its
 * own canvas -- the canvas spans the WHOLE `.radar-overlay` box (scope +
 * readout side by side), not just the circular scope.
 *
 * Deliberately thin: the actual ring/target geometry and readout text
 * layout live in `overlay/radarRender.ts` (pure, takes any
 * `CanvasRenderingContext2D`), the "which checkpoints, which is next" logic
 * lives in `overlay/radarTargets.ts` (pure), and the "where's the centre,
 * what's the scale" projection lives in `cesium/radarProjection.ts` (the one
 * Cesium-touching piece, loaded through `FlyView.tsx`'s existing
 * dynamic-import boundary). This component only owns the canvas element,
 * resize/DPR handling, and laying out its own box into a scope sub-region
 * plus a readout sub-region -- `FlyView.tsx` computes the target set (it
 * already has `track`/`cps`/`statsOptions` in scope for the HUD) and hands
 * it in via `update()`, so this component stays as "dumb" about
 * track/checkpoint data as it already was about the projection.
 */
export const RadarOverlay = forwardRef<RadarOverlayHandle, RadarOverlayProps>(function RadarOverlay(
  { enabled },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sizeRef = useRef({ width: 0, height: 0 })
  const lastProjectionRef = useRef<RadarProjection | undefined>(undefined)
  const lastTargetsRef = useRef<RadarTargetSet | undefined>(undefined)

  function paint(projection: RadarProjection | undefined, targetSet: RadarTargetSet | undefined) {
    const canvas = canvasRef.current
    const { width, height } = sizeRef.current
    if (!canvas || width <= 0 || height <= 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const backingW = Math.max(1, Math.round(width * dpr))
    const backingH = Math.max(1, Math.round(height * dpr))
    if (canvas.width !== backingW) canvas.width = backingW
    if (canvas.height !== backingH) canvas.height = backingH
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    if (!projection) return

    // The scope is a square matching the container's own height (the
    // container is wider than it is tall now that the readout panel sits
    // beside it -- see App.css's `.radar-overlay`), pinned to the LEFT of
    // the box; the readout panel takes whatever width remains to its right.
    // Deriving both from the container's own measured size (rather than
    // hard-coding the CSS pixel numbers here too) means this stays correct
    // if `.radar-overlay`'s dimensions ever change without this file
    // needing a matching edit.
    const scopeSize = height
    const maxRadiusPx = scopeSize / 2 - RADIUS_MARGIN_PX
    if (maxRadiusPx > 0) {
      const ringSet = chooseRadarRings(projection.metersPerPixel, maxRadiusPx)
      // The scope is centred in THIS canvas's own scope sub-box, not at the
      // marker's viewport position. `projectRadarCenter` reports
      // `centerX`/`centerY` in full-viewport CSS pixels (e.g. ~800,400 on a
      // 1600x900 window), while this canvas is a small fixed box in the
      // corner. Feeding the viewport coordinates straight in put the centre
      // far outside the canvas, so nothing was ever drawn. Only
      // `metersPerPixel` and `headingRad` are position-independent and
      // meaningful here. `overlay/captureDraw.ts`'s `drawRadarCapture`
      // centres itself the same way for the recorded frame, so the two
      // agree.
      drawRadar(ctx, scopeSize, scopeSize, ringSet, {
        centerX: scopeSize / 2,
        centerY: scopeSize / 2,
        headingRad: projection.headingRad,
        metersPerPixel: projection.metersPerPixel,
        targets: targetSet?.targets,
      })
    }

    const readoutX = scopeSize + READOUT_GAP_PX
    const readoutWidth = width - readoutX
    drawNextCheckpointReadout(ctx, readoutX, 0, readoutWidth, height, targetSet?.next)
  }

  useImperativeHandle(
    ref,
    () => ({
      update(projection, targets) {
        lastProjectionRef.current = projection
        lastTargetsRef.current = targets
        paint(projection, targets)
      },
    }),
    [],
  )

  // Sizes the canvas to its container and repaints on resize, mirroring
  // ProfileCanvas.tsx's own ResizeObserver handling.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      sizeRef.current = { width: entry.contentRect.width, height: entry.contentRect.height }
      paint(lastProjectionRef.current, lastTargetsRef.current)
    })
    ro.observe(container)
    const rect = container.getBoundingClientRect()
    sizeRef.current = { width: rect.width, height: rect.height }
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Returning null when disabled unmounts the canvas element itself (not
  // just hiding it) -- FlyView.tsx also stops calling `update()` at all once
  // `radarEnabled` is false (see its own `radarEnabledRef` guard), so no
  // per-frame work happens on either side while the overlay is off. If a
  // stray `update()` call ever did land here anyway (e.g. a race during the
  // toggle), `paint()`'s own `!canvas` guard makes that a harmless no-op.
  if (!enabled) return null

  return (
    <div ref={containerRef} className="radar-overlay" aria-hidden="true">
      <canvas ref={canvasRef} className="radar-overlay__canvas" />
    </div>
  )
})
