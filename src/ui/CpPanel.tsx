import { useAppStore } from '../state/appStore'
import { CP_KIND_LABELS, type CpKind } from '../core/model/checkpoint'

/** ± 按钮每次挪动锚点的全精度轨迹点数;够小以便精细纠偏,又不至于点半天挪不动。 */
const ANCHOR_NUDGE_STEP = 5

/**
 * datetime-local 输入控件给的是不带时区的"墙上时间"字符串(如 "2026-08-07T14:00"),
 * 而 CheckPoint.cutoffTime 按约定必须是带显式时区偏移的 ISO 8601(见
 * core/model/checkpoint.ts 的注释)——赛事关门时间是要在不同时区的选手/组委会
 * 之间对照的,裸的本地时间字符串一旦离开产生它的那台设备就是歧义的。
 *
 * 这里的约定是:用"当前浏览器此刻的时区偏移"来补全这个字符串。也就是说,
 * 用户在界面上输入的永远是"当地墙上时间",转换时假定这台设备当前所在的
 * 时区就是用户想表达的时区。只要编辑始终发生在同一时区(赛事组委会通常
 * 就在赛道所在时区操作),来回编辑能精确回填同一个值;跨时区编辑同一个
 * CP(比如先在国内定好时间,出国后再打开同一个项目)才会看到偏移随之变化——
 * 这是该约定下的已知局限,不是 bug。
 */
function isoToLocalInputValue(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function localInputValueToIso(value: string): string | undefined {
  if (!value) return undefined
  const [datePart, timePart] = value.split('T')
  if (!datePart || !timePart) return undefined
  const [y, mo, d] = datePart.split('-').map(Number)
  const [h, mi] = timePart.split(':').map(Number)
  if ([y, mo, d, h, mi].some((n) => Number.isNaN(n))) return undefined

  const local = new Date(y, mo - 1, d, h, mi, 0, 0)
  // getTimezoneOffset() 是"要加多少分钟才能从本地时间得到 UTC",符号和常见的
  // "东八区 = +08:00" 直觉相反,取负号才是通常书写 ISO 偏移量时的符号。
  const offsetMin = -local.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const pad = (n: number) => String(n).padStart(2, '0')
  const offH = pad(Math.floor(abs / 60))
  const offM = pad(abs % 60)
  return `${datePart}T${pad(h)}:${pad(mi)}:00${sign}${offH}:${offM}`
}

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
