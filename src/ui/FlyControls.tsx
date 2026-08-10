import type { CameraMode, FlythroughProgressInfo } from '../cesium/flythrough'
import type { RecorderStatus } from '../cesium/recorder'
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
  /** Video recording (P1 §2.1 交付物 8, milestone N5) -- state/handlers all
   * owned by `FlyView.tsx` (it holds the `viewer`/`engine`/`track` a
   * recording is tied to), forwarded here the same way playback's own
   * `progress`/`onTogglePlay`/`onSeek` are. */
  recordingStatus: RecorderStatus
  /** The codec `MediaRecorder.isTypeSupported` picked (VP9 > VP8 > generic
   * webm) -- `undefined` until a recording has actually started once. */
  recordingCodec?: string
  /** Set when starting failed (unsupported browser, no 2D canvas context,
   * ...) -- cleared automatically on the next successful start. */
  recordingError?: string
  onStartRecording: () => void
  onStopRecording: () => void
}

function formatKm(mileageM: number): string {
  return (mileageM / 1000).toFixed(2)
}

/** Short display name for the codec `recorder.ts#pickMimeType` chose --
 * mirrors the brief's "report which codec was chosen" without the UI having
 * to know the exact mime-type string syntax. */
function codecLabel(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined
  if (mimeType.includes('vp9')) return 'VP9'
  if (mimeType.includes('vp8')) return 'VP8'
  return 'WebM'
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
export function FlyControls({
  hasActiveTrack,
  syntheticTimeline,
  progress,
  onTogglePlay,
  onSeek,
  recordingStatus,
  recordingCodec,
  recordingError,
  onStartRecording,
  onStopRecording,
}: FlyControlsProps) {
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

      <div className="fly-controls__row fly-controls__row--record">
        <button
          type="button"
          className={
            recordingStatus === 'recording' ? 'fly-controls__chip fly-controls__chip--active' : 'fly-controls__chip'
          }
          disabled={recordingStatus === 'saving'}
          onClick={recordingStatus === 'recording' ? onStopRecording : onStartRecording}
        >
          {recordingStatus === 'recording' ? '停止录制' : recordingStatus === 'saving' ? '生成中…' : '录制视频'}
        </button>
        {/* 预览级标注 (P1 §1.4/R4): 实时 MediaRecorder 录屏会丢帧且分辨率受限,
            与 P2 的确定性逐帧渲染管线不是同一质量水平 -- 这行文字必须一直可见,
            不只是录制中才出现,用户不应该把这次录制误当作最终画质上限。 */}
        <span className="fly-controls__record-hint">
          预览级 1080p 实时录屏
          {recordingStatus === 'recording' && '（录制中…）'}
          {recordingStatus === 'saving' && '（正在生成视频…）'}
          {recordingStatus === 'idle' && recordingCodec && `（上次编码：${codecLabel(recordingCodec)}）`}
        </span>
      </div>
      {recordingError && <p className="fly-controls__hint fly-controls__hint--error">{recordingError}</p>}

      {syntheticTimeline && (
        <p className="fly-controls__hint">该轨迹没有记录的时间戳，巡游时长为按里程估算，非实际用时</p>
      )}
    </div>
  )
}
