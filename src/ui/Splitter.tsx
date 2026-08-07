import { useRef, useState } from 'react'
import { clamp } from '../state/layout'

interface SplitterProps {
  /** 'vertical' = a vertical bar the user drags left/right (sidebar|map).
   *  'horizontal' = a horizontal bar the user drags up/down (map|profile). */
  orientation: 'vertical' | 'horizontal'
  value: number
  min: number
  /** Re-read on every pointer move (not just at drag start) so a container
   * resize mid-drag (e.g. the browser window itself resizing) still
   * produces a sane clamp instead of one frozen at drag-start time. */
  getMax: () => number
  /** Called continuously (rAF-throttled) while dragging, and once more on
   * release/keyboard-adjust with the final value -- this is what makes the
   * resize "live": the caller just needs to feed this straight into the
   * pane's size, and the pane's own ResizeObserver (MapView / ProfileCanvas
   * already have one) does the rest. */
  onChange: (next: number) => void
  /** Called once, only when a drag/keyboard-adjust actually finishes, so
   * callers can persist without hammering storage on every intermediate frame. */
  onCommit: (next: number) => void
  /** True when increasing the on-screen "value" means the pointer moves in
   * the negative direction along the drag axis (e.g. the profile-height
   * splitter: dragging UP grows the profile pane below it). */
  invert?: boolean
  label: string
}

const KEYBOARD_STEP = 10

/**
 * A draggable divider between two panes. Purely a size-reporting control --
 * it does not own layout; the caller owns `value` and is responsible for
 * feeding `onChange` into whatever CSS actually sizes the panes.
 *
 * `role="separator"` + `aria-orientation`/`aria-valuenow` mark it as a
 * WAI-ARIA window-splitter for screen readers; Left/Right (vertical) or
 * Up/Down (horizontal) arrow keys nudge it by `KEYBOARD_STEP` px so it's not
 * pointer-only.
 */
export function Splitter({ orientation, value, min, getMax, onChange, onCommit, invert = false, label }: SplitterProps) {
  const [dragging, setDragging] = useState(false)
  const startPosRef = useRef(0)
  const startValueRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef<number | null>(null)

  const axisPos = (clientX: number, clientY: number) => (orientation === 'vertical' ? clientX : clientY)

  const clampNext = (raw: number) => clamp(raw, min, getMax())

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Only the primary button/touch point should start a drag.
    if (e.button !== 0) return
    e.preventDefault()
    startPosRef.current = axisPos(e.clientX, e.clientY)
    startValueRef.current = value
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)

    const flush = () => {
      rafRef.current = null
      if (pendingRef.current == null) return
      const v = pendingRef.current
      pendingRef.current = null
      onChange(v)
    }

    const handleMove = (ev: PointerEvent) => {
      const delta = axisPos(ev.clientX, ev.clientY) - startPosRef.current
      const next = clampNext(startValueRef.current + (invert ? -delta : delta))
      pendingRef.current = next
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush)
    }
    const finish = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      pendingRef.current = null
      setDragging(false)
      const delta = axisPos(ev.clientX, ev.clientY) - startPosRef.current
      const final = clampNext(startValueRef.current + (invert ? -delta : delta))
      onChange(final)
      onCommit(final)
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const decreaseKey = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
    const increaseKey = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
    let rawDelta: number
    if (e.key === decreaseKey) rawDelta = -KEYBOARD_STEP
    else if (e.key === increaseKey) rawDelta = KEYBOARD_STEP
    else return
    e.preventDefault()
    const next = clampNext(value + (invert ? -rawDelta : rawDelta))
    onChange(next)
    onCommit(next)
  }

  return (
    <div
      className={`app-splitter app-splitter--${orientation}${dragging ? ' app-splitter--dragging' : ''}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={Math.round(min)}
      aria-valuemax={Math.round(getMax())}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    />
  )
}
