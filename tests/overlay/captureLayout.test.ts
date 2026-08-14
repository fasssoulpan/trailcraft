import { describe, it, expect } from 'vitest'
import { computeCaptureLayout, isPortraitFrame, type CaptureLayout } from '../../src/overlay/captureLayout'

describe('computeCaptureLayout', () => {
  it('returns scale 1 at the reference resolution (1280x800)', () => {
    const layout = computeCaptureLayout(1280, 800)
    expect(layout.scale).toBeCloseTo(1, 6)
    expect(layout.hud.x).toBeCloseTo(8, 6)
    expect(layout.hud.y).toBeCloseTo(8, 6)
    expect(layout.radar.scopeSize).toBeCloseTo(150, 6)
    expect(layout.radar.readoutWidth).toBeCloseTo(150, 6)
  })

  it('scales every position/size linearly with a uniform resolution increase', () => {
    const base = computeCaptureLayout(1280, 800)
    const doubled = computeCaptureLayout(2560, 1600)
    expect(doubled.scale).toBeCloseTo(base.scale * 2, 6)
    expect(doubled.hud.x).toBeCloseTo(base.hud.x * 2, 6)
    expect(doubled.hud.chipWidthPx).toBeCloseTo(base.hud.chipWidthPx * 2, 6)
    expect(doubled.checkpointCard.width).toBeCloseTo(base.checkpointCard.width * 2, 6)
    expect(doubled.radar.scopeSize).toBeCloseTo(base.radar.scopeSize * 2, 6)
    expect(doubled.radar.readoutWidth).toBeCloseTo(base.radar.readoutWidth * 2, 6)
  })

  it('picks the SMALLER of the two axis ratios, so an unusually narrow/short target never pushes an overlay past the opposite edge', () => {
    // Much wider than tall relative to the 1280x800 reference -- height is
    // the constraining axis (1080/800 < 3840/1280).
    const layout = computeCaptureLayout(3840, 1080)
    expect(layout.scale).toBeCloseTo(1080 / 800, 6)
  })

  it('1080p (the milestone acceptance floor) keeps every overlay fully inside the frame', () => {
    const layout = computeCaptureLayout(1920, 1080)
    expect(layout.hud.x).toBeGreaterThanOrEqual(0)
    expect(layout.hud.y).toBeGreaterThanOrEqual(0)
    expect(layout.checkpointCard.x).toBeGreaterThanOrEqual(0)
    expect(layout.checkpointCard.x + layout.checkpointCard.width).toBeLessThanOrEqual(1920)
    expect(layout.checkpointCard.y + layout.checkpointCard.height).toBeLessThanOrEqual(1080)
    expect(layout.radar.x).toBeGreaterThanOrEqual(0)
    expect(layout.radar.y).toBeGreaterThanOrEqual(0)
    expect(layout.radar.readoutX + layout.radar.readoutWidth).toBeLessThanOrEqual(1920)
    expect(layout.radar.y + layout.radar.scopeSize).toBeLessThanOrEqual(1080)
  })

  it('the checkpoint card and radar are right-aligned (their right edge tracks width, not a fixed x)', () => {
    const a = computeCaptureLayout(1920, 1080)
    const b = computeCaptureLayout(2560, 1080)
    const aCardRight = a.checkpointCard.x + a.checkpointCard.width
    const bCardRight = b.checkpointCard.x + b.checkpointCard.width
    // Same scale (height unchanged, so height stays the binding axis and
    // scale is identical) -- only the right-edge margin shifts, not the
    // rendered size.
    expect(a.scale).toBeCloseTo(b.scale, 6)
    expect(bCardRight).toBeGreaterThan(aCardRight)
  })

  it('degenerate width/height (zero, negative, NaN) fall back to a safe, finite, positive scale instead of propagating NaN/Infinity', () => {
    for (const [w, h] of [
      [0, 0],
      [-100, 500],
      [NaN, 1080],
      [1920, NaN],
      [Infinity, 1080],
    ] as const) {
      const layout = computeCaptureLayout(w, h)
      expect(Number.isFinite(layout.scale)).toBe(true)
      expect(layout.scale).toBeGreaterThan(0)
      expect(Number.isFinite(layout.hud.x)).toBe(true)
      expect(Number.isFinite(layout.checkpointCard.x)).toBe(true)
      expect(Number.isFinite(layout.radar.x)).toBe(true)
    }
  })

  it('every sub-layout carries the same scale as the top level', () => {
    const layout = computeCaptureLayout(1920, 1080)
    expect(layout.hud.scale).toBe(layout.scale)
    expect(layout.checkpointCard.scale).toBe(layout.scale)
    expect(layout.radar.scale).toBe(layout.scale)
  })
})

describe('isPortraitFrame', () => {
  it('is true only for a genuinely taller-than-wide frame', () => {
    expect(isPortraitFrame(1080, 1920)).toBe(true)
    expect(isPortraitFrame(1080, 1440)).toBe(true)
    expect(isPortraitFrame(1920, 1080)).toBe(false)
    // Square is deliberately NOT portrait -- see captureLayout.ts's own doc
    // comment on why 1:1 uses the landscape/corner treatment.
    expect(isPortraitFrame(1080, 1080)).toBe(false)
  })
})

// Bounding-box helpers for the overlap/on-canvas checks below. The HUD row's
// own layout doesn't carry an entry count (drawHudEntries draws however
// many `formatHudStats` produced, up to 5: mileage/elevation/ascent/
// gradient/heart-rate), so these checks size it for that worst case.
const MAX_HUD_ENTRIES = 5

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

function hudRect(layout: CaptureLayout, entries = MAX_HUD_ENTRIES): Rect {
  return {
    x: layout.hud.x,
    y: layout.hud.y,
    width: entries * layout.hud.chipWidthPx + (entries - 1) * layout.hud.rowGapPx,
    height: layout.hud.chipHeightPx,
  }
}

function cardRect(layout: CaptureLayout): Rect {
  return { x: layout.checkpointCard.x, y: layout.checkpointCard.y, width: layout.checkpointCard.width, height: layout.checkpointCard.height }
}

function radarRect(layout: CaptureLayout): Rect {
  const right = layout.radar.readoutX + layout.radar.readoutWidth
  return { x: layout.radar.x, y: layout.radar.y, width: right - layout.radar.x, height: layout.radar.scopeSize }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function expectOnCanvas(rect: Rect, canvasWidth: number, canvasHeight: number): void {
  expect(rect.x).toBeGreaterThanOrEqual(0)
  expect(rect.y).toBeGreaterThanOrEqual(0)
  expect(rect.x + rect.width).toBeLessThanOrEqual(canvasWidth)
  expect(rect.y + rect.height).toBeLessThanOrEqual(canvasHeight)
}

// The exact preset table `cesium/exportResolutions.ts#EXPORT_RESOLUTIONS`
// ships (P2 §3.4 Q5) -- every one of these must produce three non-overlapping,
// fully-on-canvas regions, per the milestone brief's explicit acceptance
// criterion.
const SUPPORTED_PRESETS: { name: string; width: number; height: number; orientation: 'landscape' | 'portrait' }[] = [
  { name: '16:9 1080p', width: 1920, height: 1080, orientation: 'landscape' },
  { name: '16:9 4K', width: 3840, height: 2160, orientation: 'landscape' },
  { name: '9:16 1080p', width: 1080, height: 1920, orientation: 'portrait' },
  { name: '1:1 1080p (square -- landscape/corner treatment)', width: 1080, height: 1080, orientation: 'landscape' },
  { name: '3:4 1080p', width: 1080, height: 1440, orientation: 'portrait' },
]

describe('computeCaptureLayout at every supported export preset (P2 §3.4 Q5)', () => {
  for (const preset of SUPPORTED_PRESETS) {
    describe(preset.name, () => {
      const layout = computeCaptureLayout(preset.width, preset.height)

      it(`classifies as ${preset.orientation}`, () => {
        expect(layout.orientation).toBe(preset.orientation)
      })

      it('keeps the HUD, checkpoint card and radar all fully on-canvas', () => {
        expectOnCanvas(hudRect(layout), preset.width, preset.height)
        expectOnCanvas(cardRect(layout), preset.width, preset.height)
        expectOnCanvas(radarRect(layout), preset.width, preset.height)
      })

      it('never overlaps any pair of HUD / checkpoint card / radar', () => {
        const hud = hudRect(layout)
        const card = cardRect(layout)
        const radar = radarRect(layout)
        expect(overlaps(hud, card)).toBe(false)
        expect(overlaps(hud, radar)).toBe(false)
        expect(overlaps(card, radar)).toBe(false)
      })
    })
  }
})

describe('portrait layout is independent, not a scaled/cropped landscape one (P2 §3.4 Q5)', () => {
  it('gives the checkpoint card the full frame width, not a fixed corner-sized box', () => {
    const portrait = computeCaptureLayout(1080, 1920)
    const landscape = computeCaptureLayout(1920, 1080)
    // Landscape's card is a small fixed-width corner box (well under half the
    // frame); portrait's card spans nearly the whole width -- a genuinely
    // different arrangement, not the same box just repositioned/rescaled.
    expect(landscape.checkpointCard.width / 1920).toBeLessThan(0.2)
    expect(portrait.checkpointCard.width / 1080).toBeGreaterThan(0.9)
  })

  it('stacks the checkpoint card directly below the HUD in portrait, unlike landscape where the two sit side by side', () => {
    const portrait = computeCaptureLayout(1080, 1920)
    const landscape = computeCaptureLayout(1920, 1080)
    // Landscape: HUD (left) and card (right) occupy roughly the same y --
    // they sit side by side, not stacked.
    expect(Math.abs(landscape.hud.y - landscape.checkpointCard.y)).toBeLessThan(landscape.checkpointCard.height)
    // Portrait: the card starts only once the HUD row has fully ended --
    // the "full-width band, card below it" structural change this milestone
    // requires, not merely a repositioned corner box.
    expect(portrait.checkpointCard.y).toBeGreaterThan(portrait.hud.y + portrait.hud.chipHeightPx)
  })

  it('recentres the radar horizontally in portrait rather than pinning it to a corner', () => {
    const portrait = computeCaptureLayout(1080, 1920)
    const landscape = computeCaptureLayout(1920, 1080)
    const portraitRadarCenterX = portrait.radar.x + (portrait.radar.readoutX + portrait.radar.readoutWidth - portrait.radar.x) / 2
    // Landscape's radar box is right-aligned (its right edge tracks the
    // margin, see the existing "right-aligned" test above) -- its centre
    // sits well past the frame's own midpoint. Portrait's should sit close
    // to the frame's horizontal centre instead.
    expect(Math.abs(portraitRadarCenterX - 1080 / 2)).toBeLessThan(1080 * 0.05)
    const landscapeRadarRight = landscape.radar.readoutX + landscape.radar.readoutWidth
    expect(landscapeRadarRight).toBeCloseTo(1920 - 8 * landscape.scale, 6)
  })

  it('both portrait presets (9:16 and 3:4, same width) scale HUD/card identically, differing only in how much room the radar block below has', () => {
    const tall = computeCaptureLayout(1080, 1920)
    const short = computeCaptureLayout(1080, 1440)
    expect(tall.hud.chipWidthPx).toBeCloseTo(short.hud.chipWidthPx, 6)
    expect(tall.checkpointCard.width).toBeCloseTo(short.checkpointCard.width, 6)
    // The shorter (3:4) frame leaves less vertical gap between the card and
    // the radar block than the taller (9:16) one does.
    const tallGap = tall.radar.y - (tall.checkpointCard.y + tall.checkpointCard.height)
    const shortGap = short.radar.y - (short.checkpointCard.y + short.checkpointCard.height)
    expect(shortGap).toBeLessThan(tallGap)
  })
})
