import { describe, it, expect } from 'vitest'
import {
  stepDrawGesture,
  INITIAL_DRAW_GESTURE_STATE,
  type DrawGestureState,
  type DrawGestureEvent,
  type DrawGestureAction,
} from '../../src/map/drawGesture'

/** Runs a whole event sequence from the initial state, returning the final
 * state and every action emitted along the way (flattened, in order) -- most
 * tests below only care about one or the other. */
function run(events: DrawGestureEvent[]): { state: DrawGestureState; actions: DrawGestureAction[] } {
  let state = INITIAL_DRAW_GESTURE_STATE
  const actions: DrawGestureAction[] = []
  for (const event of events) {
    const step = stepDrawGesture(state, event)
    state = step.state
    actions.push(...step.actions)
  }
  return { state, actions }
}

const A: [number, number] = [10, 20]
const B: [number, number] = [10.001, 20.001]

describe('stepDrawGesture: normal paths', () => {
  it('click-to-add: a click with no vertex grabbed schedules an add at that point', () => {
    const { actions, state } = run([{ type: 'click', lngLat: A }])
    expect(actions).toEqual([{ type: 'scheduleAddVertex', lngLat: A }])
    expect(state.pendingAdd).toBe(true)
    expect(state.grabbedVertex).toBe(false)
  })

  it('a second click while an add is still pending is ignored (double-click burst)', () => {
    const { actions } = run([
      { type: 'click', lngLat: A },
      { type: 'click', lngLat: A },
    ])
    // Only the first click schedules anything.
    expect(actions).toEqual([{ type: 'scheduleAddVertex', lngLat: A }])
  })

  it('once a scheduled add commits, a later unrelated click can schedule a new one', () => {
    const { actions } = run([
      { type: 'click', lngLat: A },
      { type: 'addCommitted' },
      { type: 'click', lngLat: B },
    ])
    expect(actions).toEqual([
      { type: 'scheduleAddVertex', lngLat: A },
      { type: 'scheduleAddVertex', lngLat: B },
    ])
  })

  it('grab-and-move: mousedown on a vertex, then mousemove, drags it and disables dragPan', () => {
    const { actions, state } = run([
      { type: 'mousedown', hitIndex: 2 },
      { type: 'mousemove', lngLat: B },
    ])
    expect(actions).toEqual([
      { type: 'disableDragPan' },
      { type: 'moveVertex', index: 2, lngLat: B },
    ])
    expect(state.draggingIndex).toBe(2)
  })

  it('mousemove while nothing is grabbed just updates the rubber-band cursor', () => {
    const { actions } = run([{ type: 'mousemove', lngLat: A }])
    expect(actions).toEqual([{ type: 'setCursor', lngLat: A }])
  })

  it('grab-without-moving does NOT add a duplicate vertex on release', () => {
    const { actions, state } = run([
      { type: 'mousedown', hitIndex: 0 },
      { type: 'mouseup' },
      { type: 'click', lngLat: A }, // MapLibre's click fires: movement was 0, well under its tolerance
    ])
    // enableDragPan from mouseup, and critically no scheduleAddVertex from
    // the click that follows -- grabbedVertex (set by the mousedown that hit
    // vertex 0), not movement, is what suppresses it.
    expect(actions).toEqual([{ type: 'disableDragPan' }, { type: 'enableDragPan' }])
    expect(state.grabbedVertex).toBe(false) // consumed by the click
    expect(state.pendingAdd).toBe(false)
  })

  it('grab-and-move-then-release does not add a vertex either, once its click (if any) arrives', () => {
    const { actions } = run([
      { type: 'mousedown', hitIndex: 1 },
      { type: 'mousemove', lngLat: B },
      { type: 'mousemove', lngLat: [10.01, 20.01] },
      { type: 'mouseup' },
      { type: 'click', lngLat: [10.01, 20.01] },
    ])
    expect(actions.some((a) => a.type === 'scheduleAddVertex')).toBe(false)
  })

  it('double-click-to-finish: cancels a pending add and finishes the draw', () => {
    const { actions, state } = run([
      { type: 'click', lngLat: A }, // browsers/MapLibre fire click, click, dblclick
      { type: 'click', lngLat: A },
      { type: 'dblclick' },
    ])
    expect(actions).toEqual([
      { type: 'scheduleAddVertex', lngLat: A },
      { type: 'cancelScheduledAdd' },
      { type: 'finishDraw' },
    ])
    expect(state.pendingAdd).toBe(false)
  })

  it('double-click with nothing pending still finishes the draw (no cancel action)', () => {
    const { actions } = run([{ type: 'dblclick' }])
    expect(actions).toEqual([{ type: 'finishDraw' }])
  })

  it('mouseup with nothing grabbed is a no-op', () => {
    const { actions } = run([{ type: 'mouseup' }])
    expect(actions).toEqual([])
  })
})

describe('stepDrawGesture: regression for defect 1 (stuck dragMoved swallowing the next click)', () => {
  it('a real drag past MapLibre\'s clickTolerance, whose "click" never arrives, does not swallow the next click', () => {
    let state = INITIAL_DRAW_GESTURE_STATE

    // Gesture 1: grab vertex 0 and drag it well past MapLibre's own
    // clickTolerance (3px == the old DRAG_THRESHOLD_PX). MapLibre suppresses
    // its public 'click' for this gesture entirely -- so, unlike every other
    // test here, NO `click` event is fed in for this gesture at all. The old
    // implementation relied on that 'click' handler to reset its drag flag;
    // this is exactly the scenario that left it stuck.
    let step = stepDrawGesture(state, { type: 'mousedown', hitIndex: 0 })
    state = step.state
    step = stepDrawGesture(state, { type: 'mousemove', lngLat: [10.05, 20.05] }) // large on-screen movement
    state = step.state
    step = stepDrawGesture(state, { type: 'mouseup' })
    state = step.state
    expect(state.grabbedVertex).toBe(true) // still true -- no 'click' arrived to consume it

    // Gesture 2: the user's next, ordinary click elsewhere on the map, meant
    // to add a ordinary new vertex. Its own mousedown (hitIndex undefined --
    // empty space) must be what resets grabbedVertex, not a 'click' that
    // never came for gesture 1.
    step = stepDrawGesture(state, { type: 'mousedown', hitIndex: undefined })
    state = step.state
    expect(state.grabbedVertex).toBe(false)

    step = stepDrawGesture(state, { type: 'mouseup' })
    state = step.state
    step = stepDrawGesture(state, { type: 'click', lngLat: B })
    state = step.state
    // The critical assertion: the click is NOT swallowed.
    expect(step.actions).toEqual([{ type: 'scheduleAddVertex', lngLat: B }])
  })
})

describe('stepDrawGesture: regression for defect 2 (dragPan stuck disabled after an off-canvas release)', () => {
  it('a mouseup fed in from a window-level fallback (release landed off-canvas) still re-enables dragPan', () => {
    // The reducer itself doesn't know or care where the mouseup DOM event
    // originated (canvas-scoped vs window-level fallback) -- both are just
    // `{ type: 'mouseup' }`. That's the point: MapView.tsx wires both
    // listeners to the same step function, so whichever one actually fires
    // reaches the same code path and the same fix.
    const { actions, state } = run([
      { type: 'mousedown', hitIndex: 3 }, // grab a vertex, disabling dragPan
      { type: 'mousemove', lngLat: [10.5, 20.5] }, // drag it off the canvas edge
      // No further mousemove/mouseup ever arrives from the canvas -- the
      // pointer left it. Only the window-level fallback's mouseup does.
      { type: 'mouseup' },
    ])
    expect(actions).toContainEqual({ type: 'enableDragPan' })
    expect(state.draggingIndex).toBeNull()
  })

  it('dragPan is re-enabled exactly once even if both the canvas and window mouseup fire for the same release', () => {
    // MapView registers the same handler on both map.on('mouseup', ...) and
    // window.addEventListener('mouseup', ...); a release over the canvas
    // itself can trigger both. The second call must be a harmless no-op.
    const { actions } = run([
      { type: 'mousedown', hitIndex: 0 },
      { type: 'mouseup' },
      { type: 'mouseup' },
    ])
    expect(actions.filter((a) => a.type === 'enableDragPan')).toHaveLength(1)
  })
})
