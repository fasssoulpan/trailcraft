/**
 * Distance-radar drawing (P1 §3.7, milestone N6 commit 4; targets/readout
 * added as a P1 follow-up resolving §3.7's open question -- see
 * `overlay/radarTargets.ts`'s own file comment for the "rings AND
 * checkpoint targets, next-checkpoint as the primary readout" decision) --
 * the "paint `radarMath.ts`'s pure ring geometry and `radarTargets.ts`'s
 * pure target geometry onto a canvas" half, same split as
 * `map/trackLayer.ts` (pure geometry) vs `map/MapView.tsx` (the DOM/canvas
 * it's drawn into).
 *
 * `drawRadar`/`drawNextCheckpointReadout` take a plain
 * `CanvasRenderingContext2D` plus explicit position/size numbers -- neither
 * reaches for a specific on-screen canvas element or any Cesium/React type.
 * This is deliberate, not incidental: N5's video recording composites this
 * overlay together with the Cesium canvas into an offscreen canvas, which
 * only works if the drawing code can target an arbitrary context handed to
 * it, on-screen or off. `ui/RadarOverlay.tsx` is the only thing that owns a
 * real `<canvas>` element; these functions don't know it exists.
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
 *
 * Checkpoint targets (`RadarDrawOptions.targets`) plot at their OWN
 * already-heading-relative bearing (`RadarTarget.bearingRad`, see
 * `radarTargets.ts`'s doc comment for why that conversion happens there,
 * not here) scaled by `metersPerPixel` the same way ring radii are --
 * `radiusPx = distanceM / metersPerPixel` -- so a target's blip sits at
 * true scale relative to the rings around it. Only checkpoints still AHEAD
 * (`!target.passed`) are plotted: a radar shows what's in front of you, not
 * a trail of everything already passed.
 */
import type { RadarTarget, NextCheckpointInfo } from './radarTargets'
import { formatRadarDistance, type RadarRingSet } from './radarMath'
import { CP_KIND_COLORS, CP_KIND_LABELS } from '../core/model/checkpoint'

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
  /** Metres per screen pixel at the current ground scale -- the SAME value
   * used to build `ringSet` via `radarMath.ts#chooseRadarRings`, needed
   * again here to scale a target's `distanceM` into screen pixels
   * (`radiusPx = distanceM / metersPerPixel`). Required whenever `targets`
   * is non-empty; the rings themselves don't need it since it's already
   * baked into their own `radiusPx`. */
  metersPerPixel?: number
  /** Checkpoints to plot as target blips (see this module's file comment).
   * Omitted/empty falls back to the plain range-ring scope with no targets
   * -- the pre-existing behaviour, still exercised by every caller that
   * doesn't pass this. */
  targets?: RadarTarget[]
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

// ---- Checkpoint target blips ----------------------------------------------
const BLIP_RADIUS_PX = 4
/** The next checkpoint ahead draws larger, plus its own emphasis ring and a
 * leader line from the scope's centre -- "visually dominant", per the
 * brief, since it's the primary piece of information the radar exists to
 * show now. */
const NEXT_BLIP_RADIUS_PX = 6
const NEXT_EMPHASIS_RING_PX = 4
/** How far inside the outermost ring a clamped (beyond-range) blip is
 * pulled, so it reads as "sitting on the rim" rather than exactly
 * coincident with the ring's own stroke. */
const CLAMP_INSET_PX = 6
const BLIP_LABEL_FONT = 'bold 11px system-ui, sans-serif'
const CLAMP_INDICATOR_COLOR = 'rgba(255, 255, 255, 0.9)'

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

  // Checkpoint target blips -- drawn after the rings/ticks so they sit on
  // top, before the centre dot so the centre dot (the runner's own
  // position) stays the topmost, unambiguous "this is you" marker. Only
  // meaningful with both a scale (metersPerPixel) and something to plot.
  if (opts.targets && opts.targets.length > 0 && opts.metersPerPixel && opts.metersPerPixel > 0) {
    const mpp = opts.metersPerPixel
    for (const target of opts.targets) {
      // A radar shows what's ahead, not a trail of everything already
      // passed -- see this module's file comment.
      if (target.passed) continue

      const rawRadiusPx = target.distanceM / mpp
      const beyondRim = outerR > 0 && rawRadiusPx > outerR
      const radiusPx = outerR > 0 ? Math.min(rawRadiusPx, Math.max(0, outerR - CLAMP_INSET_PX)) : 0
      const pos = polar(centerX, centerY, radiusPx, target.bearingRad)
      const color = CP_KIND_COLORS[target.kind]
      const blipR = target.isNext ? NEXT_BLIP_RADIUS_PX : BLIP_RADIUS_PX

      if (target.isNext) {
        // Leader line from the runner's own position to the next
        // checkpoint's blip, plus an emphasis ring around it -- "visually
        // dominant", per the brief, since this is the primary target.
        ctx.beginPath()
        ctx.moveTo(centerX, centerY)
        ctx.lineTo(pos.x, pos.y)
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        ctx.stroke()

        ctx.beginPath()
        ctx.arc(pos.x, pos.y, blipR + NEXT_EMPHASIS_RING_PX, 0, Math.PI * 2)
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.stroke()
      }

      ctx.beginPath()
      ctx.arc(pos.x, pos.y, blipR, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()

      if (beyondRim) {
        // Visual cue that this blip's TRUE distance is further out than the
        // outermost ring shows -- a dashed ring around the clamped blip,
        // distinct from the (solid) next-checkpoint emphasis ring above, so
        // "clamped to rim" and "this is the next checkpoint" read as two
        // independent facts rather than being confused with each other.
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, blipR + 3, 0, Math.PI * 2)
        ctx.strokeStyle = CLAMP_INDICATOR_COLOR
        ctx.lineWidth = 1
        ctx.setLineDash([2, 2])
        ctx.stroke()
        ctx.setLineDash([])
      }

      if (target.isNext) {
        ctx.font = BLIP_LABEL_FONT
        ctx.fillStyle = labelColor
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillText(target.name, pos.x, pos.y - blipR - 4)
      }
    }
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

// ---- Next-checkpoint text readout -----------------------------------------

/** Reference box height the readout's font sizes/line gaps below are tuned
 * at -- `drawNextCheckpointReadout` scales every one of them by
 * `height / READOUT_REFERENCE_HEIGHT_PX`, so it stays legible (rather than
 * comically tiny or overflowing) whether it's painted into the on-screen
 * 150px-tall box or a video-recording box scaled up to whatever resolution
 * `overlay/captureLayout.ts` computed -- same self-scaling idea
 * `captureLayout.ts` itself uses, just derived from the box's own height
 * instead of a passed-in `scale` factor, so this function keeps working
 * with nothing more than "a context and a box" (see this module's file
 * comment).  Matches `RadarOverlay.tsx`'s on-screen scope height (the box
 * this was tuned against), so the common on-screen case is `scale === 1`
 * exactly. */
const READOUT_REFERENCE_HEIGHT_PX = 150

const READOUT_BG = 'rgba(11, 12, 16, 0.55)'
const READOUT_NAME_COLOR = '#f8fafc'
const READOUT_META_COLOR = '#d1d5db'
const READOUT_CUTOFF_COLOR = '#fca5a5'
const READOUT_MUTED_COLOR = '#9ca3af'
const READOUT_NO_NEXT_TEXT = '无下一检查点'

/** Truncates `text` with a trailing ellipsis so it fits within `maxWidth`
 * CSS pixels under `ctx`'s CURRENT font -- caller must set `ctx.font`
 * first. Longest-fitting-prefix search (not a fixed character count) since
 * glyph widths vary, including between CJK and Latin text this label might
 * contain (a checkpoint name is free-form user input). Returns `text`
 * unchanged when it already fits. */
function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (ctx.measureText(text).width <= maxWidth) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    const candidate = `${text.slice(0, mid)}…`
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : '…'
}

/**
 * Draws the next-checkpoint-ahead readout -- name, remaining along-track
 * distance, remaining climb, and cutoff time when set -- into the
 * `width`x`height` box at `(x, y)`. This is the radar's PRIMARY piece of
 * information (see `radarTargets.ts`'s file comment on why the radar's open
 * question was resolved as "next checkpoint first, rings as a scale
 * reference"), so it's drawn as legible stacked text lines, not a tiny
 * annotation squeezed into the ring scope itself.
 *
 * `next === undefined` (no checkpoints on the track, or all of them already
 * passed) still paints the box -- a muted placeholder line -- rather than
 * leaving a blank gap that would read as "broken" next to the still-active
 * ring scope.
 */
export function drawNextCheckpointReadout(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  next: NextCheckpointInfo | undefined,
): void {
  if (width <= 0 || height <= 0) return
  const scale = height / READOUT_REFERENCE_HEIGHT_PX
  const pad = 10 * scale

  ctx.save()
  ctx.fillStyle = READOUT_BG
  ctx.fillRect(x, y, width, height)

  const textX = x + pad
  const maxTextWidth = Math.max(0, width - pad * 2)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'

  if (!next) {
    ctx.font = `${12 * scale}px system-ui, sans-serif`
    ctx.fillStyle = READOUT_MUTED_COLOR
    ctx.fillText(READOUT_NO_NEXT_TEXT, textX, y + pad)
    ctx.restore()
    return
  }

  const accentColor = CP_KIND_COLORS[next.kind]
  let textY = y + pad

  ctx.font = `600 ${10 * scale}px system-ui, sans-serif`
  ctx.fillStyle = accentColor
  ctx.fillText(CP_KIND_LABELS[next.kind], textX, textY)
  textY += 14 * scale

  ctx.font = `600 ${14 * scale}px system-ui, sans-serif`
  ctx.fillStyle = READOUT_NAME_COLOR
  ctx.fillText(truncateToWidth(ctx, next.name, maxTextWidth), textX, textY)
  textY += 20 * scale

  ctx.font = `600 ${15 * scale}px system-ui, sans-serif`
  ctx.fillStyle = READOUT_NAME_COLOR
  ctx.fillText(formatRadarDistance(next.remainingDistanceM), textX, textY)
  textY += 20 * scale

  ctx.font = `${12 * scale}px system-ui, sans-serif`
  ctx.fillStyle = READOUT_META_COLOR
  const climbText = next.remainingClimbM !== undefined ? `↑ ${Math.round(next.remainingClimbM)} m` : '↑ --'
  ctx.fillText(climbText, textX, textY)
  textY += 18 * scale

  if (next.cutoff !== undefined) {
    ctx.font = `${12 * scale}px system-ui, sans-serif`
    ctx.fillStyle = READOUT_CUTOFF_COLOR
    ctx.fillText(`关门 ${next.cutoff}`, textX, textY)
  }

  ctx.restore()
}
