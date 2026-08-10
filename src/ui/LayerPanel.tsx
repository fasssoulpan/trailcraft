import { useAppStore } from '../state/appStore'
import type { BasemapStyle } from '../state/basemapPref'
import { layerAvailabilityForMode } from './layerAvailability'

const BASEMAP_OPTIONS: { value: BasemapStyle; label: string }[] = [
  { value: 'satellite', label: '3D 卫星图' },
  { value: 'plan', label: '二维平面图' },
]

/**
 * Single place to toggle the three display layers the P1 plan added on top
 * of the base map/globe (P1 §3.5-§3.7, milestone N6 commit 1): basemap
 * style, contours, distance radar. Follows `ToolboxPanel.tsx`'s row/hint
 * idiom (a `<div className="toolbox-panel">`-style container of labelled
 * rows) and `ModeSwitch.tsx`'s segmented-button styling for the basemap
 * picker, rather than inventing a new visual language for this panel.
 *
 * All three toggles live in `appStore` (reading their initial values from
 * `basemapPref.ts`/`layerPrefs.ts`, writing back on every change via the
 * store actions) -- see those modules' own doc comments for why this is a
 * pure UI/device preference, not project data: not in the undo history, not
 * serialized into the project file.
 *
 * Basemap style is remembered **separately per mode** (`planBasemapStyle`/
 * `flyBasemapStyle`) but the control itself is shown regardless of the
 * current mode -- both 规划模式 (commit 2) and 巡游模式 (commit 1) now have a
 * satellite option, so there's nothing to disable here. Contours/radar are
 * Cesium-only; `layerAvailability.ts#layerAvailabilityForMode` is the single
 * source of truth for whether they're actually usable right now, and this
 * component always renders their hint text when they're not -- an
 * unavailable control must read as "not applicable in this mode", never as
 * a silently broken button.
 */
export function LayerPanel() {
  const mode = useAppStore((s) => s.mode)
  const planBasemapStyle = useAppStore((s) => s.planBasemapStyle)
  const flyBasemapStyle = useAppStore((s) => s.flyBasemapStyle)
  const setBasemapStyle = useAppStore((s) => s.setBasemapStyle)
  const contoursEnabled = useAppStore((s) => s.contoursEnabled)
  const setContoursEnabled = useAppStore((s) => s.setContoursEnabled)
  const radarEnabled = useAppStore((s) => s.radarEnabled)
  const setRadarEnabled = useAppStore((s) => s.setRadarEnabled)

  // `mode` (state/mode.ts) and `BasemapScope` (state/basemapPref.ts) are the
  // exact same 'plan' | 'fly' literal union -- see basemapPref.ts's own doc
  // comment -- so the current mode doubles as "which scope's style am I
  // showing/editing" with no translation needed.
  const currentStyle = mode === 'plan' ? planBasemapStyle : flyBasemapStyle
  const availability = layerAvailabilityForMode(mode)

  return (
    <div className="layer-panel">
      <h3 className="layer-panel__title">图层</h3>

      <div className="layer-panel__row">
        <span className="layer-panel__field-label">底图</span>
        <div className="layer-panel__group" role="group" aria-label="底图样式">
          {BASEMAP_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={
                opt.value === currentStyle ? 'layer-panel__chip layer-panel__chip--active' : 'layer-panel__chip'
              }
              onClick={() => setBasemapStyle(mode, opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="layer-panel__row">
        <label className="layer-panel__toggle">
          <input
            type="checkbox"
            checked={contoursEnabled}
            disabled={!availability.contoursAvailable}
            onChange={(e) => setContoursEnabled(e.target.checked)}
          />
          等高线
        </label>
        {!availability.contoursAvailable && availability.contoursHint && (
          <p className="layer-panel__hint">{availability.contoursHint}</p>
        )}
      </div>

      <div className="layer-panel__row">
        <label className="layer-panel__toggle">
          <input
            type="checkbox"
            checked={radarEnabled}
            disabled={!availability.radarAvailable}
            onChange={(e) => setRadarEnabled(e.target.checked)}
          />
          距离雷达
        </label>
        {!availability.radarAvailable && availability.radarHint && (
          <p className="layer-panel__hint">{availability.radarHint}</p>
        )}
      </div>
    </div>
  )
}
