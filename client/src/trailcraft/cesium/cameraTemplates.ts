/**
 * Camera template library (方案 V2.1 §5.5, milestone P3-R3 commit 2) --
 * "≥4 套模板可按段落组合" (at least 4 templates, applicable per-segment).
 *
 * A template is a pure function from a mileage range (`CameraTemplateContext`)
 * to a list of keyframe descriptors -- deliberately the exact same shape
 * `keyframes.ts`'s editing helpers produce/consume (`CameraKeyframe[]`, once
 * `materializeTemplate` below assigns ids), so a template's output and a
 * user's hand edits are indistinguishable once applied: there is no
 * "this keyframe came from a template" flag anywhere in the data model. A
 * user can apply 起点上帝视角俯冲开场 to the first 2km, then drag/retouch any
 * one of the keyframes it produced exactly the way they'd edit a keyframe
 * they placed by hand -- freely mixable by construction, not by a merge
 * step that has to reconcile two different representations.
 *
 * Free of any `cesium` import (same rule every pure module in this folder
 * documents for itself) -- these are just numbers, testable in Node.
 *
 * ---- Composition rule: applying a template REPLACES its own range -------
 * `applyCameraTemplate(track, template, range, ...)` discards every
 * keyframe (template-generated or hand-edited, no distinction -- see above)
 * whose `mileageM` falls inside `[range.startMileageM, range.endMileageM]`
 * (inclusive both ends, since a template's own boundary keyframes anchor
 * exactly there and must not be shadowed by a stale one at the same spot),
 * and splices in the freshly generated ones instead. Keyframes strictly
 * outside the range are untouched, by reference.
 *
 * This is a deliberate "last write wins, scoped to the range" rule:
 * - Applying templates to disjoint/adjacent ranges composes cleanly --
 *   exactly what "按段落组合" (compose per-segment) asks for -- since
 *   neither application can see or disturb the other's range.
 * - Applying a second template to a range that OVERLAPS an earlier one
 *   overwrites only the overlapping portion: the earlier template's
 *   keyframes outside the overlap survive untouched, and inside the
 *   overlap the later application's own keyframes are the only ones left.
 *   This is simple and predictable -- "whatever you applied most recently
 *   to this stretch is what's there now" -- and the user's own undo history
 *   (this action is wired into `state/appStore.ts` like every other
 *   edit) is the recovery path if that wasn't what they wanted, rather than
 *   this module trying to guess a blend.
 *
 * ---- Degenerate ranges fail safe -----------------------------------------
 * `applyCameraTemplate` never throws on a bad range (zero/negative length,
 * or entirely outside `[0, totalMileageM]`): `isValidTemplateRange` rejects
 * it and the input `track` is returned completely unchanged. A range that
 * partially overlaps the route is clamped into it rather than rejected --
 * "apply to the last 5km" on a 42km route asked for 37-47km is a
 * reasonable, recoverable request, not a hard error.
 */
import type { CameraKeyframe, CameraKeyframeConfig, CameraTrack } from './keyframes'
import { DEFAULT_CAMERA_CONFIG } from './keyframes'

export interface MileageRange {
  startMileageM: number
  endMileageM: number
}

export interface CameraTemplateContext extends MileageRange {
  /** The full route's own length -- most templates only need
   * `startMileageM`/`endMileageM`, but a template is free to consult this
   * too (e.g. one that behaves differently very close to the finish). */
  totalMileageM: number
}

/** One keyframe descriptor a template produces, before an id is assigned --
 * `config` is a partial patch over `DEFAULT_CAMERA_CONFIG`, not a full
 * config, so a template only has to spell out the properties it actually
 * cares about. */
export interface CameraTemplateKeyframeSpec {
  mileageM: number
  config: Partial<CameraKeyframeConfig>
}

export type CameraTemplateBuilder = (ctx: CameraTemplateContext) => CameraTemplateKeyframeSpec[]

export interface CameraTemplate {
  id: string
  /** Chinese UI label, matching 方案 V2.1 §5.5's own naming for the four
   * required templates. */
  label: string
  description: string
  build: CameraTemplateBuilder
}

// ---- Range validation -------------------------------------------------------

/** A usable range: finite bounds, positive length, and at least partially
 * inside `[0, totalMileageM]`. See this file's header comment for what
 * happens when a range fails this (nothing -- `applyCameraTemplate` no-ops). */
export function isValidTemplateRange(range: MileageRange, totalMileageM: number): boolean {
  if (!Number.isFinite(range.startMileageM) || !Number.isFinite(range.endMileageM)) return false
  if (!(totalMileageM > 0)) return false
  if (range.endMileageM <= range.startMileageM) return false
  if (range.endMileageM <= 0) return false
  if (range.startMileageM >= totalMileageM) return false
  return true
}

/** Clamps a range that's already known-valid (see `isValidTemplateRange`)
 * into `[0, totalMileageM]` -- e.g. "last 5km" requested as
 * `[totalMileageM - 5000, totalMileageM + 5000]` on a shorter route. */
function clampRange(range: MileageRange, totalMileageM: number): MileageRange {
  return {
    startMileageM: Math.min(Math.max(range.startMileageM, 0), totalMileageM),
    endMileageM: Math.min(Math.max(range.endMileageM, 0), totalMileageM),
  }
}

// ---- Materialising a template into real keyframes ---------------------------

/**
 * Turns a template's pure `build(ctx)` output into real `CameraKeyframe`s,
 * assigning each an id via the caller-supplied `makeId` -- kept as an
 * injected function (rather than this module minting ids itself, e.g. via
 * `Date.now()`/a module-level counter) so this stays a hidden-state-free
 * pure function: tests can pass a deterministic counter, and the real
 * caller (`state/appStore.ts`) passes `() => newId('kf')`, the exact same
 * id scheme every other entity in this codebase uses.
 */
export function materializeTemplate(
  template: CameraTemplate,
  ctx: CameraTemplateContext,
  makeId: () => string,
): CameraKeyframe[] {
  return template.build(ctx).map((spec) => ({
    id: makeId(),
    mileageM: spec.mileageM,
    ...DEFAULT_CAMERA_CONFIG,
    ...spec.config,
  }))
}

function replaceKeyframesInRange(track: CameraTrack, generated: CameraKeyframe[], range: MileageRange): CameraTrack {
  const kept = track.filter((k) => k.mileageM < range.startMileageM || k.mileageM > range.endMileageM)
  return [...kept, ...generated].sort((a, b) => a.mileageM - b.mileageM)
}

/**
 * Applies `template` to `range` (clamped into the route) and splices the
 * result into `track`, per this file's header comment's composition rule.
 * Returns `track` completely unchanged (same reference) when `range` fails
 * `isValidTemplateRange` -- fails safe rather than throwing or producing a
 * nonsensical single-point keyframe cluster.
 */
export function applyCameraTemplate(
  track: CameraTrack,
  template: CameraTemplate,
  range: MileageRange,
  totalMileageM: number,
  makeId: () => string,
): CameraTrack {
  if (!isValidTemplateRange(range, totalMileageM)) return track
  const clamped = clampRange(range, totalMileageM)
  const ctx: CameraTemplateContext = { startMileageM: clamped.startMileageM, endMileageM: clamped.endMileageM, totalMileageM }
  const generated = materializeTemplate(template, ctx, makeId)
  return replaceKeyframesInRange(track, generated, clamped)
}

// ---- Small range helpers (pure; the mileage lookups themselves live in
// ui/cameraTimelineLogic.ts, commit 3, since they need Track/CheckPoint data
// this module deliberately doesn't import) --------------------------------

/** Normalises two mileages (e.g. two checkpoints picked in either order)
 * into a `MileageRange`. */
export function rangeFromMileages(a: number, b: number): MileageRange {
  return a <= b ? { startMileageM: a, endMileageM: b } : { startMileageM: b, endMileageM: a }
}

/** A grade-segment's own `startDist`/`endDist` (metres) are already
 * cumulative mileage -- `core/perf/climbs.ts#GradeSegment`'s own doc
 * comment. */
export function rangeFromClimb(climb: { startDist: number; endDist: number }): MileageRange {
  return { startMileageM: climb.startDist, endMileageM: climb.endDist }
}

// ---- The four required templates (方案 V2.1 §5.5) --------------------------

/** How much of a range's own length the "ease" portion of a template gets,
 * clamped so a very short range never asks for more than the range has. */
function easeSpan(rangeSpan: number, fraction: number): number {
  return Math.min(rangeSpan, Math.max(rangeSpan * fraction, Math.min(rangeSpan, 1)))
}

const godsEyeOpening: CameraTemplate = {
  id: 'gods-eye-opening',
  label: '起点上帝视角俯冲开场',
  description: '范围起点以远景大俯角切入，随里程推进俯冲下降至常规跟随镜头——适合整条赛道或某一段的开场。',
  build: (ctx) => {
    const span = ctx.endMileageM - ctx.startMileageM
    const settleMileageM = ctx.startMileageM + easeSpan(span, 0.35)
    return [
      {
        mileageM: ctx.startMileageM,
        config: { distanceBehindM: 700, heightAboveM: 1100, pitchDeg: -72, headingOffsetDeg: 0, fovDeg: 70, speedMultiplier: 0.35 },
      },
      { mileageM: settleMileageM, config: { ...DEFAULT_CAMERA_CONFIG } },
    ]
  },
}

const fastFlyover: CameraTemplate = {
  id: 'fast-flyover',
  label: '全程快速掠过',
  description: '范围内保持统一的偏高、偏远跟随镜头与更快倍速——适合大范围概览、连接非重点路段。',
  build: (ctx) => {
    const config: Partial<CameraKeyframeConfig> = {
      distanceBehindM: 220,
      heightAboveM: 130,
      pitchDeg: -30,
      headingOffsetDeg: 0,
      fovDeg: 65,
      speedMultiplier: 4,
    }
    return [
      { mileageM: ctx.startMileageM, config },
      { mileageM: ctx.endMileageM, config },
    ]
  },
}

const climbSlowdown: CameraTemplate = {
  id: 'climb-slowdown',
  label: '爬升段慢放',
  description: '范围内降低倍速、拉近并压低跟随镜头，突出爬升的费力感（坡度数值本身已由巡游 HUD 显示）。',
  build: (ctx) => {
    const config: Partial<CameraKeyframeConfig> = {
      distanceBehindM: 75,
      heightAboveM: 28,
      pitchDeg: -8,
      headingOffsetDeg: 0,
      fovDeg: 50,
      speedMultiplier: 0.4,
    }
    return [
      { mileageM: ctx.startMileageM, config },
      { mileageM: ctx.endMileageM, config },
    ]
  },
}

const finishOrbit: CameraTemplate = {
  id: 'finish-orbit',
  label: '终点环绕定格',
  description: '范围末段以极慢倍速环绕移动点，模拟抵达终点时的环绕定格镜头。',
  build: (ctx) => {
    const span = ctx.endMileageM - ctx.startMileageM
    const orbitSpan = easeSpan(span, 0.15)
    const orbitStart = ctx.endMileageM - orbitSpan
    const approachConfig: Partial<CameraKeyframeConfig> = {
      distanceBehindM: 140,
      heightAboveM: 60,
      pitchDeg: -20,
      fovDeg: 55,
      speedMultiplier: 1,
    }
    const orbitBase: Partial<CameraKeyframeConfig> = { ...approachConfig, speedMultiplier: 0.15 }
    const sweepStepsDeg = [0, 90, 180, 270, 360]
    const specs: CameraTemplateKeyframeSpec[] = [
      { mileageM: Math.max(ctx.startMileageM, orbitStart), config: { ...orbitBase, headingOffsetDeg: 0 } },
    ]
    for (let i = 1; i < sweepStepsDeg.length; i++) {
      const frac = i / (sweepStepsDeg.length - 1)
      specs.push({
        mileageM: orbitStart + orbitSpan * frac,
        config: { ...orbitBase, headingOffsetDeg: sweepStepsDeg[i] % 360 },
      })
    }
    return specs
  },
}

export const CAMERA_TEMPLATES: readonly CameraTemplate[] = [godsEyeOpening, fastFlyover, climbSlowdown, finishOrbit]

export function getCameraTemplate(id: string): CameraTemplate | undefined {
  return CAMERA_TEMPLATES.find((t) => t.id === id)
}
