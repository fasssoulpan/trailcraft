import { useAppStore } from '../state/appStore'
import type { Mode } from '../state/mode'
import { SegmentedControl } from './primitives/SegmentedControl'

const OPTIONS: { value: Mode; label: string }[] = [
  { value: 'plan', label: '规划模式' },
  { value: 'fly', label: '巡游模式' },
]

/**
 * Switches App.tsx between MapView (2D planning) and FlyView (3D
 * flythrough) -- see appStore's `mode` field for why this is a plain UI
 * setting rather than project data. Rendered right above ProjectToolbar so
 * it reads as part of the same "header" area, matching that component's
 * visual weight rather than introducing a new one.
 */
export function ModeSwitch() {
  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)

  return (
    <SegmentedControl
      className="mode-switch"
      value={mode}
      options={OPTIONS}
      onChange={setMode}
      ariaLabel="工作模式"
    />
  )
}
