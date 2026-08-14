import type { CameraMode, FlythroughProgressInfo } from '../cesium/flythrough'
import {
  EXPORT_RESOLUTIONS,
  EXPORT_ASPECT_RATIO_ORDER,
  EXPORT_ASPECT_RATIO_LABELS,
  resolutionKeysForRatio,
  type ExportProgressInfo,
  type ExportMode,
  type ExportResolutionKey,
  type ExportAspectRatioKey,
} from '../cesium/exportResolutions'
import { useAppStore } from '../state/appStore'

// Only ever referenced as a type here -- erased entirely at compile time,
// so importing it does NOT create a static value import of 'cesium'
// (FlyControls.tsx IS statically imported by FlyView.tsx, unlike the
// Cesium-touching modules themselves; see FlyView.tsx's own
// TrackEntitiesModule/CpEntitiesModule comment for the same pattern).

// Shared with the engine so the ladder and its clamp cannot diverge -- see
// speedOptions.ts. (Cesium-free module, so this import does not drag the 3D
// engine into the main bundle.)
import { SPEED_OPTIONS } from '../cesium/speedOptions'

/** "1小时02分" / "4分30秒" / "45秒" -- estimated wall-clock playback time. */
function formatPlaybackDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.round(seconds)}秒`
  const totalMin = Math.round(seconds / 60)
  if (totalMin < 60) {
    const s = Math.round(seconds % 60)
    return s > 0 && totalMin < 10 ? `${Math.floor(seconds / 60)}分${s}秒` : `${totalMin}分`
  }
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m > 0 ? `${h}小时${m}分` : `${h}小时`
}

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
  /** Video export (P1 §2.1 交付物 8 milestone N5; deterministic pipeline P2
   * §3.4 milestone Q4) -- state/handlers all owned by `FlyView.tsx` (it
   * holds the `viewer`/`engine`/`track` an export is tied to), forwarded
   * here the same way playback's own `progress`/`onTogglePlay`/`onSeek`
   * are. `undefined` whenever no export is currently running. */
  exportProgress?: ExportProgressInfo
  /** Which pipeline actually ran, once `frameExport.ts`'s async capability
   * probe resolves -- `undefined` until then (or before any export has ever
   * been started). See `PHASE_LABEL`/the record-row hint below for how this
   * drives the honest-labelling requirement. */
  exportMode?: ExportMode
  /** Short human-readable detail for `exportMode` (e.g. "H.264 MP4 · 4K ·
   * 30fps", or the fallback's reason for not using WebCodecs). */
  exportModeDetail?: string
  /** Set when starting or running the export failed -- cleared automatically
   * on the next successful start. */
  exportError?: string
  exportResolutionKey: ExportResolutionKey
  onExportResolutionChange: (key: ExportResolutionKey) => void
  onStartExport: () => void
  onCancelExport: () => void
}

function formatKm(mileageM: number): string {
  return (mileageM / 1000).toFixed(2)
}

const EXPORT_PHASE_LABEL: Record<ExportProgressInfo['phase'], string> = {
  probing: '正在检测编码能力…',
  prefetching: '预取瓦片中',
  rendering: '渲染帧',
  credits: '生成署名片尾',
  finalizing: '正在合成 MP4…',
  saving: '正在保存…',
  idle: '',
}

/** "预取瓦片中 12/48" / "渲染帧 342/18000" / "生成署名片尾 45/90" -- the
 * phases that carry a meaningful `index`/`total`; the others are a fixed
 * label with no counter (`total` is reported as `0` for those, see
 * `frameExport.ts`). */
/** The phases that report a meaningful `index`/`total`. Single source of
 * truth for both the counter in the text label and the progress-bar element
 * below -- keeping two separate inline conditions in step failed once. */
const COUNTED_EXPORT_PHASES: ReadonlySet<ExportProgressInfo['phase']> = new Set([
  'prefetching',
  'rendering',
  'credits',
])

function formatExportPhase(info: ExportProgressInfo): string {
  const label = EXPORT_PHASE_LABEL[info.phase]
  if (info.total > 0 && COUNTED_EXPORT_PHASES.has(info.phase)) {
    return `${label} ${info.index}/${info.total}`
  }
  return label
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
  exportProgress,
  exportMode,
  exportModeDetail,
  exportError,
  exportResolutionKey,
  onExportResolutionChange,
  onStartExport,
  onCancelExport,
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

  // A ratio selector alongside the existing resolution choice (rather than
  // eight flat resolution buttons) -- both derived from the single
  // `exportResolutionKey` prop so FlyView.tsx still only has one export
  // setting to hold state for. See `EXPORT_RESOLUTIONS`'s own doc comment
  // for why 16:9 is the only ratio with more than one resolution.
  const exportRatio: ExportAspectRatioKey = EXPORT_RESOLUTIONS[exportResolutionKey].ratio
  const ratioResolutionKeys = resolutionKeysForRatio(exportRatio)

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
          <span className="fly-controls__eta">
            全程约 {formatPlaybackDuration((progress?.baseDurationSeconds ?? 0) / speed)}
          </span>
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
        <div className="fly-controls__group" role="group" aria-label="导出画幅">
          {EXPORT_ASPECT_RATIO_ORDER.map((ratio) => (
            <button
              key={ratio}
              type="button"
              className={ratio === exportRatio ? 'fly-controls__chip fly-controls__chip--active' : 'fly-controls__chip'}
              disabled={exportProgress !== undefined}
              onClick={() => onExportResolutionChange(resolutionKeysForRatio(ratio)[0])}
            >
              {EXPORT_ASPECT_RATIO_LABELS[ratio]}
            </button>
          ))}
        </div>
        {/* Only shown when the current ratio actually offers a choice (only
            16:9 does, 1080p/4K carried over from Q4) -- the other three
            ratios have exactly one resolution each, so a row with a single,
            permanently-active chip would just be noise. */}
        {ratioResolutionKeys.length > 1 && (
          <div className="fly-controls__group" role="group" aria-label="导出分辨率">
            {ratioResolutionKeys.map((key) => (
              <button
                key={key}
                type="button"
                className={key === exportResolutionKey ? 'fly-controls__chip fly-controls__chip--active' : 'fly-controls__chip'}
                disabled={exportProgress !== undefined}
                onClick={() => onExportResolutionChange(key)}
              >
                {EXPORT_RESOLUTIONS[key].label}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className={exportProgress !== undefined ? 'fly-controls__chip fly-controls__chip--active' : 'fly-controls__chip'}
          onClick={exportProgress !== undefined ? onCancelExport : onStartExport}
        >
          {exportProgress !== undefined ? '取消导出' : '导出视频'}
        </button>
      </div>
      {/* 诚实标注 (P2 §3.4): 确定性渲染管线运行时标注为确定性 MP4 导出；
          若 WebCodecs 不可用而降级为 P1 的实时 MediaRecorder 录屏，则必须
          继续显示"预览级"，不得把降级结果误标为确定性成片 -- 这行文字必须
          一直可见，不只是导出中才出现，用户不应该把上一次的结果误认成当前
          将要发生的事。 */}
      <p className="fly-controls__record-hint">
        {exportProgress !== undefined
          ? formatExportPhase(exportProgress)
          : exportMode === 'deterministic'
            ? `确定性逐帧渲染 · ${exportModeDetail}`
            : exportMode === 'fallback'
              ? `预览级实时录屏（WebCodecs 不可用：${exportModeDetail}）`
              : '支持确定性 H.264 MP4 导出（1080p / 4K）；浏览器不支持 WebCodecs 时自动降级为预览级实时录屏'}
      </p>
      {/* Keep this phase list in step with `formatExportPhase` above -- they
       * drifted once already: 'credits' was added to the text label but not
       * here, so the bar vanished for the whole credits tail. */}
      {exportProgress !== undefined && COUNTED_EXPORT_PHASES.has(exportProgress.phase) && exportProgress.total > 0 && (
        <div className="fly-controls__export-progress" role="progressbar" aria-valuemin={0} aria-valuemax={exportProgress.total} aria-valuenow={exportProgress.index}>
          <div
            className="fly-controls__export-progress-bar"
            style={{ width: `${Math.min(100, (exportProgress.index / exportProgress.total) * 100)}%` }}
          />
        </div>
      )}
      {exportError && <p className="fly-controls__hint fly-controls__hint--error">{exportError}</p>}

      {syntheticTimeline && (
        <p className="fly-controls__hint">该轨迹没有记录的时间戳，巡游时长为按里程估算，非实际用时</p>
      )}
    </div>
  )
}
