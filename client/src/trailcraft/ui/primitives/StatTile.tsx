import type { ReactNode } from 'react'

export interface StatTileProps {
  label: string
  value: ReactNode
  unit?: string
  tone?: 'default' | 'primary' | 'success' | 'warning' | 'danger'
  className?: string
}

/**
 * label + value + unit, tabular numerals -- for the performance report,
 * quick-calculator, and any other metric-grid readout. `value` always gets
 * `.tabular-nums` (src/index.css) so digit widths don't jitter as the
 * number updates, per this redesign's tokens-layer requirement.
 */
export function StatTile({ label, value, unit, tone = 'default', className }: StatTileProps) {
  const cls = ['stat-tile', `stat-tile--${tone}`, className].filter(Boolean).join(' ')
  return (
    <div className={cls}>
      <span className="stat-tile__label">{label}</span>
      <span className="stat-tile__value tabular-nums">
        {value}
        {unit && <span className="stat-tile__unit">{unit}</span>}
      </span>
    </div>
  )
}

/** Auto-fitting grid container for a group of StatTiles -- replaces each
 * panel's own `.perf-metrics-grid`-style `repeat(auto-fill, minmax(...))`. */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={['stat-grid', className].filter(Boolean).join(' ')}>{children}</div>
}
