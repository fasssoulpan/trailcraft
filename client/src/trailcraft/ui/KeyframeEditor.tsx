import { useMemo, useRef, useState } from 'react'
import type { Track } from '../core/model/track'
import { newId } from '../core/model/track'
import type { CheckPoint } from '../core/model/checkpoint'
import type { StatsOptions } from '../core/stats/segments'
import { computeGradeSegments } from '../core/perf/climbs'
// Both cesium/-folder imports below are pure (zero `cesium` package imports
// in their own dependency chain -- see each file's own header comment), so
// statically importing them here does not pull the 3D engine into the main
// bundle, the same precedent `speedOptions.ts` already establishes for
// `FlyControls.tsx`.
import {
  sampleCameraAt,
  insertKeyframe,
  moveKeyframe,
  updateKeyframe,
  deleteKeyframe,
  type CameraKeyframe,
  type CameraKeyframeConfig,
  type CameraTrack,
} from '../cesium/keyframes'
import { CAMERA_TEMPLATES, applyCameraTemplate, type MileageRange } from '../cesium/cameraTemplates'
import { timelineFractionToMileage, mileageToTimelineFraction, checkpointSegments, climbSegmentRanges, totalMileage, type PickableRange } from './cameraTimelineLogic'

export interface KeyframeEditorProps {
  track: Track
  cps: CheckPoint[]
  statsOptions: StatsOptions
  cameraTrack: CameraTrack
  /** Current playhead mileage (m), e.g. `progress?.mileageM ?? 0` -- drives
   * the playhead marker and "在当前位置插入关键帧". */
  currentMileageM: number
  onChange: (next: CameraTrack) => void
  /**
   * Reuses `FlyControls.tsx`'s own scrubber action (`engine.seek(progress)`)
   * -- clicking/dragging the timeline below moves the SAME camera the
   * bottom scrubber does, through the exact same engine method, which is
   * what makes "seeking the timeline moves the actual camera" (方案 V2.1
   * §5.5's 「导出与预览镜头一致」 live-preview half) true by construction
   * rather than by two call sites happening to agree.
   */
  onSeek: (progress: number) => void
}

const CONFIG_FIELDS: Array<{ key: keyof CameraKeyframeConfig; label: string; step: number; min?: number; max?: number; unit: string }> = [
  { key: 'distanceBehindM', label: '跟随距离', step: 5, min: 5, unit: 'm' },
  { key: 'heightAboveM', label: '跟随高度', step: 5, min: 0, unit: 'm' },
  { key: 'pitchDeg', label: '俯仰角', step: 1, min: -90, max: 10, unit: '°' },
  { key: 'headingOffsetDeg', label: '方位偏移', step: 5, min: -360, max: 360, unit: '°' },
  { key: 'fovDeg', label: '视场角', step: 1, min: 10, max: 100, unit: '°' },
  { key: 'speedMultiplier', label: '本段倍速', step: 0.1, min: 0.05, max: 8, unit: 'x' },
]

function formatKm(mileageM: number): string {
  return (mileageM / 1000).toFixed(2)
}

/**
 * Keyframe timeline editor (方案 V2.1 §5.5, milestone P3-R3 commit 3) --
 * add/move/delete keyframes, edit the selected one's values, and apply a
 * camera template to a range picked from checkpoints/climbs rather than
 * typed mileages. Rendered inside `FlyView.tsx` alongside `FlyControls`,
 * matching its dark-panel idiom (`fly-controls`/`cp-panel`'s chip/row
 * rhythm) rather than introducing a second visual language.
 *
 * All mutation goes through `cesium/keyframes.ts`'s pure editing helpers,
 * then `onChange` -- this component holds no camera-track state of its own
 * beyond which keyframe is currently selected/being dragged, matching
 * `CpPanel.tsx`'s own "the store is the source of truth, this is a thin
 * view over it" convention.
 */
export function KeyframeEditor({ track, cps, statsOptions, cameraTrack, currentMileageM, onChange, onSeek }: KeyframeEditorProps) {
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [rangeKey, setRangeKey] = useState<string>('whole-route')
  const timelineRef = useRef<HTMLDivElement | null>(null)
  const draggingIdRef = useRef<string | undefined>(undefined)

  const totalMileageM = useMemo(() => totalMileage(track), [track])

  const climbs = useMemo(
    () => computeGradeSegments(track, undefined, statsOptions),
    [track, statsOptions],
  )

  const pickableRanges: PickableRange[] = useMemo(() => {
    const whole: PickableRange = { key: 'whole-route', label: '全程', startMileageM: 0, endMileageM: totalMileageM }
    return [whole, ...checkpointSegments(track, cps), ...climbSegmentRanges(climbs)]
  }, [track, cps, climbs, totalMileageM])

  const selectedRange: MileageRange = pickableRanges.find((r) => r.key === rangeKey) ?? pickableRanges[0]

  const sortedKeyframes = useMemo(() => [...cameraTrack].sort((a, b) => a.mileageM - b.mileageM), [cameraTrack])
  const selected = sortedKeyframes.find((k) => k.id === selectedId)

  if (!expanded) {
    return (
      <div className="keyframe-editor keyframe-editor--collapsed">
        <button type="button" className="keyframe-editor__toggle" onClick={() => setExpanded(true)}>
          镜头编排 ▸ {cameraTrack.length > 0 ? `（${cameraTrack.length} 个关键帧）` : ''}
        </button>
      </div>
    )
  }

  function mileageFromClientX(clientX: number): number {
    const el = timelineRef.current
    if (!el || totalMileageM <= 0) return 0
    const rect = el.getBoundingClientRect()
    const fraction = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
    return timelineFractionToMileage(fraction, totalMileageM)
  }

  function handleTimelineClick(e: React.MouseEvent<HTMLDivElement>) {
    if (draggingIdRef.current) return // a drag's own pointerup already handled this click
    const mileageM = mileageFromClientX(e.clientX)
    onSeek(mileageToTimelineFraction(mileageM, totalMileageM))
  }

  function handleMarkerPointerDown(id: string, e: React.PointerEvent<HTMLButtonElement>) {
    e.stopPropagation()
    draggingIdRef.current = id
    setSelectedId(id)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  function handleMarkerPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const id = draggingIdRef.current
    if (!id) return
    const mileageM = mileageFromClientX(e.clientX)
    onChange(moveKeyframe(cameraTrack, id, mileageM))
    onSeek(mileageToTimelineFraction(mileageM, totalMileageM))
  }

  function handleMarkerPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    draggingIdRef.current = undefined
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
  }

  function handleInsertHere() {
    const base = sampleCameraAt(cameraTrack, currentMileageM) // continuity: start from what's already showing here
    const kf: CameraKeyframe = { id: newId('kf'), mileageM: currentMileageM, ...base }
    onChange(insertKeyframe(cameraTrack, kf))
    setSelectedId(kf.id)
  }

  function handleDeleteSelected() {
    if (!selected) return
    onChange(deleteKeyframe(cameraTrack, selected.id))
    setSelectedId(undefined)
  }

  function handleFieldChange(fieldKey: keyof CameraKeyframeConfig, value: number) {
    if (!selected || !Number.isFinite(value)) return
    onChange(updateKeyframe(cameraTrack, selected.id, { [fieldKey]: value }))
  }

  function handleMileageInputChange(value: number) {
    if (!selected || !Number.isFinite(value)) return
    onChange(moveKeyframe(cameraTrack, selected.id, value * 1000))
  }

  function handleApplyTemplate(templateId: string) {
    const template = CAMERA_TEMPLATES.find((t) => t.id === templateId)
    if (!template || totalMileageM <= 0) return
    const next = applyCameraTemplate(cameraTrack, template, selectedRange, totalMileageM, () => newId('kf'))
    onChange(next)
  }

  const playheadFraction = mileageToTimelineFraction(currentMileageM, totalMileageM)

  return (
    <div className="keyframe-editor">
      <div className="keyframe-editor__header">
        <button type="button" className="keyframe-editor__toggle" onClick={() => setExpanded(false)}>
          镜头编排 ▾
        </button>
        <span className="fly-controls__hint">
          {cameraTrack.length === 0 ? '当前使用默认跟随镜头，未编排关键帧' : `${cameraTrack.length} 个关键帧`}
        </span>
      </div>

      <div
        ref={timelineRef}
        className="keyframe-editor__timeline"
        role="slider"
        aria-label="镜头关键帧时间轴"
        aria-valuemin={0}
        aria-valuemax={1000}
        aria-valuenow={Math.round(playheadFraction * 1000)}
        onClick={handleTimelineClick}
      >
        <div className="keyframe-editor__playhead" style={{ left: `${playheadFraction * 100}%` }} />
        {sortedKeyframes.map((k) => (
          <button
            key={k.id}
            type="button"
            className={k.id === selectedId ? 'keyframe-editor__marker keyframe-editor__marker--active' : 'keyframe-editor__marker'}
            style={{ left: `${mileageToTimelineFraction(k.mileageM, totalMileageM) * 100}%` }}
            title={`${formatKm(k.mileageM)} km`}
            onPointerDown={(e) => handleMarkerPointerDown(k.id, e)}
            onPointerMove={handleMarkerPointerMove}
            onPointerUp={handleMarkerPointerUp}
            onClick={(e) => e.stopPropagation()}
          />
        ))}
      </div>

      <div className="fly-controls__row keyframe-editor__row">
        <button type="button" className="fly-controls__chip" onClick={handleInsertHere}>
          在当前位置插入关键帧（{formatKm(currentMileageM)} km）
        </button>
        <button type="button" className="fly-controls__chip" onClick={handleDeleteSelected} disabled={!selected}>
          删除所选关键帧
        </button>
      </div>

      {selected && (
        <div className="keyframe-editor__fields">
          <label className="keyframe-editor__field">
            <span>里程 (km)</span>
            <input
              type="number"
              step={0.01}
              value={formatKm(selected.mileageM)}
              onChange={(e) => handleMileageInputChange(Number(e.target.value))}
            />
          </label>
          {CONFIG_FIELDS.map((f) => (
            <label key={f.key} className="keyframe-editor__field">
              <span>{f.label} ({f.unit})</span>
              <input
                type="number"
                step={f.step}
                min={f.min}
                max={f.max}
                value={selected[f.key]}
                onChange={(e) => handleFieldChange(f.key, Number(e.target.value))}
              />
            </label>
          ))}
        </div>
      )}

      <div className="keyframe-editor__templates">
        <label className="keyframe-editor__field keyframe-editor__field--range">
          <span>应用范围</span>
          <select value={rangeKey} onChange={(e) => setRangeKey(e.target.value)}>
            {pickableRanges.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <div className="fly-controls__group" role="group" aria-label="镜头模板">
          {CAMERA_TEMPLATES.map((t) => (
            <button key={t.id} type="button" className="fly-controls__chip" title={t.description} onClick={() => handleApplyTemplate(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
