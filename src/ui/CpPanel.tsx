import { useAppStore } from '../state/appStore'
import { CP_KIND_LABELS, type CpKind } from '../core/model/checkpoint'
import { isoToLocalInputValue, localInputValueToIso } from '../core/util/localTime'

/** ± 按钮每次挪动锚点的全精度轨迹点数;够小以便精细纠偏,又不至于点半天挪不动。 */
const ANCHOR_NUDGE_STEP = 5

// datetime-local <-> ISO 8601(含时区)的转换约定见 core/util/localTime.ts 顶部
// 注释;PacePanel.tsx 的起跑时间输入复用同一份实现。

export function CpPanel() {
  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const cps = useAppStore((s) => s.cps)
  const updateCp = useAppStore((s) => s.updateCp)
  const removeCp = useAppStore((s) => s.removeCp)
  const reorderCp = useAppStore((s) => s.reorderCp)

  const activeTrack = tracks.find((t) => t.id === activeTrackId)

  function nudge(cp: (typeof cps)[number], delta: number) {
    if (!activeTrack) return
    const n = activeTrack.points.lon.length
    const next = Math.min(n - 1, Math.max(0, cp.anchorIndex + delta))
    if (next === cp.anchorIndex) return
    updateCp(cp.id, { anchorIndex: next })
  }

  return (
    <div className="cp-panel">
      <h3 className="cp-panel__title">CP 检查点</h3>

      {cps.length === 0 && <p className="cp-panel__hint">在地图上点击轨迹附近位置以添加 CP</p>}
      {!activeTrack && cps.length > 0 && (
        <p className="cp-panel__hint">未选中轨迹,里程/海拔暂无法计算</p>
      )}

      {cps.length > 0 && (
        <ul className="cp-panel__list">
          {cps.map((cp, i) => {
            const km = activeTrack?.points.cumDist ? activeTrack.points.cumDist[cp.anchorIndex] / 1000 : undefined
            const ele = activeTrack?.points.ele ? activeTrack.points.ele[cp.anchorIndex] : undefined
            const n = activeTrack?.points.lon.length ?? 0

            return (
              <li key={cp.id} className="cp-panel__item">
                <div className="cp-panel__row">
                  <span className="cp-panel__ordinal">{i + 1}</span>
                  <input
                    type="text"
                    className="cp-panel__name"
                    value={cp.name}
                    onChange={(e) => updateCp(cp.id, { name: e.target.value })}
                  />
                  <select
                    value={cp.kind}
                    onChange={(e) => updateCp(cp.id, { kind: e.target.value as CpKind })}
                  >
                    {(Object.keys(CP_KIND_LABELS) as CpKind[]).map((k) => (
                      <option key={k} value={k}>
                        {CP_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="cp-panel__row cp-panel__row--meta">
                  <span>{km !== undefined ? `${km.toFixed(2)} km` : '-- km'}</span>
                  <span>{ele !== undefined && !Number.isNaN(ele) ? `${ele.toFixed(0)} m` : '-- m'}</span>
                  <span className="cp-panel__anchor-index">点 #{cp.anchorIndex}</span>
                </div>

                <div className="cp-panel__row">
                  <label className="cp-panel__field">
                    关门时间
                    <input
                      type="datetime-local"
                      value={isoToLocalInputValue(cp.cutoffTime)}
                      onChange={(e) => updateCp(cp.id, { cutoffTime: localInputValueToIso(e.target.value) })}
                    />
                  </label>
                </div>

                <div className="cp-panel__row cp-panel__row--actions">
                  <button
                    type="button"
                    disabled={!activeTrack || cp.anchorIndex <= 0}
                    onClick={() => nudge(cp, -ANCHOR_NUDGE_STEP)}
                    title="锚点前移"
                  >
                    锚点 −
                  </button>
                  <button
                    type="button"
                    disabled={!activeTrack || cp.anchorIndex >= n - 1}
                    onClick={() => nudge(cp, ANCHOR_NUDGE_STEP)}
                    title="锚点后移"
                  >
                    锚点 ＋
                  </button>
                  <button type="button" disabled={i === 0} onClick={() => reorderCp(cp.id, -1)}>
                    上移
                  </button>
                  <button type="button" disabled={i === cps.length - 1} onClick={() => reorderCp(cp.id, 1)}>
                    下移
                  </button>
                  <button type="button" className="cp-panel__remove" onClick={() => removeCp(cp.id)}>
                    删除
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
