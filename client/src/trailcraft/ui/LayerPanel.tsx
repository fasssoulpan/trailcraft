import { useAppStore } from '../state/appStore'
import type { BasemapStyle } from '../state/basemapPref'
import { layerAvailabilityForMode } from './layerAvailability'
import { Field } from './primitives/Field'
import { SegmentedControl } from './primitives/SegmentedControl'
import { Section } from './primitives/Section'

const BASEMAP_OPTIONS: { value: BasemapStyle; label: string }[] = [
  { value: 'satellite', label: '卫星地形' },
  { value: 'plan', label: '道路底图' },
]

/**
 * Single place to toggle the three display layers the P1 plan added on top
 * of the base map/globe (P1 §3.5-§3.7, milestone N6 commit 1): basemap
 * style, contours, distance radar.
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
    <Section
      title="全局地图设置"
      description="统一调整当前二维或三维地图的底图与辅助图层；不改变路线、配速和导出数据。"
      className="layer-panel-section"
    >
      <div className="layer-panel">
      <Field label="底图样式" hint="仅切换当前地图的影像样式，不改变平面路线图/三维巡游模式">
        <SegmentedControl
          value={currentStyle}
          options={BASEMAP_OPTIONS}
          onChange={(style) => setBasemapStyle(mode, style)}
          ariaLabel="底图样式"
        />
      </Field>

      <Field
        inline
        label="等高线"
        hint={!availability.contoursAvailable ? availability.contoursHint : undefined}
      >
        <input
          type="checkbox"
          checked={contoursEnabled}
          disabled={!availability.contoursAvailable}
          onChange={(e) => setContoursEnabled(e.target.checked)}
        />
      </Field>

      <Field inline label="距离雷达" hint={!availability.radarAvailable ? availability.radarHint : undefined}>
        <input
          type="checkbox"
          checked={radarEnabled}
          disabled={!availability.radarAvailable}
          onChange={(e) => setRadarEnabled(e.target.checked)}
        />
      </Field>
      </div>
    </Section>
  )
}
