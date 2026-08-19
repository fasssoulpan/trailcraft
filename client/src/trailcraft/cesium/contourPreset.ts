/**
 * Pure contour-line colour/width *preset* decision (P1 §3.6, milestone N6
 * commit 3), kept free of any `cesium` import for the same reason
 * `basemap.ts`/`contourSpacing.ts` are: it's a small decision worth unit-
 * testing without a real Cesium `Material`, and `cesium/contours.ts` is the
 * untestable-in-Node half that actually builds one from this.
 *
 * Two presets, chosen by the current basemap style (`state/basemapPref.ts`),
 * per the milestone brief: contour lines must stay legible over both a dark,
 * busy satellite photo and a lighter plan-view basemap.
 *   - `satellite`: bright, high-contrast white-on-photo, the way most
 *     satellite-imagery hiking apps draw contours.
 *   - `plan`: a dark amber/brown, matching the traditional topographic-map
 *     convention for contour lines over a light basemap -- legible without
 *     needing to be nearly as opaque as the satellite preset.
 */
import type { BasemapStyle } from '../state/basemapPref'

export interface ContourPreset {
  /** CSS colour string, passed to `Color.fromCssColorString` in contours.ts. */
  colorCss: string
  /** 0..1 alpha applied on top of `colorCss`. */
  alpha: number
  widthPx: number
}

const CONTOUR_PRESETS: Record<BasemapStyle, ContourPreset> = {
  satellite: { colorCss: '#ffffff', alpha: 0.85, widthPx: 1.2 },
  plan: { colorCss: '#7c4a03', alpha: 0.75, widthPx: 1 },
}

export function contourPresetForStyle(style: BasemapStyle): ContourPreset {
  return CONTOUR_PRESETS[style]
}
