/**
 * Pure contour-spacing *decision* for the Cesium contour layer (P1 §3.6,
 * milestone N6 commit 2), kept free of any `cesium` import for the same
 * reason `terrainSelection.ts` is: it's branchy enough to be worth testing
 * in isolation, and doing so needs neither a real Cesium `Viewer` nor a
 * WebGL context.
 *
 * Spacing must adapt to camera height above the ground, or the contour
 * material is either an unreadable moiré up close or invisible from far
 * away (see `contours.ts`'s own doc comment for how "height above ground"
 * is actually computed from a live `Viewer`). Three bands, per the P1
 * brief's suggested figures:
 *   - below `CONTOUR_NEAR_HEIGHT_M`  -> `CONTOUR_SPACING_NEAR_M` (fine detail, close-up flythrough)
 *   - below `CONTOUR_MID_HEIGHT_M`   -> `CONTOUR_SPACING_MID_M`  (regional view)
 *   - at or above that                -> `CONTOUR_SPACING_FAR_M`  (orbit/free camera pulled far back)
 */

export const CONTOUR_NEAR_HEIGHT_M = 2_000
export const CONTOUR_MID_HEIGHT_M = 10_000

export const CONTOUR_SPACING_NEAR_M = 10
export const CONTOUR_SPACING_MID_M = 50
export const CONTOUR_SPACING_FAR_M = 100

/**
 * Chooses a contour spacing (metres) for a given camera height above the
 * local ground (metres). Non-finite or negative input (a degenerate/not-yet-
 * resolved height, e.g. before any terrain tile is loaded) is treated as
 * "far away" -- the coarsest spacing is the safe default, since it's the one
 * least likely to render as a dense, unreadable moiré if the true height
 * turns out to have been an underestimate.
 */
export function contourSpacingForCameraHeight(heightAboveGroundM: number): number {
  const h = Number.isFinite(heightAboveGroundM) ? heightAboveGroundM : Number.POSITIVE_INFINITY
  if (h < CONTOUR_NEAR_HEIGHT_M) return CONTOUR_SPACING_NEAR_M
  if (h < CONTOUR_MID_HEIGHT_M) return CONTOUR_SPACING_MID_M
  return CONTOUR_SPACING_FAR_M
}
