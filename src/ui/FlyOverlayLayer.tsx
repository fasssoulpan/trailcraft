import type { ReactNode } from 'react'

/**
 * Composable overlay layer over the Cesium canvas (P1 §3.1, milestone N4).
 *
 * Deliberately an independent DOM layer, NOT drawn into the Cesium scene:
 * that keeps its contents crisp regardless of camera pitch/distance (a
 * label billboard entity would shrink/rotate/foreshorten with the camera)
 * and keeps a future portrait-orientation layout possible (plan §3.1) --
 * neither is true of anything rendered inside the Cesium `Scene`.
 *
 * This wrapper owns ONLY positioning/stacking (one `position: absolute;
 * inset: 0` box covering the viewport, sitting above the Cesium canvas but
 * below `FlyControls`' own overlay bar -- see `App.css`'s z-index
 * ordering) and pointer-event pass-through, not any of the overlays
 * themselves. `HudOverlay`/`CheckpointCard` are self-contained children
 * rather than markup inlined here specifically so N6 (which the P1 plan
 * says adds a distance-radar overlay into this same layer) and N5 (which
 * must composite these overlays into the recorded video) can each reason
 * about one overlay piece at a time instead of untangling them from
 * `FlyView.tsx`'s own markup -- adding a new overlay is "add another child
 * here", not "edit FlyView's render method".
 *
 * `pointer-events: none` on the layer itself so it never blocks camera
 * drag/click-through to the Cesium canvas beneath it; individual overlay
 * pieces that need to be interactive (none do yet) opt back in with their
 * own `pointer-events: auto`.
 */
export function FlyOverlayLayer({ children }: { children: ReactNode }) {
  return <div className="fly-overlay-layer">{children}</div>
}
