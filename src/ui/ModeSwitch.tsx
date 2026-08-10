import { useAppStore } from '../state/appStore'
import type { Mode } from '../state/mode'

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
    <div className="mode-switch" role="radiogroup" aria-label="工作模式">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={mode === opt.value}
          className={
            mode === opt.value ? 'mode-switch__option mode-switch__option--active' : 'mode-switch__option'
          }
          onClick={() => setMode(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
