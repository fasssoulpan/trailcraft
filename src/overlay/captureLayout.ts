/**
 * Pure layout maths for the video-recording compositor (P1 §2.1 交付物 8,
 * §6 R8, milestone N5; extended to portrait/square targets by P2 §3.4
 * milestone Q5) -- "given a target recording width/height, where on that
 * canvas does each overlay (HUD stat row, checkpoint card, distance radar)
 * go". No Canvas/Cesium/React import, so it's unit-testable exactly like
 * `overlay/radarMath.ts`'s ring ladder; `overlay/captureDraw.ts` is the
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
 * is defined at a reference resolution and uniformly scaled by
 * `computeCaptureLayout` to whatever resolution is actually being recorded.
 *
 * ---- Landscape vs portrait: two INDEPENDENT layouts (P2 §3.4 Q5) ----
 * 方案 V2.1 §5.5 is explicit: 「竖屏 9:16 使用独立排版模板(而非横屏裁切)」
 * -- portrait must not be the landscape arrangement scaled or cropped into a
 * tall frame. Concretely: the landscape layout below (HUD top-left,
 * checkpoint card top-right, radar bottom-right) was designed and tuned
 * against a WIDE reference box; naively reusing its numbers at, say,
 * 1080x1920 would leave three small elements clinging to the top third of
 * the frame with 1200+px of dead space below them, and a scaled-up version
 * of the *same* corner arrangement doesn't fix that -- the frame's own
 * proportions changed, not just its size. `computeCaptureLayout` below
 * therefore dispatches on orientation (`isPortraitFrame`) to one of two
 * genuinely separate functions with their own reference resolution and
 * their own constants: `computeLandscapeLayout` (Q4's original, unchanged
 * numbers, also used for the 1:1 square preset -- see that function's own
 * doc comment for why) and `computePortraitLayout` (new: a full-width HUD
 * band, a full-width checkpoint card directly below it, and the radar
 * recentred near the bottom rather than pinned to a corner).
 */

const MARGIN_PX = 8

// ═══════════════════════════════════════════════════════════════════════
// Landscape (and square) layout -- Q4's original numbers, unchanged.
// ═══════════════════════════════════════════════════════════════════════

/** Reference resolution the landscape pixel constants below were tuned at.
 * Deliberately smaller than the 1080p recording floor
 * (`cesium/recorder.ts#RECORDING_WIDTH/HEIGHT`), so the common case is
 * scaling UP, matching "record bigger than you're looking at" being the
 * normal case for this feature. */
const LANDSCAPE_BASE_WIDTH = 1280
const LANDSCAPE_BASE_HEIGHT = 800

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
  /** Uniform scale factor applied to every constant below, `1` at each
   * layout's own reference resolution. Exposed at the top level too since a
   * couple of draw-time decisions outside this module (e.g. how big a
   * margin to leave inside the radar box for its own ring labels) need it
   * directly. */
  scale: number
  /** Which of the two independent layouts this is -- exposed so callers
   * that want to make their own orientation-dependent choices (e.g. the
   * compliance credits tail's card, P2 §3.4 Q5 commit 3) can reuse this
   * module's own classification instead of re-deriving it from
   * width/height. */
  orientation: 'landscape' | 'portrait'
  hud: HudCaptureLayout
  checkpointCard: CheckpointCardCaptureLayout
  radar: RadarCaptureLayout
}

/**
 * The landscape arrangement: HUD top-left, checkpoint card top-right, radar
 * bottom-right. `scale = min(width/BASE_WIDTH, height/BASE_HEIGHT)` -- the
 * smaller of the two ratios, so scaling up an unusually narrow/short target
 * can never push an overlay past the opposite edge (the same
 * "letterbox-safe" reasoning `chooseRadarRings` uses `maxRadiusPx` for).
 *
 * Also used for the 1:1 square preset (P2 §3.4 Q5), not just genuine
 * widescreen targets: at 1080x1080 this still comfortably fits three
 * corner-docked, non-overlapping elements with real margin to spare (unlike
 * a tall 9:16 frame, a square frame isn't narrow enough for the reference
 * implementation's landscape numbers to feel cramped or misplaced) -- see
 * this file's test suite for the actual measured regions at that preset.
 */
function computeLandscapeLayout(safeWidth: number, safeHeight: number): CaptureLayout {
  const scale = Math.min(safeWidth / LANDSCAPE_BASE_WIDTH, safeHeight / LANDSCAPE_BASE_HEIGHT)

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
    orientation: 'landscape',
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

// ═══════════════════════════════════════════════════════════════════════
// Portrait layout (P2 §3.4 Q5) -- an independent template, not a scaled or
// cropped landscape one. See this file's header comment.
// ═══════════════════════════════════════════════════════════════════════

/** Every supported portrait preset (9:16 at 1080x1920, 3:4 at 1080x1440,
 * see `cesium/exportResolutions.ts`) shares the same 1080px width, so this
 * layout's reference/scale is WIDTH-only -- unlike the landscape layout's
 * min(width-ratio, height-ratio), a portrait target's binding constraint
 * for a full-width HUD band and card is how wide the frame is, and the
 * radar block below is positioned directly from `safeHeight`, not from this
 * scale, so extra height (9:16 vs 3:4) simply becomes more breathing room
 * above the radar rather than distorting anything. */
const PORTRAIT_BASE_WIDTH = 1080

const PORTRAIT_MARGIN_PX = 24

// HUD: a full-width row of stat chips docked to the very top -- wider
// per-chip than the landscape layout's (150px at scale 1) since a portrait
// frame has an entire 1080px-wide band to itself rather than sharing the
// top edge with a checkpoint card.
const PORTRAIT_HUD_CHIP_WIDTH_PX = 180
const PORTRAIT_HUD_CHIP_PADDING_X_PX = 12
const PORTRAIT_HUD_CHIP_PADDING_Y_PX = 10
const PORTRAIT_HUD_ROW_GAP_PX = 10
const PORTRAIT_HUD_LABEL_FONT_PX = 15
const PORTRAIT_HUD_VALUE_FONT_PX = 21
const PORTRAIT_HUD_UNIT_FONT_PX = 15

// Checkpoint card: a full-width band directly below the HUD row (not a
// small top-right corner box) -- there is no HUD/card top-right collision
// to avoid here since the two are stacked, not side by side.
const PORTRAIT_CARD_GAP_PX = 16
const PORTRAIT_CARD_HEIGHT_PX = 120
const PORTRAIT_CARD_PADDING_X_PX = 20
const PORTRAIT_CARD_PADDING_Y_PX = 16
const PORTRAIT_CARD_KIND_FONT_PX = 15
const PORTRAIT_CARD_NAME_FONT_PX = 22
const PORTRAIT_CARD_META_FONT_PX = 17

// Distance radar: recentred near the bottom of the frame (not a corner --
// a portrait frame's bottom edge is as wide as the frame itself, so
// centring reads better than pinning to either side) with the scope and its
// next-checkpoint readout still side by side, same box shape as landscape's
// (see `RadarCaptureLayout`'s own doc comment), just repositioned.
const PORTRAIT_RADAR_SCOPE_SIZE_PX = 260
const PORTRAIT_RADAR_GAP_PX = 16
const PORTRAIT_RADAR_READOUT_WIDTH_PX = 260
const PORTRAIT_RADAR_BOTTOM_PX = 220

function computePortraitLayout(safeWidth: number, safeHeight: number): CaptureLayout {
  const scale = safeWidth / PORTRAIT_BASE_WIDTH
  const margin = PORTRAIT_MARGIN_PX * scale

  const chipWidthPx = PORTRAIT_HUD_CHIP_WIDTH_PX * scale
  const chipHeightPx = (PORTRAIT_HUD_VALUE_FONT_PX + PORTRAIT_HUD_CHIP_PADDING_Y_PX * 2) * scale
  const hudY = margin
  const hudBottom = hudY + chipHeightPx

  const cardWidth = safeWidth - margin * 2
  const cardHeight = PORTRAIT_CARD_HEIGHT_PX * scale
  const cardY = hudBottom + PORTRAIT_CARD_GAP_PX * scale
  const cardBottom = cardY + cardHeight

  const scopeSize = PORTRAIT_RADAR_SCOPE_SIZE_PX * scale
  const radarGap = PORTRAIT_RADAR_GAP_PX * scale
  const readoutWidth = PORTRAIT_RADAR_READOUT_WIDTH_PX * scale
  const radarBoxWidth = scopeSize + radarGap + readoutWidth
  // Bottom-anchored, but never allowed to climb back up into the card above
  // it -- a defensive clamp (irrelevant for the two shipped portrait
  // presets, both of which clear it with real margin, see this file's test
  // suite) rather than a bound this layout is normally expected to hit.
  const radarY = Math.max(cardBottom + PORTRAIT_CARD_GAP_PX * scale, safeHeight - PORTRAIT_RADAR_BOTTOM_PX * scale - scopeSize)

  return {
    scale,
    orientation: 'portrait',
    hud: {
      x: margin,
      y: hudY,
      chipWidthPx,
      chipHeightPx,
      chipPaddingXPx: PORTRAIT_HUD_CHIP_PADDING_X_PX * scale,
      rowGapPx: PORTRAIT_HUD_ROW_GAP_PX * scale,
      labelFontPx: PORTRAIT_HUD_LABEL_FONT_PX * scale,
      valueFontPx: PORTRAIT_HUD_VALUE_FONT_PX * scale,
      unitFontPx: PORTRAIT_HUD_UNIT_FONT_PX * scale,
      scale,
    },
    checkpointCard: {
      x: margin,
      y: cardY,
      width: cardWidth,
      height: cardHeight,
      paddingXPx: PORTRAIT_CARD_PADDING_X_PX * scale,
      paddingYPx: PORTRAIT_CARD_PADDING_Y_PX * scale,
      kindFontPx: PORTRAIT_CARD_KIND_FONT_PX * scale,
      nameFontPx: PORTRAIT_CARD_NAME_FONT_PX * scale,
      metaFontPx: PORTRAIT_CARD_META_FONT_PX * scale,
      scale,
    },
    radar: {
      x: (safeWidth - radarBoxWidth) / 2,
      y: radarY,
      scopeSize,
      readoutX: (safeWidth - radarBoxWidth) / 2 + scopeSize + radarGap,
      readoutWidth,
      scale,
    },
  }
}

/** `true` for a genuinely taller-than-wide frame -- the 9:16 and 3:4
 * presets. `false` (landscape) for width >= height, which deliberately
 * includes the 1:1 square preset (see `computeLandscapeLayout`'s own doc
 * comment for why square uses the landscape/corner treatment). Exported so
 * other modules that want the same orientation split (e.g. the compliance
 * credits tail, P2 §3.4 Q5 commit 3) don't re-derive it independently. */
export function isPortraitFrame(width: number, height: number): boolean {
  return height > width
}

/**
 * Computes where each overlay goes on a `width`x`height` recording canvas,
 * dispatching to `computeLandscapeLayout` or `computePortraitLayout` (see
 * this file's header comment for why these are two independent templates,
 * not one scaled between orientations).
 *
 * Degenerate `width`/`height` (non-finite, zero, negative -- e.g. a canvas
 * whose size hasn't resolved yet) fall back to a safe landscape default
 * (`LANDSCAPE_BASE_WIDTH`x`LANDSCAPE_BASE_HEIGHT`, i.e. `scale = 1`) rather
 * than propagating NaN/Infinity into every downstream position, matching
 * `radarMath.ts#chooseRadarRings`'s own "always return something drawable"
 * convention.
 */
export function computeCaptureLayout(width: number, height: number): CaptureLayout {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : LANDSCAPE_BASE_WIDTH
  const safeHeight = Number.isFinite(height) && height > 0 ? height : LANDSCAPE_BASE_HEIGHT

  return isPortraitFrame(safeWidth, safeHeight)
    ? computePortraitLayout(safeWidth, safeHeight)
    : computeLandscapeLayout(safeWidth, safeHeight)
}
