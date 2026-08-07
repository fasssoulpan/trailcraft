import { useState } from 'react'
import { useAppStore } from '../state/appStore'
import { splitAt, joinTracks, reverseTrack, removeAnomalies, simplifyTrack } from '../core/toolbox/ops'

export function ToolboxPanel() {
  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const hover = useAppStore((s) => s.hover)
  const canUndo = useAppStore((s) => s.canUndo)
  const canRedo = useAppStore((s) => s.canRedo)
  const undoLabel = useAppStore((s) => s.undoLabel)
  const redoLabel = useAppStore((s) => s.redoLabel)
  const applyOp = useAppStore((s) => s.applyOp)
  const undo = useAppStore((s) => s.undo)
  const redo = useAppStore((s) => s.redo)

  const [maxSpeed, setMaxSpeed] = useState(10)
  const [tolerance, setTolerance] = useState(5)
  const [message, setMessage] = useState<string | undefined>()
  const [joinSelection, setJoinSelection] = useState<Set<string>>(new Set())

  const activeTrack = tracks.find((t) => t.id === activeTrackId)

  const splitIndex = hover && activeTrack && hover.trackId === activeTrackId ? hover.index : undefined
  const n = activeTrack?.points.lon.length ?? 0
  const canSplit = splitIndex !== undefined && splitIndex > 0 && splitIndex < n - 1

  // 按轨迹列表当前顺序取被勾选的轨迹(P0 不做拖拽排序,列表顺序即拼接顺序)。
  const joinTargets = tracks.filter((t) => joinSelection.has(t.id))
  const canJoin = joinTargets.length >= 2

  function toggleJoinSelection(id: string) {
    setJoinSelection((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function doSplit() {
    if (!activeTrack || splitIndex === undefined) return
    applyOp('分割', (list) => {
      const idx = list.indexOf(activeTrack)
      if (idx === -1) return list
      const [a, b] = splitAt(activeTrack, splitIndex)
      const next = [...list]
      next.splice(idx, 1, a, b)
      return next
    })
    setMessage(`分割:生成 2 条轨迹(${splitIndex} / ${n - splitIndex})`)
  }

  function doReverse() {
    if (!activeTrack) return
    applyOp('反向', (list) => {
      const idx = list.indexOf(activeTrack)
      if (idx === -1) return list
      const r = reverseTrack(activeTrack)
      const next = [...list]
      next.splice(idx, 1, r)
      return next
    })
    setMessage('已反向')
  }

  function doJoin() {
    if (!canJoin) return
    const selectedIds = new Set(joinTargets.map((t) => t.id))
    const before = joinTargets.length
    applyOp('拼接', (list) => {
      // 重新按当前 list 顺序过滤,而不是直接闭包捕获 joinTargets——
      // applyOp 传入的 list 才是即将被替换的那份状态。
      const ordered = list.filter((t) => selectedIds.has(t.id))
      if (ordered.length < 2) return list
      const joined = joinTracks(ordered)
      // 把拼接结果放在第一条被选中轨迹原来的位置,其余未选中轨迹保持相对顺序。
      const next: typeof list = []
      let inserted = false
      for (const t of list) {
        if (selectedIds.has(t.id)) {
          if (!inserted) {
            next.push(joined)
            inserted = true
          }
        } else {
          next.push(t)
        }
      }
      return next
    })
    setMessage(`拼接:${before} 条轨迹合并为 1 条`)
    setJoinSelection(new Set())
  }

  function doClean() {
    if (!activeTrack) return
    const beforeN = activeTrack.points.lon.length
    let afterN = beforeN
    applyOp('清洗异常点', (list) => {
      const idx = list.indexOf(activeTrack)
      if (idx === -1) return list
      const cleaned = removeAnomalies(activeTrack, { maxSpeed })
      afterN = cleaned.points.lon.length
      const next = [...list]
      next.splice(idx, 1, cleaned)
      return next
    })
    setMessage(`清洗:移除 ${beforeN - afterN} 点`)
  }

  function doSimplify() {
    if (!activeTrack) return
    const beforeN = activeTrack.points.lon.length
    let afterN = beforeN
    applyOp('抽稀', (list) => {
      const idx = list.indexOf(activeTrack)
      if (idx === -1) return list
      const simplified = simplifyTrack(activeTrack, tolerance)
      afterN = simplified.points.lon.length
      const next = [...list]
      next.splice(idx, 1, simplified)
      return next
    })
    setMessage(`抽稀:${beforeN} → ${afterN} 点`)
  }

  return (
    <div className="toolbox-panel">
      <h3 className="toolbox-panel__title">工具箱</h3>

      <div className="toolbox-panel__row toolbox-panel__row--history">
        <button
          type="button"
          disabled={!canUndo}
          onClick={() => undo()}
          title={undoLabel ? `撤销:${undoLabel}` : undefined}
        >
          撤销
        </button>
        <button
          type="button"
          disabled={!canRedo}
          onClick={() => redo()}
          title={redoLabel ? `重做:${redoLabel}` : undefined}
        >
          重做
        </button>
      </div>

      {!activeTrack && <p className="toolbox-panel__hint">请先在轨迹列表中选择一条轨迹</p>}

      <div className="toolbox-panel__row">
        <button type="button" disabled={!canSplit} onClick={doSplit}>
          在悬停点分割
        </button>
        {activeTrack && !canSplit && (
          <p className="toolbox-panel__hint">将鼠标悬停在当前轨迹的中间点上以启用</p>
        )}
      </div>

      <div className="toolbox-panel__row">
        <button type="button" disabled={!activeTrack} onClick={doReverse}>
          反向
        </button>
      </div>

      <div className="toolbox-panel__row toolbox-panel__row--join">
        <span className="toolbox-panel__field-label">拼接选中(勾选 2 条及以上)</span>
        {tracks.length < 2 && <p className="toolbox-panel__hint">至少需要 2 条轨迹才能拼接</p>}
        {tracks.length >= 2 && (
          <ul className="toolbox-panel__join-list">
            {tracks.map((t) => (
              <li key={t.id} className="toolbox-panel__join-item">
                <label>
                  <input
                    type="checkbox"
                    checked={joinSelection.has(t.id)}
                    onChange={() => toggleJoinSelection(t.id)}
                  />
                  {t.meta.name}
                </label>
              </li>
            ))}
          </ul>
        )}
        <button type="button" disabled={!canJoin} onClick={doJoin}>
          拼接选中
        </button>
        <p className="toolbox-panel__hint">按轨迹列表中的当前顺序拼接(暂不支持手动排序)</p>
      </div>

      <div className="toolbox-panel__row">
        <label className="toolbox-panel__field">
          最大速度 (m/s)
          <input
            type="number"
            min={0}
            step={0.5}
            value={maxSpeed}
            onChange={(e) => setMaxSpeed(Number(e.target.value))}
          />
        </label>
        <button type="button" disabled={!activeTrack} onClick={doClean}>
          清洗异常点
        </button>
      </div>

      <div className="toolbox-panel__row">
        <label className="toolbox-panel__field">
          抽稀容差 (m)
          <input
            type="number"
            min={0}
            step={0.5}
            value={tolerance}
            onChange={(e) => setTolerance(Number(e.target.value))}
          />
        </label>
        <button type="button" disabled={!activeTrack} onClick={doSimplify}>
          抽稀
        </button>
      </div>

      {message && <p className="toolbox-panel__message">{message}</p>}
    </div>
  )
}
