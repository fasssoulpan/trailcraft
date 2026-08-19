/**
 * Pure layout maths for the compliance credits tail's end card (P2 §3.4 Q5
 * commit 3) -- "given a target export width/height, how big should the
 * title/credit-line/note text be so it reads clearly at every supported
 * preset". Same "layout vs draw" split as `captureLayout.ts`/
 * `captureDraw.ts`, reusing that module's own scale-by-reference-resolution
 * idiom (the "layout machinery" the milestone brief points at) rather than
 * inventing a third convention.
 *
 * Unlike `captureLayout.ts`'s HUD/checkpoint-card/radar overlays -- which
 * need a genuinely different ARRANGEMENT in portrait (see that module's
 * header comment) -- the credits card is a single centred text block, so it
 * doesn't need `computeCaptureLayout`'s landscape/portrait branch: scaling
 * by the frame's SHORTER side keeps the text a sensible, legible size at
 * every shipped preset regardless of orientation (every preset but 4K
 * shares a 1080px short side; 4K's is 2160, exactly double -- see
 * `cesium/exportResolutions.ts`'s table), without the block needing to
 * rearrange itself the way multi-region overlays do.
 */

const REFERENCE_SHORT_SIDE_PX = 1080

const TITLE_FONT_PX = 34
const LINE_FONT_PX = 24
const NOTE_FONT_PX = 20
const LINE_GAP_PX = 14
const BLOCK_GAP_PX = 30
/** Fraction of the frame's shorter side reserved for text width -- keeps
 * even the longest credit line (currently the Esri imagery attribution,
 * "影像数据来自 Esri, Maxar, Earthstar Geographics") comfortably clear of
 * both edges at every supported preset; `captureDraw.ts#drawCreditsCard`
 * additionally shrinks any individual line that still measures wider than
 * this at draw time, as a defensive fallback rather than the primary fit
 * mechanism. */
const MAX_TEXT_WIDTH_RATIO = 0.82

export interface CreditsCardLayout {
  scale: number
  titleFontPx: number
  lineFontPx: number
  noteFontPx: number
  lineGapPx: number
  blockGapPx: number
  maxTextWidthPx: number
}

/**
 * Computes the credits card's text sizing for a `width`x`height` export
 * frame. Degenerate input falls back to the same safe landscape default
 * `captureLayout.ts#computeCaptureLayout` uses, for the same reason.
 */
export function computeCreditsCardLayout(width: number, height: number): CreditsCardLayout {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1280
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 800
  const shortSide = Math.min(safeWidth, safeHeight)
  const scale = shortSide / REFERENCE_SHORT_SIDE_PX

  return {
    scale,
    titleFontPx: TITLE_FONT_PX * scale,
    lineFontPx: LINE_FONT_PX * scale,
    noteFontPx: NOTE_FONT_PX * scale,
    lineGapPx: LINE_GAP_PX * scale,
    blockGapPx: BLOCK_GAP_PX * scale,
    maxTextWidthPx: shortSide * MAX_TEXT_WIDTH_RATIO,
  }
}
