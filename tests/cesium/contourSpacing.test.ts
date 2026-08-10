import { describe, expect, it } from 'vitest'
import {
  contourSpacingForCameraHeight,
  CONTOUR_NEAR_HEIGHT_M,
  CONTOUR_MID_HEIGHT_M,
  CONTOUR_SPACING_NEAR_M,
  CONTOUR_SPACING_MID_M,
  CONTOUR_SPACING_FAR_M,
} from '../../src/cesium/contourSpacing'

describe('contourSpacingForCameraHeight', () => {
  it('uses the fine spacing close to the ground', () => {
    expect(contourSpacingForCameraHeight(0)).toBe(CONTOUR_SPACING_NEAR_M)
    expect(contourSpacingForCameraHeight(500)).toBe(CONTOUR_SPACING_NEAR_M)
    expect(contourSpacingForCameraHeight(CONTOUR_NEAR_HEIGHT_M - 1)).toBe(CONTOUR_SPACING_NEAR_M)
  })

  it('uses the mid spacing in the regional band', () => {
    expect(contourSpacingForCameraHeight(CONTOUR_NEAR_HEIGHT_M)).toBe(CONTOUR_SPACING_MID_M)
    expect(contourSpacingForCameraHeight(5_000)).toBe(CONTOUR_SPACING_MID_M)
    expect(contourSpacingForCameraHeight(CONTOUR_MID_HEIGHT_M - 1)).toBe(CONTOUR_SPACING_MID_M)
  })

  it('uses the coarse spacing far from the ground', () => {
    expect(contourSpacingForCameraHeight(CONTOUR_MID_HEIGHT_M)).toBe(CONTOUR_SPACING_FAR_M)
    expect(contourSpacingForCameraHeight(1_000_000)).toBe(CONTOUR_SPACING_FAR_M)
  })

  it('treats non-finite/negative heights as "far away" rather than throwing or returning NaN', () => {
    expect(contourSpacingForCameraHeight(Number.NaN)).toBe(CONTOUR_SPACING_FAR_M)
    expect(contourSpacingForCameraHeight(Number.POSITIVE_INFINITY)).toBe(CONTOUR_SPACING_FAR_M)
    expect(contourSpacingForCameraHeight(-100)).toBe(CONTOUR_SPACING_NEAR_M) // still a real, finite comparison
  })
})
