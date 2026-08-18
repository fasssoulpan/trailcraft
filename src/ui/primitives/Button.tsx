import type { ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'overlay'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

/**
 * Single button implementation for the app, replacing the per-panel ad-hoc
 * treatments (`.pace-panel__model-btn`, `.perf-entry__button`, plain
 * unstyled `<button>`s elsewhere) that used to each invent their own look
 * for "this is the primary action" / "this one deletes something".
 *
 * `overlay` is the one exception that does NOT draw from the app's
 * light/dark theme tokens: it's for controls that sit on top of the 3D
 * flythrough canvas (FlyControls' transport bar), which stays fixed dark
 * chrome regardless of app theme so it stays legible over satellite imagery
 * of any brightness -- same reasoning as `.hud-overlay`/`.fly-controls` in
 * App.css. It does not affect the exported video (FlyControls is
 * screen-only playback UI, never composited into frames -- see
 * `src/overlay/captureDraw.ts`, which owns the video-visible chrome).
 */
export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  const cls = ['btn', `btn--${variant}`, size === 'sm' ? 'btn--sm' : '', className].filter(Boolean).join(' ')
  return <button type={type} className={cls} {...rest} />
}
