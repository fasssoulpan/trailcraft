import type { ReactNode } from 'react'

export interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
  /** Lays the control out beside the label instead of under it -- for short
   * inline controls (a single checkbox, a small chip row) where a full-width
   * stacked layout would waste space. */
  inline?: boolean
  className?: string
}

/**
 * label + control + optional hint/error, so every input in the app aligns
 * the same way. Replaces each panel's own `.x-panel__field` variant of the
 * same three-line layout (ToolboxPanel, PacePanel, CpPanel, QuickCalcPanel,
 * ImportPanel all had a near-identical one under a different class name).
 */
export function Field({ label, hint, error, children, inline = false, className }: FieldProps) {
  const cls = ['field', inline ? 'field--inline' : '', className].filter(Boolean).join(' ')
  return (
    <label className={cls}>
      <span className="field__label">{label}</span>
      <span className="field__control">{children}</span>
      {error ? (
        <span className="field__hint field__hint--error">{error}</span>
      ) : hint ? (
        <span className="field__hint">{hint}</span>
      ) : null}
    </label>
  )
}
