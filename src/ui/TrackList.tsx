import { useAppStore } from '../state/appStore'

const CRS_LABEL: Record<string, string> = { wgs84: 'WGS-84', gcj02: 'GCJ-02', bd09: 'BD-09' }

export function TrackList() {
  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const setActive = useAppStore((s) => s.setActive)
  const removeTrack = useAppStore((s) => s.removeTrack)

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
