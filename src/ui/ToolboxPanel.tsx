import { useEffect, useState } from 'react'
import { useAppStore } from '../state/appStore'
import { splitAt, joinTracks, reverseTrack, removeAnomalies, simplifyTrack } from '../core/toolbox/ops'
import { checkDensifyBudget, totalVertexDistance } from '../core/toolbox/draw'
import { formatKm } from './perfFormat'
import { drawAvailableForMode } from './layerAvailability'
import type { TerrainSource } from '../cesium/terrainSelection'
import { Section } from './primitives/Section'
import { Field } from './primitives/Field'
import { Button } from './primitives/Button'

type ElevationStatus = 'idle' | 'loading' | 'done' | 'error'

const TERRAIN_SOURCE_LABEL: Record<TerrainSource, string> = {
  maptiler: 'MapTiler 地形',
  esri: 'Esri WorldElevation3D（约 30m 分辨率全球 DEM）',
  ellipsoid: '无地形数据',
}

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
  const mode = useAppStore((s) => s.mode)
  const drawMode = useAppStore((s) => s.drawMode)
  const drawVertices = useAppStore((s) => s.drawVertices)
  const drawCursor = useAppStore((s) => s.drawCursor)
  const setDrawMode = useAppStore((s) => s.setDrawMode)
  const deleteDrawVertex = useAppStore((s) => s.deleteDrawVertex)
  const cancelDraw = useAppStore((s) => s.cancelDraw)
  const finishDraw = useAppStore((s) => s.finishDraw)
  const setTrackElevation = useAppStore((s) => s.setTrackElevation)

  const [maxSpeed, setMaxSpeed] = useState(10)
  const [tolerance, setTolerance] = useState(5)
  const [message, setMessage] = useState<string | undefined>()
  const [joinSelection, setJoinSelection] = useState<Set<string>>(new Set())
  const [elevationStatus, setElevationStatus] = useState<ElevationStatus>('idle')
  const [elevationMessage, setElevationMessage] = useState<string | undefined>()

  const activeTrack = tracks.find((t) => t.id === activeTrackId)

  // A stale "已为 380/400 个点写入高程" message from a previous track must
  // not linger once the user switches to a different one -- it would read
  // as if it described the newly-selected track.
  useEffect(() => {
    setElevationStatus('idle')
    setElevationMessage(undefined)
  }, [activeTrackId])

  async function doSampleElevation() {
    if (!activeTrack) return
    const trackId = activeTrack.id
    setElevationStatus('loading')
    setElevationMessage(undefined)
    try {
      // Dynamic import: this is the one place in ToolboxPanel that reaches
      // into Cesium (via cesium/terrainSample.ts), and only once the user
      // actually clicks the button -- see that module's own file comment
      // for why this boundary matters (Cesium must never enter the main
      // bundle just because this button exists).
      const { sampleTrackElevation } = await import('../cesium/terrainSample')
      const outcome = await sampleTrackElevation(activeTrack)
      if (outcome.error) {
        setElevationStatus('error')
        setElevationMessage(outcome.error)
        return
      }
      const result = setTrackElevation(trackId, outcome.heights)
      if (!result || result.sampledCount === 0) {
        setElevationStatus('error')
        setElevationMessage('地形服务未返回任何有效高程数据，轨迹保持不带高程')
        return
      }
      setElevationStatus('done')
      const sourceLabel = outcome.source ? TERRAIN_SOURCE_LABEL[outcome.source] : '地形服务'
      const disclaimer = `来自 ${sourceLabel}，供规划参考，非设备实测气压高程`
      setElevationMessage(
        result.failedCount > 0
          ? `已为 ${result.sampledCount}/${result.sampledCount + result.failedCount} 个点写入高程（${result.failedCount} 个点采样失败）；${disclaimer}`
          : `已为全部 ${result.sampledCount} 个点写入高程；${disclaimer}`,
      )
    } catch (err) {
      setElevationStatus('error')
      setElevationMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const splitIndex = hover && activeTrack && hover.trackId === activeTrackId ? hover.index : undefined
  const n = activeTrack?.points.lon.length ?? 0
  const canSplit = splitIndex !== undefined && splitIndex > 0 && splitIndex < n - 1

  // 按轨迹列表当前顺序取被勾选的轨迹(P0 不做拖拽排序,列表顺序即拼接顺序)。
  const joinTargets = tracks.filter((t) => joinSelection.has(t.id))
  const canJoin = joinTargets.length >= 2

  // 手绘路线仅在规划模式可用(见 layerAvailability.ts#drawAvailableForMode
  // 的文档注释:巡游模式的三维视图没有对应的点击落点交互)。实时里程读数把
  // 已提交的顶点加上鼠标当前悬停位置(若有)一起算,这样即使还没点下下一个
  // 顶点,拖动鼠标时读数也是"实时"的——和地图上橡皮筋线段显示的是同一段
  // 距离。
  const drawAvailability = drawAvailableForMode(mode)
  const drawDistanceM = totalVertexDistance(drawCursor ? [...drawVertices, drawCursor] : drawVertices)
  // Defect 3 (代码审查): densifying a route whose vertices are spread across
  // thousands of km (easy to do by accident -- the default view is zoom 3,
  // roughly all of China, see MapView.tsx's DEFAULT_ZOOM) would synthesise
  // enough points to freeze the tab. Checked on every render (cheap --
  // checkDensifyBudget is O(vertex count), not O(output points)) so the
  // "完成" button disables itself, and the reason is shown, the moment a
  // drag/click pushes the draft over budget -- never a silent truncation
  // into a shorter route than the user actually drew.
  const drawBudget = checkDensifyBudget(drawVertices)
  const canFinishDraw = drawVertices.length >= 2 && drawBudget.ok

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
    <Section
      title="工具箱"
      description="编辑当前轨迹：手绘新路线、分割/反向/拼接已有轨迹、补全高程、清洗异常点或抽稀。"
    >
      <div className="toolbox-panel__row toolbox-panel__row--history">
        <Button disabled={!canUndo} onClick={() => undo()} title={undoLabel ? `撤销:${undoLabel}` : undefined}>
          撤销
        </Button>
        <Button disabled={!canRedo} onClick={() => redo()} title={redoLabel ? `重做:${redoLabel}` : undefined}>
          重做
        </Button>
      </div>

      <div className="toolbox-panel__row toolbox-panel__row--draw">
        <span className="toolbox-panel__field-label">手绘路线</span>
        {/* `!drawMode` gates the hint/start-button pair, NOT `drawAvailability.available`
         * alone -- if the user switches into 巡游模式 mid-draw (App.tsx keeps
         * MapView mounted only in 规划模式, but the draft itself lives in
         * appStore and survives the switch), they still need a working
         * "完成"/"取消" escape hatch here even though starting a NEW draw is
         * unavailable right now. Without this split, switching to 巡游模式
         * mid-draw would strand the draft with no visible way to finish or
         * discard it. */}
        {!drawMode && !drawAvailability.available && <p className="toolbox-panel__hint">{drawAvailability.hint}</p>}
        {!drawMode && drawAvailability.available && <Button onClick={() => setDrawMode(true)}>开始手绘</Button>}
        {drawMode && (
          <>
            <p className="toolbox-panel__hint">
              在地图上点击加点、拖动已有点可移动、右键点击可删除；双击或点击「完成」结束
            </p>
            <p className="toolbox-panel__draw-readout tabular-nums">
              {drawVertices.length} 个顶点 · {formatKm(drawDistanceM)}
            </p>
            {!drawBudget.ok && (
              <p className="toolbox-panel__draw-warning">
                路线过长，稠密化后将生成 {drawBudget.estimatedPoints.toLocaleString('zh-CN')} 个点，超过上限{' '}
                {drawBudget.maxPoints.toLocaleString('zh-CN')} 个，暂无法完成——请删除最后几个点或重新绘制更短的路线
              </p>
            )}
            <div className="toolbox-panel__row">
              <Button
                variant="ghost"
                disabled={drawVertices.length === 0}
                onClick={() => deleteDrawVertex(drawVertices.length - 1)}
              >
                删除最后一点
              </Button>
              <Button variant="primary" disabled={!canFinishDraw} onClick={() => finishDraw()}>
                完成
              </Button>
              <Button variant="ghost" onClick={() => cancelDraw()}>
                取消
              </Button>
            </div>
          </>
        )}
      </div>

      {activeTrack && activeTrack.points.ele === undefined && (
        <div className="toolbox-panel__row">
          <span className="toolbox-panel__field-label">高程补全</span>
          <p className="toolbox-panel__hint">
            当前轨迹没有高程数据（手绘/规划路线的常见情况）。补全高程会从 Esri 约 30m 分辨率的全球
            DEM 查询每个点的地面高度，供规划参考——不等同于设备实测的气压高程。
          </p>
          <Button disabled={elevationStatus === 'loading'} onClick={() => void doSampleElevation()}>
            {elevationStatus === 'loading' ? '正在查询地形…' : '补全高程'}
          </Button>
          {elevationMessage && <p className="toolbox-panel__hint">{elevationMessage}</p>}
        </div>
      )}

      {!activeTrack && <p className="toolbox-panel__hint">请先在轨迹列表中选择一条轨迹</p>}

      <div className="toolbox-panel__row">
        <Button disabled={!canSplit} onClick={doSplit}>
          在悬停点分割
        </Button>
        {activeTrack && !canSplit && (
          <p className="toolbox-panel__hint">将鼠标悬停在当前轨迹的中间点上以启用</p>
        )}
      </div>

      <div className="toolbox-panel__row">
        <Button disabled={!activeTrack} onClick={doReverse}>
          反向
        </Button>
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
        <Button disabled={!canJoin} onClick={doJoin}>
          拼接选中
        </Button>
        <p className="toolbox-panel__hint">按轨迹列表中的当前顺序拼接(暂不支持手动排序)</p>
      </div>

      <div className="toolbox-panel__row">
        <Field label="最大速度 (m/s)" inline>
          <input
            type="number"
            min={0}
            step={0.5}
            value={maxSpeed}
            onChange={(e) => setMaxSpeed(Number(e.target.value))}
          />
        </Field>
        <Button disabled={!activeTrack} onClick={doClean}>
          清洗异常点
        </Button>
      </div>

      <div className="toolbox-panel__row">
        <Field label="抽稀容差 (m)" inline>
          <input
            type="number"
            min={0}
            step={0.5}
            value={tolerance}
            onChange={(e) => setTolerance(Number(e.target.value))}
          />
        </Field>
        <Button disabled={!activeTrack} onClick={doSimplify}>
          抽稀
        </Button>
      </div>

      {message && <p className="toolbox-panel__message">{message}</p>}
    </Section>
  )
}
