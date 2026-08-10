import type { CameraMode, FlythroughProgressInfo } from '../cesium/flythrough'
import { useAppStore } from '../state/appStore'

// Only ever referenced as a type here -- erased entirely at compile time,
// so importing it does NOT create a static value import of 'cesium'
// (FlyControls.tsx IS statically imported by FlyView.tsx, unlike the
// Cesium-touching modules themselves; see FlyView.tsx's own
// TrackEntitiesModule/CpEntitiesModule comment for the same pattern).

const SPEED_OPTIONS = [1, 2, 5, 10, 20]

const CAMERA_MODE_OPTIONS: Array<{ mode: CameraMode; label: string }> = [
  { mode: 'follow', label: '跟随' },
  { mode: 'orbit', label: '俯瞰' },
  { mode: 'free', label: '自由' },
]

export interface FlyControlsProps {
  hasActiveTrack: boolean
  /** True when the active track had no recorded timestamps and
   * `trackGeometry.ts#synthesizeTimeline` had to invent one -- see
   * `FlythroughEngine.syntheticTimeline`'s doc comment. */
  syntheticTimeline: boolean
  /** Latest telemetry from the `FlythroughEngine`'s `onProgress` callback,
   * as forwarded by `FlyView.tsx`. `undefined` before the engine has
   * produced its first frame (or when there is no active track at all). */
  progress?: FlythroughProgressInfo
  onTogglePlay: () => void
  onSeek: (progress: number) => void
}

function formatKm(mileageM: number): string {
  return (mileageM / 1000).toFixed(2)
}

/**
 * Playback controls for the flythrough camera (P1 §3.3, N3 commit 3).
 * Rendered inside `FlyView.tsx`, as an overlay bar over the 3D viewport
 * (mirrors that file's own `fly-view__badge` dark-chrome styling, since
 * that's the surface this sits on -- see `App.css`'s `.fly-controls`
 * rules) while following `ToolboxPanel.tsx`/`ProjectToolbar.tsx`'s
 * button/hint idiom for the controls themselves.
 *
 * Speed and camera mode are read from/written to `appStore` directly
 * (same "pure UI setting" pattern as `ToolboxPanel`'s history buttons
 * reading `canUndo`/`canRedo` straight from the store) -- only the
 * high-frequency playback telemetry and the two engine-driving actions
 * (toggle play, seek) come in as props, since that data lives outside
 * Zustand entirely (see `appStore.ts`'s `flythroughSpeed` doc comment).
 */
export function FlyControls({ hasActiveTrack, syntheticTimeline, progress, onTogglePlay, onSeek }: FlyControlsProps) {
  const speed = useAppStore((s) => s.flythroughSpeed)
  const setSpeed = useAppStore((s) => s.setFlythroughSpeed)
  const cameraMode = useAppStore((s) => s.flythroughCameraMode)
  const setCameraMode = useAppStore((s) => s.setFlythroughCameraMode)

  if (!hasActiveTrack) {
    return (
      <div className="fly-controls fly-controls--disabled" role="status">
        <p className="fly-controls__hint">请先在轨迹列表中选择一条轨迹以开始巡游</p>
      </div>
    )
  }

  const isPlaying = progress?.isPlaying ?? false
  const progressValue = progress?.progress ?? 0
  const mileageM = progress?.mileageM ?? 0

  return (
    <div className="fly-controls">
      <div className="fly-controls__row fly-controls__row--transport">
        <button type="button" className="fly-controls__play" onClick={onTogglePlay}>
          {isPlaying ? '暂停' : '播放'}
        </button>
        <input
          type="range"
          className="fly-controls__scrubber"
          min={0}
          max={1000}
          step={1}
          value={Math.round(progressValue * 1000)}
          onChange={(e) => onSeek(Number(e.target.value) / 1000)}
          aria-label="巡游进度"
        />
        <span className="fly-controls__mileage">{formatKm(mileageM)} km</span>
      </div>

      <div className="fly-controls__row fly-controls__row--options">
        <div className="fly-controls__group" role="group" aria-label="播放倍速">
          {SPEED_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              className={s === speed ? 'fly-controls__chip fly-controls__chip--active' : 'fly-controls__chip'}
              onClick={() => setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>

        <div className="fly-controls__group" role="group" aria-label="相机模式">
          {CAMERA_MODE_OPTIONS.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              className={mode === cameraMode ? 'fly-controls__chip fly-controls__chip--active' : 'fly-controls__chip'}
              onClick={() => setCameraMode(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {syntheticTimeline && (
        <p className="fly-controls__hint">该轨迹没有记录的时间戳，巡游时长为按里程估算，非实际用时</p>
      )}
    </div>
  )
}
