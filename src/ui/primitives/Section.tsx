import { useState, type ReactNode } from 'react'

export interface SectionProps {
  /** Bare label -- no longer sufficient on its own (see `description`). */
  title: string
  /**
   * One sentence explaining what this section does and when you'd use it.
   * The single biggest legibility win of this redesign: every section used
   * to be a title with no explanation, on the assumption the user already
   * knew what each control did. Optional only because a handful of sections
   * (e.g. a group wrapper with clearly-named children) don't need one --
   * most call sites should pass a real sentence, not skip this.
   */
  description?: string
  children: ReactNode
  /** Adds a header disclosure toggle. Uncontrolled by default (own local
   * open/closed state); pass `open`/`onOpenChange` to persist it externally
   * (the sidebar's task groups do this -- see state/sidebarGroups.ts). */
  collapsible?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Right-aligned header slot -- e.g. a "仅规划模式可用" availability badge. */
  actions?: ReactNode
  className?: string
  /** Visual weight: 'group' for the five top-level sidebar groups (数据/
   * 规划/分析/输出/视图), 'panel' (default) for what used to be a bare
   * `<h3>` inside one of them. Groups get a slightly heavier header and
   * their own card boundary; panels nest inside without repeating it. */
  variant?: 'group' | 'panel'
}

export function Section({
  title,
  description,
  children,
  collapsible = false,
  defaultOpen = true,
  open,
  onOpenChange,
  actions,
  className,
  variant = 'panel',
}: SectionProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const isControlled = open !== undefined
  const isOpen = isControlled ? open : internalOpen

  function toggle() {
    const next = !isOpen
    if (!isControlled) setInternalOpen(next)
    onOpenChange?.(next)
  }

  const cls = ['section', `section--${variant}`, className].filter(Boolean).join(' ')

  return (
    <section className={cls}>
      <div className="section__header">
        {collapsible ? (
          <button type="button" className="section__toggle" onClick={toggle} aria-expanded={isOpen}>
            <span className={isOpen ? 'section__chevron section__chevron--open' : 'section__chevron'} aria-hidden="true">
              ▸
            </span>
            <span className="section__title">{title}</span>
          </button>
        ) : (
          <h3 className="section__title">{title}</h3>
        )}
        {actions && <div className="section__actions">{actions}</div>}
      </div>
      {isOpen && (
        <div className="section__content">
          {description && <p className="section__description">{description}</p>}
          <div className="section__body">{children}</div>
        </div>
      )}
    </section>
  )
}
