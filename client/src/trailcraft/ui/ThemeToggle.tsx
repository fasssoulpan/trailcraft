import { useState } from 'react'
import { applyTheme, loadTheme, saveTheme, type Theme } from '../state/theme'

/**
 * Route Brief design reminder: Google-like charcoal mode is a page-level
 * reading preference, while route orange remains the action signal.
 * `main.tsx` already applies the
 * persisted theme before the first paint (see theme.ts); this component only
 * owns the *toggle* interaction, re-reading the same persisted value as its
 * initial state so it starts in sync with whatever main.tsx already applied.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme())

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    saveTheme(next)
    applyTheme(next)
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
      title={theme === 'dark' ? '浅色主题' : '深色主题'}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '◐'}</span>
      <span>{theme === 'dark' ? '浅色' : '黑色'}</span>
    </button>
  )
}
