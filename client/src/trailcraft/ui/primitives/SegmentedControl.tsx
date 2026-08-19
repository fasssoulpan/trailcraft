export interface SegmentedControlOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string> {
  value: T
  options: SegmentedControlOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  /** 'overlay' preserves the fixed-dark chip look used on top of the 3D
   * canvas (FlyControls' speed ladder / camera-mode / export-ratio chips) --
   * see Button.tsx's own doc comment for why that surface doesn't follow
   * the app theme. */
  variant?: 'default' | 'overlay'
  size?: 'sm' | 'md'
  className?: string
}

/**
 * One accessible radiogroup-of-buttons implementation for every "pick
 * exactly one of these options" control in the app -- the mode switch
 * (规划/巡游), the basemap switch, the pace-model tabs, the speed ladder,
 * the camera-mode chips, and the quick-calc preset-category tabs were each
 * their own hand-rolled version of this same pattern before this redesign.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  variant = 'default',
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  const cls = ['segmented', `segmented--${variant}`, size === 'sm' ? 'segmented--sm' : '', className]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={cls} role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={opt.value === value}
          disabled={opt.disabled}
          className={opt.value === value ? 'segmented__option segmented__option--active' : 'segmented__option'}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
