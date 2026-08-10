/**
 * Distance-radar drawing (P1 §3.7, milestone N6 commit 4) -- the "paint
 * `radarMath.ts`'s pure ring geometry onto a canvas" half, same split as
 * `map/trackLayer.ts` (pure geometry) vs `map/MapView.tsx` (the DOM/canvas
 * it's drawn into).
 *
 * `drawRadar` takes a plain `CanvasRenderingContext2D`, a width, a height,
 * and a `RadarRingSet` -- it never reaches for a specific on-screen canvas
 * element or any Cesium/React type. This is deliberate, not incidental: N5
 * (video recording) must composite this overlay together with the Cesium
 * canvas into an offscreen canvas, which only works if the drawing code can
 * target an arbitrary context handed to it, on-screen or off. `ui/
 * RadarOverlay.tsx` is the only thing in this milestone that owns a real
 * `<canvas>` element; this function doesn't know it exists.
 *
 * ---- Layout ----
 * Ring circles are rotation-symmetric, so they're drawn independent of
 * camera heading; each ring's distance label sits at the ring's own
 * screen-up (12 o'clock) position, aviation-radar-scope convention, rather
 * than at its true-north position -- readable at a glance regardless of
 * which way the camera is currently facing. True north and general bearing
 * are instead carried by a separate ring of ticks plus a distinct "N"
 * marker, both rotated opposite to the supplied heading (see `polar` below)
 * so they always point at the real compass direction they label.
 */
import type { RadarRingSet } from './radarMath'

export interface RadarDrawOptions {
  /** Screen-space centre of the radar, e.g. the flythrough marker's
   * projected position. */
  centerX: number
  centerY: number
  /** Camera heading in radians, clockwise from north -- Cesium's own
   * `camera.heading` convention. Orients the bearing ticks/north marker;
   * ring circles themselves don't need it (see this file's doc comment). */
  headingRad: number
  /** Ring stroke colour. */
  ringColorCss?: string
  /** Ring/tick distance-label colour. */
  labelColorCss?: string
  /** North marker colour. */
  northColorCss?: string
  /** Backing "scope" disc colour, drawn behind the rings so they stay
   * legible over imagery of any brightness. */
  backingColorCss?: string
}

const DEFAULT_RING_COLOR = 'rgba(56, 189, 248, 0.9)' // #38bdf8, matches the flythrough marker/HUD accent colour elsewhere in fly-view's dark chrome
const DEFAULT_LABEL_COLOR = '#f3f4f6'
const DEFAULT_NORTH_COLOR = '#fbbf24'
const DEFAULT_BACKING_COLOR = 'rgba(11, 12, 16, 0.35)'

const TICK_STEP_DEG = 30
const TICK_LENGTH_MINOR_PX = 6
const TICK_LENGTH_MAJOR_PX = 10
const BACKING_MARGIN_PX = 4
const CENTER_DOT_RADIUS_PX = 3

/** A point at `radius` screen pixels from (cx, cy), at `screenAngleRad`
 * measured clockwise from screen-up (12 o'clock). */
function polar(cx: number, cy: number, radius: number, screenAngleRad: number): { x: number; y: number } {
  return { x: cx + radius * Math.sin(screenAngleRad), y: cy - radius * Math.cos(screenAngleRad) }
}

/**
 * Draws `ringSet` centred at `(opts.centerX, opts.centerY)` into `ctx`,
 * clearing `width`x`height` first (this function owns the full extent it's
 * given, same convention `profile/ProfileCanvas.tsx#draw` already follows
 * for its own dedicated canvas).
 */
export function drawRadar(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  ringSet: RadarRingSet,
  opts: RadarDrawOptions,
): void {
  const { centerX, centerY, headingRad } = opts
  const ringColor = opts.ringColorCss ?? DEFAULT_RING_COLOR
  const labelColor = opts.labelColorCss ?? DEFAULT_LABEL_COLOR
  const northColor = opts.northColorCss ?? DEFAULT_NORTH_COLOR
  const backingColor = opts.backingColorCss ?? DEFAULT_BACKING_COLOR

  ctx.save()
  ctx.clearRect(0, 0, width, height)

  const outerR = ringSet.rings.length > 0 ? ringSet.rings[ringSet.rings.length - 1].radiusPx : 0

  if (outerR > 0) {
    ctx.beginPath()
    ctx.arc(centerX, centerY, outerR + BACKING_MARGIN_PX, 0, Math.PI * 2)
    ctx.fillStyle = backingColor
    ctx.fill()
  }

  // Rings + distance labels.
  ctx.font = '11px system-ui, sans-serif'
  ctx.textAlign = 'center'
  for (const ring of ringSet.rings) {
    ctx.beginPath()
    ctx.arc(centerX, centerY, ring.radiusPx, 0, Math.PI * 2)
    ctx.strokeStyle = ringColor
    ctx.lineWidth = 1
    ctx.stroke()

    ctx.fillStyle = labelColor
    ctx.textBaseline = 'bottom'
    ctx.fillText(ring.label, centerX, centerY - ring.radiusPx - 2)
  }

  // Bearing ticks every 30°, oriented to camera heading -- a real-world
  // bearing B is drawn at screen angle (B - heading) so that "up" always
  // represents the camera's forward direction and the compass rotates
  // opposite the camera's own turning, matching how a moving-map/radar
  // display conventionally orients a rotating compass ring.
  if (outerR > 0) {
    for (let bearingDeg = 0; bearingDeg < 360; bearingDeg += TICK_STEP_DEG) {
      const isCardinal = bearingDeg % 90 === 0
      const bearingRad = (bearingDeg * Math.PI) / 180
      const screenAngle = bearingRad - headingRad
      const tickLen = isCardinal ? TICK_LENGTH_MAJOR_PX : TICK_LENGTH_MINOR_PX
      const p1 = polar(centerX, centerY, outerR, screenAngle)
      const p2 = polar(centerX, centerY, outerR - tickLen, screenAngle)
      ctx.beginPath()
      ctx.moveTo(p1.x, p1.y)
      ctx.lineTo(p2.x, p2.y)
      ctx.strokeStyle = ringColor
      ctx.lineWidth = isCardinal ? 2 : 1
      ctx.stroke()
    }

    // North marker: distinct colour/weight beyond the generic cardinal tick
    // at bearing 0, so true north reads at a glance without having to count
    // ticks.
    const northAngle = -headingRad
    const northPos = polar(centerX, centerY, outerR + 12, northAngle)
    ctx.fillStyle = northColor
    ctx.font = 'bold 12px system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText('N', northPos.x, northPos.y)
  }

  // Centre dot -- the radar's own reference point (the flythrough marker's
  // screen projection), so the scope still reads as "centred on something"
  // even in the degenerate ringSet.rings.length === 0 case.
  ctx.beginPath()
  ctx.arc(centerX, centerY, CENTER_DOT_RADIUS_PX, 0, Math.PI * 2)
  ctx.fillStyle = ringColor
  ctx.fill()

  ctx.restore()
}
