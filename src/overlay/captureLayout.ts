/**
 * Pure layout maths for the video-recording compositor (P1 §2.1 交付物 8,
 * §6 R8, milestone N5) -- "given a target recording width/height, where on
 * that canvas does each overlay (HUD stat row, checkpoint card, distance
 * radar) go". No Canvas/Cesium/React import, so it's unit-testable exactly
 * like `overlay/radarMath.ts`'s ring ladder; `overlay/captureDraw.ts` is the
 * untestable-in-Node half that actually paints these onto a
 * `CanvasRenderingContext2D` at the positions this module computes.
 *
 * ---- Why not just reuse the on-screen CSS positions ----
 * `App.css`'s `.hud-overlay`/`.checkpoint-card`/`.radar-overlay` rules are
 * fixed pixel offsets (`left: 8px`, `top: 48px`, `width: 150px`, ...) tuned
 * for a typical on-screen browser viewport. The recording resolution is
 * independent of that viewport (this milestone's floor is 1080p; the
 * on-screen `fly-view__container` is very often smaller, e.g. a laptop
 * window with side panels open) -- blitting the same pixel offsets onto a
 * 1920x1080 recording canvas would leave the overlays reading as tiny and
 * mis-proportioned in one direction or the other, exactly the failure mode
 * the milestone brief calls out explicitly. Instead, every constant below
 * is defined at a `BASE_WIDTH`x`BASE_HEIGHT` reference resolution (chosen to
 * match a typical on-screen `fly-view__container`, so the recorded video
 * *looks* like a scaled-up screenshot of what the user was seeing) and
 * uniformly scaled by `computeCaptureLayout` to whatever resolution is
 * actually being recorded.
 */

/** Reference resolution the pixel constants below were tuned at -- see this
 * module's file comment. Deliberately smaller than the 1080p recording
 * floor (`cesium/recorder.ts#RECORDING_WIDTH/HEIGHT`), so the common case is
 * scaling UP, matching "record bigger than you're looking at" being the
 * normal case for this feature. */
const BASE_WIDTH = 1280
const BASE_HEIGHT = 800

const MARGIN_PX = 8

// HUD (App.css's .hud-overlay/.hud-overlay__stat): a row of stat chips
// docked to the top-left corner.
const HUD_CHIP_WIDTH_PX = 150
const HUD_CHIP_PADDING_X_PX = 9
const HUD_CHIP_PADDING_Y_PX = 4
const HUD_ROW_GAP_PX = 6
const HUD_LABEL_FONT_PX = 11
const HUD_VALUE_FONT_PX = 15
const HUD_UNIT_FONT_PX = 11

// Checkpoint card (App.css's .checkpoint-card): docked to the top-right
// corner, below the HUD's row height so the two can never collide.
const CARD_WIDTH_PX = 220
const CARD_TOP_PX = 48
const CARD_HEIGHT_PX = 84
const CARD_PADDING_X_PX = 12
const CARD_PADDING_Y_PX = 10
const CARD_KIND_FONT_PX = 11
const CARD_NAME_FONT_PX = 15
const CARD_META_FONT_PX = 12

// Distance radar (App.css's .radar-overlay): a square ring-scope docked to
// the bottom-right corner, high enough to clear fly-controls' bottom bar,
// with the next-checkpoint text readout appended immediately to its left
// (the readout is the PRIMARY information now -- see
// `overlay/radarTargets.ts`'s file comment -- so it gets its own dedicated
// width rather than being squeezed inside the scope). Both constants below
// are tuned at the SAME reference resolution the scope's own on-screen size
// is (`RadarOverlay.tsx`'s `.radar-overlay__canvas`, via `App.css`'s
// `.radar-overlay` box), so the recorded readout matches the on-screen one
// at `scale === 1`.
const RADAR_SCOPE_SIZE_PX = 150
const RADAR_GAP_PX = 10
const RADAR_READOUT_WIDTH_PX = 150
const RADAR_BOTTOM_PX = 140

export interface HudCaptureLayout {
  x: number
  y: number
  chipWidthPx: number
  chipHeightPx: number
  chipPaddingXPx: number
  rowGapPx: number
  labelFontPx: number
  valueFontPx: number
  unitFontPx: number
  scale: number
}

export interface CheckpointCardCaptureLayout {
  x: number
  y: number
  width: number
  height: number
  paddingXPx: number
  paddingYPx: number
  kindFontPx: number
  nameFontPx: number
  metaFontPx: number
  scale: number
}

export interface RadarCaptureLayout {
  /** Left edge of the ring-scope square (the whole radar box's left edge --
   * the readout panel sits to the RIGHT of the scope, see `readoutX`). */
  x: number
  y: number
  /** Side length of the (square) ring-scope. Also the readout panel's
   * height -- the two sit side by side at the same `y`, sharing one
   * height. */
  scopeSize: number
  /** Left edge of the next-checkpoint text readout panel, immediately to
   * the right of the scope (`x + scopeSize + gap`). */
  readoutX: number
  readoutWidth: number
  scale: number
}

export interface CaptureLayout {
  /** Uniform scale factor applied to every constant above, `1` at
   * `BASE_WIDTH`x`BASE_HEIGHT`. Exposed at the top level too since a couple
   * of draw-time decisions outside this module (e.g. how big a margin to
   * leave inside the radar box for its own ring labels) need it directly. */
  scale: number
  hud: HudCaptureLayout
  checkpointCard: CheckpointCardCaptureLayout
  radar: RadarCaptureLayout
}

/**
 * Computes where each overlay goes on a `width`x`height` recording canvas.
 * `scale = min(width/BASE_WIDTH, height/BASE_HEIGHT)` -- the smaller of the
 * two ratios, so scaling up a portrait-ish or unusually narrow/short target
 * can never push an overlay past the opposite edge (the same
 * "letterbox-safe" reasoning `chooseRadarRings` uses `maxRadiusPx` for).
 *
 * Degenerate `width`/`height` (non-finite, zero, negative -- e.g. a canvas
 * whose size hasn't resolved yet) fall back to `BASE_WIDTH`/`BASE_HEIGHT`
 * (i.e. `scale = 1`) rather than propagating NaN/Infinity into every
 * downstream position, matching `radarMath.ts#chooseRadarRings`'s own
 * "always return something drawable" convention.
 */
export function computeCaptureLayout(width: number, height: number): CaptureLayout {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : BASE_WIDTH
  const safeHeight = Number.isFinite(height) && height > 0 ? height : BASE_HEIGHT
  const scale = Math.min(safeWidth / BASE_WIDTH, safeHeight / BASE_HEIGHT)

  const margin = MARGIN_PX * scale

  const chipWidthPx = HUD_CHIP_WIDTH_PX * scale
  const chipHeightPx = (HUD_VALUE_FONT_PX + HUD_CHIP_PADDING_Y_PX * 2) * scale

  const cardWidth = CARD_WIDTH_PX * scale
  const cardHeight = CARD_HEIGHT_PX * scale

  const scopeSize = RADAR_SCOPE_SIZE_PX * scale
  const radarGap = RADAR_GAP_PX * scale
  const readoutWidth = RADAR_READOUT_WIDTH_PX * scale
  const radarBoxWidth = scopeSize + radarGap + readoutWidth

  return {
    scale,
    hud: {
      x: margin,
      y: margin,
      chipWidthPx,
      chipHeightPx,
      chipPaddingXPx: HUD_CHIP_PADDING_X_PX * scale,
      rowGapPx: HUD_ROW_GAP_PX * scale,
      labelFontPx: HUD_LABEL_FONT_PX * scale,
      valueFontPx: HUD_VALUE_FONT_PX * scale,
      unitFontPx: HUD_UNIT_FONT_PX * scale,
      scale,
    },
    checkpointCard: {
      x: safeWidth - margin - cardWidth,
      y: CARD_TOP_PX * scale,
      width: cardWidth,
      height: cardHeight,
      paddingXPx: CARD_PADDING_X_PX * scale,
      paddingYPx: CARD_PADDING_Y_PX * scale,
      kindFontPx: CARD_KIND_FONT_PX * scale,
      nameFontPx: CARD_NAME_FONT_PX * scale,
      metaFontPx: CARD_META_FONT_PX * scale,
      scale,
    },
    radar: {
      x: safeWidth - margin - radarBoxWidth,
      y: safeHeight - RADAR_BOTTOM_PX * scale - scopeSize,
      scopeSize,
      readoutX: safeWidth - margin - readoutWidth,
      readoutWidth,
      scale,
    },
  }
}
