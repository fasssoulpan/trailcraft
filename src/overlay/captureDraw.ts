/**
 * Canvas drawing for the video-recording compositor's overlay content (P1
 * §2.1 交付物 8, §6 R8, milestone N5) -- the "paint `captureLayout.ts`'s
 * pure positions with `hudStats.ts#formatHudStats`/
 * `checkpointApproach.ts#buildCheckpointCardData`'s pure text onto a
 * `CanvasRenderingContext2D`" half, same split as `overlay/radarRender.ts`
 * vs `overlay/radarMath.ts`.
 *
 * Every function here takes a plain `CanvasRenderingContext2D` -- never a
 * specific on-screen canvas -- so `cesium/recorder.ts`'s frame compositor
 * can target its own offscreen canvas exactly like `overlay/RadarOverlay.tsx`
 * already established for the on-screen radar (see `radarRender.ts`'s own
 * doc comment). Visual styling intentionally mirrors `App.css`'s
 * `.hud-overlay`/`.checkpoint-card` rules (colours, relative sizing) closely
 * enough to read as "the same HUD, just recorded" without being a pixel-
 * perfect reproduction -- this is explicitly a 预览级 (preview-grade)
 * recording (see `cesium/recorder.ts`'s own doc comment on why), not the P2
 * deterministic frame-by-frame pipeline.
 */
import type { HudStatEntry } from '../ui/hudStats'
import type { CheckpointCardData } from '../ui/checkpointApproach'
import type { CaptureLayout } from './captureLayout'
import type { RadarRingSet } from './radarMath'
import type { RadarTargetSet } from './radarTargets'
import { drawRadar, drawNextCheckpointReadout } from './radarRender'

const HUD_CHIP_BG = 'rgba(11, 12, 16, 0.55)'
const HUD_CHIP_BORDER = 'rgba(255, 255, 255, 0.35)'
const HUD_LABEL_COLOR = '#d1d5db'
const HUD_VALUE_COLOR = '#f8fafc'
const HUD_TEXT_GAP_PX = 4

const CARD_BG = 'rgba(11, 12, 16, 0.82)'
const CARD_BORDER = 'rgba(255, 255, 255, 0.35)'
const CARD_NAME_COLOR = '#f8fafc'
const CARD_META_COLOR = '#d1d5db'
const CARD_CUTOFF_COLOR = '#fca5a5'
const CARD_META_GAP_PX = 8
const CARD_LEFT_BORDER_BASE_PX = 4
const CARD_LINE_GAP_BASE_PX = { kindToName: 4, nameToMeta: 6 }

function fontSpec(sizePx: number, weight?: 600): string {
  return `${weight ? `${weight} ` : ''}${sizePx}px system-ui, sans-serif`
}

/**
 * Draws the HUD stat row (mileage/elevation/ascent/gradient/heart-rate) at
 * `layout`'s position -- `entries` is `hudStats.ts#formatHudStats`'s output
 * directly, so this function never formats a number itself, only lays out
 * already-formatted strings. A no-op for an empty `entries` array (no active
 * track yet), same as `HudOverlay.tsx` returning `null` in that case.
 */
export function drawHudEntries(ctx: CanvasRenderingContext2D, entries: HudStatEntry[], layout: CaptureLayout['hud']): void {
  if (entries.length === 0) return
  ctx.save()
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'

  let x = layout.x
  const textY = layout.y + layout.chipHeightPx / 2
  const gap = HUD_TEXT_GAP_PX * layout.scale

  for (const entry of entries) {
    ctx.fillStyle = HUD_CHIP_BG
    ctx.fillRect(x, layout.y, layout.chipWidthPx, layout.chipHeightPx)
    ctx.strokeStyle = HUD_CHIP_BORDER
    ctx.lineWidth = Math.max(1, layout.scale)
    ctx.strokeRect(x, layout.y, layout.chipWidthPx, layout.chipHeightPx)

    let textX = x + layout.chipPaddingXPx

    ctx.font = fontSpec(layout.labelFontPx)
    ctx.fillStyle = HUD_LABEL_COLOR
    ctx.fillText(entry.label, textX, textY)
    textX += ctx.measureText(entry.label).width + gap

    ctx.font = fontSpec(layout.valueFontPx, 600)
    ctx.fillStyle = HUD_VALUE_COLOR
    ctx.fillText(entry.value, textX, textY)
    textX += ctx.measureText(entry.value).width + gap

    if (entry.unit) {
      ctx.font = fontSpec(layout.unitFontPx)
      ctx.fillStyle = HUD_LABEL_COLOR
      ctx.fillText(entry.unit, textX, textY)
    }

    x += layout.chipWidthPx + layout.rowGapPx
  }
  ctx.restore()
}

/**
 * Draws the checkpoint approach card -- `data` is
 * `checkpointApproach.ts#buildCheckpointCardData`'s output directly, the
 * same shared formatting `CheckpointCard.tsx` draws from. Callers only
 * invoke this while a checkpoint is actually approaching (mirrors
 * `CheckpointCard.tsx` returning `null` when `visibleCp` is `undefined` --
 * there is no "empty card" state to draw here).
 */
export function drawCheckpointCard(
  ctx: CanvasRenderingContext2D,
  data: CheckpointCardData,
  layout: CaptureLayout['checkpointCard'],
): void {
  ctx.save()
  ctx.fillStyle = CARD_BG
  ctx.fillRect(layout.x, layout.y, layout.width, layout.height)
  ctx.strokeStyle = CARD_BORDER
  ctx.lineWidth = Math.max(1, layout.scale)
  ctx.strokeRect(layout.x, layout.y, layout.width, layout.height)

  const borderWidth = Math.max(2, CARD_LEFT_BORDER_BASE_PX * layout.scale)
  ctx.fillStyle = data.color
  ctx.fillRect(layout.x, layout.y, borderWidth, layout.height)

  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  const x = layout.x + layout.paddingXPx
  let y = layout.y + layout.paddingYPx

  ctx.font = fontSpec(layout.kindFontPx, 600)
  ctx.fillStyle = data.color
  ctx.fillText(data.kindLabel, x, y)
  y += layout.kindFontPx + CARD_LINE_GAP_BASE_PX.kindToName * layout.scale

  ctx.font = fontSpec(layout.nameFontPx, 600)
  ctx.fillStyle = CARD_NAME_COLOR
  ctx.fillText(data.name, x, y)
  y += layout.nameFontPx + CARD_LINE_GAP_BASE_PX.nameToMeta * layout.scale

  ctx.font = fontSpec(layout.metaFontPx)
  let metaX = x
  const metaGap = CARD_META_GAP_PX * layout.scale
  if (data.mileageKm !== undefined) {
    const text = `${data.mileageKm.toFixed(2)} km`
    ctx.fillStyle = CARD_META_COLOR
    ctx.fillText(text, metaX, y)
    metaX += ctx.measureText(text).width + metaGap
  }
  if (data.eleM !== undefined) {
    const text = `${Math.round(data.eleM)} m`
    ctx.fillStyle = CARD_META_COLOR
    ctx.fillText(text, metaX, y)
    metaX += ctx.measureText(text).width + metaGap
  }
  if (data.cutoff !== undefined) {
    ctx.fillStyle = CARD_CUTOFF_COLOR
    ctx.fillText(`关门 ${data.cutoff}`, metaX, y)
  }

  ctx.restore()
}

/**
 * Draws the distance radar -- ring scope plus checkpoint targets, plus the
 * next-checkpoint text readout beside it -- into `layout`'s box on the
 * shared recording canvas, reusing `radarRender.ts#drawRadar`/
 * `drawNextCheckpointReadout` unmodified: both already take an arbitrary
 * context/position/size precisely so this milestone could do exactly this
 * (see their own doc comments). `ctx.translate` remaps `drawRadar`'s own
 * `0,0`-origin `clearRect`/drawing calls onto the scope's actual position on
 * the shared canvas, without `drawRadar` itself needing to know an offset
 * exists; the readout is drawn directly at its own `(layout.readoutX,
 * layout.y)` position instead, since it has no `0,0`-origin convention to
 * remap.
 *
 * The scope is drawn self-centred within its own box (`centerX/centerY =
 * layout.scopeSize / 2`) rather than at the live marker's absolute
 * on-screen projection -- matching a corner "scope" widget convention
 * (always centred on itself, like a minimap), which is also what
 * `RadarOverlay.tsx` visually reads as on screen given its own fixed-size
 * corner box (see that component's CSS). `ringSet`/`headingRad`/
 * `metersPerPixel` (ground-scale-dependent) and `targetSet` (checkpoint
 * positions relative to the live camera) all come from the same live
 * projection/track data the on-screen radar uses for the same tick, so the
 * recorded frame never shows different numbers than what was on screen.
 */
export function drawRadarCapture(
  ctx: CanvasRenderingContext2D,
  layout: CaptureLayout['radar'],
  ringSet: RadarRingSet,
  headingRad: number,
  metersPerPixel: number,
  targetSet: RadarTargetSet,
): void {
  if (layout.scopeSize <= 0) return
  ctx.save()
  ctx.translate(layout.x, layout.y)
  drawRadar(ctx, layout.scopeSize, layout.scopeSize, ringSet, {
    centerX: layout.scopeSize / 2,
    centerY: layout.scopeSize / 2,
    headingRad,
    metersPerPixel,
    targets: targetSet.targets,
  })
  ctx.restore()

  drawNextCheckpointReadout(ctx, layout.readoutX, layout.y, layout.readoutWidth, layout.scopeSize, targetSet.next)
}
