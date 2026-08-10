/**
 * Pure "what can `LayerPanel.tsx` actually let the user toggle right now"
 * decision (P1 §3.5-§3.7, milestone N6 commit 1), factored out of the
 * component itself for the same reason `checkpointApproach.ts`/`hudStats.ts`
 * are: it's a small branchy decision worth unit-testing without a React
 * renderer, and this repo's tests run in the Node environment (see
 * vite.config.ts's `test.environment`) with no DOM available.
 *
 * Both contours (`cesium/contours.ts`) and the distance radar
 * (`overlay/radarRender.ts` + `ui/RadarOverlay.tsx`) are Cesium/flythrough-
 * only today: 规划模式's 2D MapLibre view has no elevation data loaded (no
 * terrain provider, no `Globe#material` to paint a contour material onto)
 * and no 3D camera to project the radar's center/scale from. The milestone
 * brief is explicit that unavailable controls must be disabled *with an
 * explanatory hint*, not silently missing or silently no-op-ing -- a
 * checkbox a user can still click that visibly does nothing would read as a
 * bug, not a mode limitation.
 *
 * Basemap style is deliberately NOT covered here: commit 2 (see
 * `map/basemapStyle.ts`) gives 规划模式 its own satellite imagery, so the
 * basemap-style control is available in both modes.
 */
import type { Mode } from '../state/mode'

export interface LayerAvailability {
  contoursAvailable: boolean
  contoursHint?: string
  radarAvailable: boolean
  radarHint?: string
}

const CONTOURS_HINT_PLAN = '等高线仅在巡游模式可用：规划模式的二维地图未加载地形高程数据'
const RADAR_HINT_PLAN = '距离雷达仅在巡游模式可用：规划模式没有三维相机可供投影'

export function layerAvailabilityForMode(mode: Mode): LayerAvailability {
  if (mode === 'plan') {
    return {
      contoursAvailable: false,
      contoursHint: CONTOURS_HINT_PLAN,
      radarAvailable: false,
      radarHint: RADAR_HINT_PLAN,
    }
  }
  return { contoursAvailable: true, radarAvailable: true }
}
