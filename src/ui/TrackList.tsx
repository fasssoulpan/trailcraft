import { useAppStore } from '../state/appStore'
import { DEFAULT_LINE_WIDTH } from '../core/model/trackStyle'
import { getTrackKind, resolveTrackKind, TRACK_KIND_LABEL, type TrackKind } from '../core/perf/trackKind'

const CRS_LABEL: Record<string, string> = { wgs84: 'WGS-84', gcj02: 'GCJ-02', bd09: 'BD-09' }

const TRACK_KIND_OPTIONS: TrackKind[] = ['recorded', 'planned', 'uncertain']

const MIN_LINE_WIDTH = 1
const MAX_LINE_WIDTH = 10

export function TrackList() {
  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const setActive = useAppStore((s) => s.setActive)
  const removeTrack = useAppStore((s) => s.removeTrack)
  const updateTrackStyle = useAppStore((s) => s.updateTrackStyle)
  const requestLocate = useAppStore((s) => s.requestLocate)
  const setTrackKindOverride = useAppStore((s) => s.setTrackKindOverride)

  if (tracks.length === 0) {
    return <p className="track-list track-list--empty">尚未导入轨迹</p>
  }

  return (
    <ul className="track-list">
      {tracks.map((t) => {
        const km = (t.points.cumDist?.[t.points.cumDist.length - 1] ?? 0) / 1000
        // 判别结果驱动 P2 §3.1 的界面分支(里程碑 Q1)——resolveTrackKind 在
        // 有手动覆盖时返回覆盖值,否则返回(记忆化的)自动判别结果;下拉框
        // 的"自动"选项永远显示自动判别本身会给出什么,方便用户在手动覆盖后
        // 仍能看到算法的判断、决定要不要改回去。
        const resolved = resolveTrackKind(t)
        const autoKind = getTrackKind(t).kind
        return (
          <li
            key={t.id}
            className={`track-list__item${t.id === activeTrackId ? ' track-list__item--active' : ''}`}
            onClick={() => setActive(t.id)}
          >
            <span className="track-list__name">{t.meta.name}</span>
            <span className="track-list__meta">
              {t.points.lon.length} 点 · {km.toFixed(2)} km ·{' '}
              <span className="track-list__crs-badge">{CRS_LABEL[t.originalCrs] ?? t.originalCrs}</span>
            </span>
            {/* Colour/width edits apply straight to the map (MapView re-syncs
                whenever the tracks array changes), and are also what a saved
                project round-trips (Track.meta.color/lineWidth, see
                core/model/project.ts). stopPropagation so touching a control
                doesn't also fire the <li> onClick and change which track is
                active. */}
            <span className="track-list__style-row" onClick={(e) => e.stopPropagation()}>
              <label className="track-list__style-field" title="轨迹颜色">
                <span className="track-list__style-label">颜色</span>
                <input
                  type="color"
                  value={t.meta.color ?? '#000000'}
                  onChange={(e) => updateTrackStyle(t.id, { color: e.target.value })}
                  className="track-list__color-input"
                />
              </label>
              <label className="track-list__style-field" title="线条粗细">
                <span className="track-list__style-label">粗细</span>
                <input
                  type="number"
                  min={MIN_LINE_WIDTH}
                  max={MAX_LINE_WIDTH}
                  step={0.5}
                  value={t.meta.lineWidth ?? DEFAULT_LINE_WIDTH}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    if (!Number.isFinite(v)) return
                    updateTrackStyle(t.id, { lineWidth: Math.min(MAX_LINE_WIDTH, Math.max(MIN_LINE_WIDTH, v)) })
                  }}
                  className="track-list__width-input"
                />
              </label>
            </span>
            {/* 实跑/规划/待确认判别徽章 + 手动覆盖下拉。title 放判别依据的中文
                说明(reason),用户不同意判定结果时至少能看懂为什么——见
                core/perf/trackKind.ts 的 TrackKindResult.reason 文档注释。
                uncertain 会挡住 Q3 的表现分功能,靠 --uncertain 徽章样式(见
                App.css)加粗变红,提醒用户去手动选一个。 */}
            <span
              className="track-list__kind-row"
              onClick={(e) => e.stopPropagation()}
              title={resolved.reason}
            >
              <span className={`track-list__kind-badge track-list__kind-badge--${resolved.kind}`}>
                {TRACK_KIND_LABEL[resolved.kind]}
              </span>
              <select
                className="track-list__kind-select"
                value={t.meta.kindOverride ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  setTrackKindOverride(t.id, v === '' ? undefined : (v as TrackKind))
                }}
                title="手动指定实跑/规划判别结果，选“自动”可撤销覆盖"
              >
                <option value="">自动（{TRACK_KIND_LABEL[autoKind]}）</option>
                {TRACK_KIND_OPTIONS.map((k) => (
                  <option key={k} value={k}>
                    {TRACK_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </span>
            <span className="track-list__actions" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="track-list__locate"
                title="定位到此轨迹"
                onClick={() => {
                  // Row clicks already call setActive; this button
                  // stopPropagation()s that away (see the wrapping span), so
                  // it has to set the active track itself too -- clicking
                  // 定位 on a non-active track should both jump the camera
                  // there and make it active, consistent with what clicking
                  // the row anywhere else does.
                  setActive(t.id)
                  requestLocate(t.id)
                }}
              >
                定位
              </button>
              <button
                type="button"
                className="track-list__remove"
                onClick={() => removeTrack(t.id)}
              >
                删除
              </button>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
