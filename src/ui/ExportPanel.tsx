import { useState } from 'react'
import { useAppStore } from '../state/appStore'
import { triggerBlobDownload, sanitizeFilenameStem } from '../cesium/triggerBlobDownload'
import { buildElevationProfileSvg, renderElevationProfilePng } from '../core/export/profileGraphic'
import { buildRouteBookData } from '../core/export/routeBookData'
import { buildWorkbookModel, generateRouteBookWorkbook } from '../core/export/excelRouteBook'
import {
  buildPaceCardSvgPages, DEFAULT_PACE_CARD_COLUMNS, PACE_CARD_COLUMN_ORDER, PACE_CARD_COLUMN_LABELS,
  type PaceCardColumnKey,
} from '../core/export/paceCard'

/**
 * P3-R1 路书导出套件的单一入口:高差图 SVG/PNG、Excel 路书、配速卡都在这
 * 一个面板里——方案要求"控件集中在一处",不分散到 ProjectToolbar/PacePanel
 * 各自加一个按钮。
 *
 * 每个导出函数(`profileGraphic.ts`/`routeBookData.ts`/`excelRouteBook.ts`/
 * `paceCard.ts`)在数据缺失时都会抛出中文错误——这里统一 try/catch 成
 * `message` 展示,不在这个组件里重新判断"轨迹有没有海拔/CP"这类业务规则
 * (那样又会和已经抛错的那份判断逻辑分叉)。
 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function ExportPanel() {
  const tracks = useAppStore((s) => s.tracks)
  const activeTrackId = useAppStore((s) => s.activeTrackId)
  const cps = useAppStore((s) => s.cps)
  const paceParams = useAppStore((s) => s.paceParams)
  const statsOptions = useAppStore((s) => s.statsOptions)
  const raceStartTime = useAppStore((s) => s.raceStartTime)

  const [message, setMessage] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [paceColumns, setPaceColumns] = useState<PaceCardColumnKey[]>(DEFAULT_PACE_CARD_COLUMNS)

  const activeTrack = tracks.find((t) => t.id === activeTrackId)

  function toggleColumn(col: PaceCardColumnKey) {
    setPaceColumns((cur) => (cur.includes(col) ? cur.filter((c) => c !== col) : [...cur, col]))
  }

  function filenameStem(): string {
    return activeTrack ? sanitizeFilenameStem(activeTrack.meta.name, 'track') : 'track'
  }

  async function handleExportSvg() {
    if (!activeTrack) return
    try {
      const svg = buildElevationProfileSvg(activeTrack, cps, { statsOptions, paceParams, raceStartTimeIso: raceStartTime })
      triggerBlobDownload(new Blob([svg], { type: 'image/svg+xml' }), `${filenameStem()}-高差图.svg`)
      setMessage('已导出高差图 SVG')
    } catch (err) {
      setMessage(describeError(err))
    }
  }

  async function handleExportPng() {
    if (!activeTrack) return
    setBusy(true)
    try {
      const blob = await renderElevationProfilePng(activeTrack, cps, { statsOptions, paceParams, raceStartTimeIso: raceStartTime })
      triggerBlobDownload(blob, `${filenameStem()}-高差图.png`)
      setMessage('已导出高差图 PNG(4× 分辨率)')
    } catch (err) {
      setMessage(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleExportExcel() {
    if (!activeTrack) return
    setBusy(true)
    try {
      const data = buildRouteBookData(activeTrack, cps, paceParams, statsOptions, raceStartTime)
      const model = buildWorkbookModel(data)

      // 高差图渲染失败(理论上不会发生,因为 buildRouteBookData 已经保证了
      // 海拔/里程存在)不应该连累整份 Excel 路书生不出来——退化成没有嵌图
      // 的路书,而不是整个导出失败。
      let profilePng: ArrayBuffer | undefined
      try {
        const pngBlob = await renderElevationProfilePng(activeTrack, cps, { statsOptions, paceParams, raceStartTimeIso: raceStartTime })
        profilePng = await pngBlob.arrayBuffer()
      } catch {
        profilePng = undefined
      }

      const blob = await generateRouteBookWorkbook(model, profilePng)
      triggerBlobDownload(blob, `${filenameStem()}-路书.xlsx`)
      setMessage('已导出 Excel 路书')
    } catch (err) {
      setMessage(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  function handleExportPaceCard() {
    if (!activeTrack) return
    try {
      const data = buildRouteBookData(activeTrack, cps, paceParams, statsOptions, raceStartTime)
      const pages = buildPaceCardSvgPages(data, paceColumns)
      pages.forEach((svg, i) => {
        const suffix = pages.length > 1 ? `-第${i + 1}张(共${pages.length}张)` : ''
        triggerBlobDownload(new Blob([svg], { type: 'image/svg+xml' }), `${filenameStem()}-配速卡${suffix}.svg`)
      })
      setMessage(pages.length > 1 ? `已导出配速卡(CP 较多,共 ${pages.length} 张)` : '已导出配速卡')
    } catch (err) {
      setMessage(describeError(err))
    }
  }

  return (
    <div className="export-panel">
      <h3 className="export-panel__title">路书导出</h3>
      {!activeTrack && <p className="export-panel__hint">请先在轨迹列表中选择一条轨迹</p>}

      <div className="export-panel__row">
        <button type="button" disabled={!activeTrack || busy} onClick={() => void handleExportSvg()}>
          高差图 SVG
        </button>
        <button type="button" disabled={!activeTrack || busy} onClick={() => void handleExportPng()}>
          高差图 PNG(4×)
        </button>
      </div>

      <div className="export-panel__row">
        <button type="button" disabled={!activeTrack || busy} onClick={() => void handleExportExcel()}>
          导出 Excel 路书
        </button>
      </div>

      <div className="export-panel__pace-card">
        <p className="export-panel__subtitle">配速卡列(腕带空间有限，按需勾选)</p>
        <div className="export-panel__columns">
          {PACE_CARD_COLUMN_ORDER.map((col) => (
            <label key={col} className="export-panel__column">
              <input type="checkbox" checked={paceColumns.includes(col)} onChange={() => toggleColumn(col)} />
              {PACE_CARD_COLUMN_LABELS[col]}
            </label>
          ))}
        </div>
        <button type="button" disabled={!activeTrack} onClick={handleExportPaceCard}>
          导出配速卡 SVG
        </button>
      </div>

      {busy && <p className="export-panel__hint">正在生成…</p>}
      {message && <p className="export-panel__hint">{message}</p>}
    </div>
  )
}
