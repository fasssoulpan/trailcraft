import { useAppStore } from '../state/appStore'
import { DEFAULT_LINE_WIDTH } from '../core/model/trackStyle'

const CRS_LABEL: Record<string, string> = { wgs84: 'WGS-84', gcj02: 'GCJ-02', bd09: 'BD-09' }

const MIN_LINE_WIDTH = 1
const MAX_LINE_WIDTH = 10

export function TrackList() {
  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const setActive = useAppStore((s) => s.setActive)
  const removeTrack = useAppStore((s) => s.removeTrack)
  const updateTrackStyle = useAppStore((s) => s.updateTrackStyle)

  if (tracks.length === 0) {
    return <p className="track-list track-list--empty">尚未导入轨迹</p>
  }

  return (
    <ul className="track-list">
      {tracks.map((t) => {
        const km = (t.points.cumDist?.[t.points.cumDist.length - 1] ?? 0) / 1000
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
            <button
              type="button"
              className="track-list__remove"
              onClick={(e) => {
                e.stopPropagation()
                removeTrack(t.id)
              }}
            >
              删除
            </button>
          </li>
        )
      })}
    </ul>
  )
}
