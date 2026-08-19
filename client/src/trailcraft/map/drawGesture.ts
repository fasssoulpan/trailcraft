import type { Vertex } from '../core/toolbox/draw'

/**
 * Pure state machine for MapView's hand-drawn-route pointer gestures: grab
 * an existing vertex and drag it, click empty space to add a new vertex, or
 * double-click to finish the route. Extracted out of `MapView.tsx` -- a
 * React component wired to a live MapLibre `Map` -- specifically so these
 * transitions can be unit-tested directly; this project's test suite has no
 * browser and fires zero `requestAnimationFrame` callbacks, which is exactly
 * why the two Critical bugs below lived undetected inside that component for
 * as long as they did. `MapView.tsx` is left with only thin plumbing:
 * translate MapLibre's mousedown/mousemove/mouseup/click/dblclick events
 * into `DrawGestureEvent`s, feed them to `stepDrawGesture`, and execute the
 * returned `DrawGestureAction`s (move the store's draft vertex, toggle
 * `map.dragPan`, schedule/cancel the click-commit timer, call `finishDraw`).
 *
 * Two Critical defects (代码审查) motivated this extraction:
 *
 *  1. The old code tracked "did this gesture actually drag?" as a flag reset
 *     only inside MapLibre's own `'click'` handler. MapLibre suppresses its
 *     public `'click'` event entirely once mousedown->mouseup on-screen
 *     movement reaches its own `clickTolerance` -- which happened to be
 *     *exactly* the old `DRAG_THRESHOLD_PX` (3px) this file used to define.
 *     So a real drag past 3px meant `'click'` never fired for that gesture,
 *     the reset code never ran, and the flag stayed stuck true -- silently
 *     eating the user's next, unrelated click.
 *
 *  2. `map.dragPan.enable()` ran only from MapLibre's own `'mouseup'`, which
 *     MapLibre dispatches solely from a listener scoped to the map's canvas
 *     container. A release outside the canvas (e.g. dragging a vertex onto
 *     the adjacent sidebar and letting go there -- an easy slip, the sidebar
 *     sits right next to the map) never fires it, so `dragPan` stayed
 *     disabled indefinitely with no visible cause.
 *
 * This module fixes (1) architecturally, not by picking a different pixel
 * number: whether a click is the tail end of a vertex grab is now decided
 * purely by whether *mousedown* hit an existing vertex (`grabbedVertex`,
 * set in the `mousedown` case below and always fully recomputed -- not
 * merged -- by the *next* `mousedown`, per (1)'s fix: reset proactively at
 * the start of the next gesture, not at the end of the previous one). It is
 * never decided by comparing on-screen movement to a threshold, and never by
 * whether MapLibre's own `'click'` fires at all for the gesture. There is no
 * pixel-movement threshold left in this module for `clickTolerance` to
 * collide with -- the old `DRAG_THRESHOLD_PX` constant is gone, not
 * renumbered, because nothing here compares a distance to it any more (a
 * grabbed vertex already visually follows the pointer on every `mousemove`
 * regardless of how far it has moved; the threshold's only job was ever
 * deciding click-suppression, a job `grabbedVertex` now does correctly by
 * construction). This also fixes a second, previously-latent bug in the same
 * area: grabbing a vertex and releasing *without* moving it used to still
 * fall through to "add a new vertex" (the old code's `click` handler only
 * ever checked *movement*, never whether mousedown had actually hit a
 * vertex), dropping a duplicate on top of the one just grabbed.
 *
 * (2) is fixed one layer up, in `MapView.tsx`: a `window`-level `'mouseup'`
 * listener runs the exact same `{ type: 'mouseup' }` step as the canvas-level
 * one, so a release anywhere in the document re-enables `dragPan`, not just
 * a release that lands back on the canvas -- mirroring how MapLibre's own
 * pan handler self-heals via a document-level `mousemoveWindow` listener.
 */

export interface DrawGestureState {
  /** Index of the vertex the current gesture grabbed at `mousedown`, or
   *  `null` the rest of the time. Non-null for the whole mousedown->mouseup
   *  span; drives whether `mousemove` drags that vertex (vs. just updating
   *  the rubber-band cursor) and whether `dragPan` is disabled. */
  draggingIndex: number | null
  /** True from the moment a `mousedown` hits an existing vertex until either
   *  the matching `click`/`dblclick` consumes it or the *next* `mousedown`
   *  resets it. This -- not on-screen movement, not whether `'click'` fired
   *  -- is what `click` checks before adding a new vertex, so grabbing a
   *  vertex and letting go without moving it doesn't drop a duplicate at the
   *  same spot, and a real drag can never leak into "swallow the next
   *  click" the way it used to. */
  grabbedVertex: boolean
  /** True while a click's add-vertex commit is delayed (see
   *  `DRAW_CLICK_COMMIT_DELAY_MS` in `MapView.tsx`) waiting to see whether a
   *  `dblclick` cancels it instead. A second `click` landing in that window
   *  (browsers/MapLibre fire click, click, dblclick for a double-click) must
   *  be ignored rather than scheduling a second pending add. */
  pendingAdd: boolean
}

export const INITIAL_DRAW_GESTURE_STATE: DrawGestureState = {
  draggingIndex: null,
  grabbedVertex: false,
  pendingAdd: false,
}

export type DrawGestureEvent =
  | { type: 'mousedown'; hitIndex: number | undefined }
  | { type: 'mousemove'; lngLat: Vertex }
  | { type: 'mouseup' }
  | { type: 'click'; lngLat: Vertex }
  | { type: 'dblclick' }
  /** Fed back in once a previously-scheduled add (see `scheduleAddVertex`
   *  below) has actually committed to the store, so a later, unrelated
   *  click can schedule a new one. Not itself a raw pointer event -- see
   *  `MapView.tsx`'s `applyGesture`, which is the only caller. */
  | { type: 'addCommitted' }

export type DrawGestureAction =
  | { type: 'disableDragPan' }
  | { type: 'enableDragPan' }
  | { type: 'moveVertex'; index: number; lngLat: Vertex }
  | { type: 'setCursor'; lngLat: Vertex }
  | { type: 'scheduleAddVertex'; lngLat: Vertex }
  | { type: 'cancelScheduledAdd' }
  | { type: 'finishDraw' }

export interface DrawGestureStep {
  state: DrawGestureState
  actions: DrawGestureAction[]
}

/**
 * The single state transition function this module exists to provide: given
 * the current gesture state and one event, returns the next state and the
 * (possibly empty) list of side effects the caller must perform.
 */
export function stepDrawGesture(state: DrawGestureState, event: DrawGestureEvent): DrawGestureStep {
  switch (event.type) {
    case 'mousedown': {
      // Unconditionally recomputed (not merged with the previous state) --
      // this is defect (1)'s fix: every new gesture starts from a clean
      // slate regardless of whether the previous gesture's own 'click' ever
      // fired to reset anything.
      const wasDragging = state.draggingIndex !== null
      if (event.hitIndex === undefined) {
        return {
          state: { draggingIndex: null, grabbedVertex: false, pendingAdd: state.pendingAdd },
          // Defensive only (shouldn't be reachable -- a real second
          // mousedown can't arrive before the mouseup that would have
          // cleared this): don't strand dragPan disabled if it somehow was.
          actions: wasDragging ? [{ type: 'enableDragPan' }] : [],
        }
      }
      return {
        state: { draggingIndex: event.hitIndex, grabbedVertex: true, pendingAdd: state.pendingAdd },
        actions: [{ type: 'disableDragPan' }],
      }
    }

    case 'mousemove': {
      if (state.draggingIndex !== null) {
        return { state, actions: [{ type: 'moveVertex', index: state.draggingIndex, lngLat: event.lngLat }] }
      }
      return { state, actions: [{ type: 'setCursor', lngLat: event.lngLat }] }
    }

    case 'mouseup': {
      // Idempotent by design: this runs for both the canvas-scoped
      // 'mouseup' and the window-level fallback (defect (2)'s fix in
      // MapView.tsx), which can both fire for the same physical release.
      if (state.draggingIndex === null) return { state, actions: [] }
      return { state: { ...state, draggingIndex: null }, actions: [{ type: 'enableDragPan' }] }
    }

    case 'click': {
      if (state.grabbedVertex) {
        // Tail end of a vertex grab (moved or not) -- never adds a vertex.
        return { state: { ...state, grabbedVertex: false }, actions: [] }
      }
      if (state.pendingAdd) return { state, actions: [] } // already scheduled; ignore the repeat
      return { state: { ...state, pendingAdd: true }, actions: [{ type: 'scheduleAddVertex', lngLat: event.lngLat }] }
    }

    case 'dblclick': {
      const actions: DrawGestureAction[] = []
      if (state.pendingAdd) actions.push({ type: 'cancelScheduledAdd' })
      actions.push({ type: 'finishDraw' })
      return { state: { ...state, pendingAdd: false }, actions }
    }

    case 'addCommitted': {
      return { state: { ...state, pendingAdd: false }, actions: [] }
    }
  }
}
