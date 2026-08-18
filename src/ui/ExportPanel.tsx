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
import {
  buildWebPagePayload, renderWebPageHtml, utf8ByteSize, computeWebPageSizeBreakdown,
  DEFAULT_MAX_POINTS,
} from '../core/export/webPage'

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

/**
 * 交互网页超过这个体积就不直接下载——8MB 是"轻量分享"和"这已经不适合发在
 * 聊天群里"之间一个宽松但有意义的分界:GitHub Pages/Cloudflare Pages 单文件
 * 限制是几十到上百 MB(远没到瓶颈),真正的约束是分享场景本身——聊天软件
 * 传文件、对方手机流量打开——8MB 往上用户体验已经明显变差。命中阈值时
 * 拒绝静默下载一个"能用但很卡"的文件,而是提示用户可以降精度重新生成,见
 * `handleExportWebPage`/`handleLowerWebPagePrecision`。
 */
const WEB_PAGE_WARN_BYTES = 8 * 1024 * 1024
/** `decimateIndices` 允许更低，但网页降到几百个点以下路线形状已经明显失真,
 * 没有继续往下降的意义——`handleLowerWebPagePrecision` 停在这个地板。 */
const WEB_PAGE_MIN_POINTS = 500

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(0)} KB`
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
  const [webPageMaxPoints, setWebPageMaxPoints] = useState(DEFAULT_MAX_POINTS)
  const [webPageIncludePhotos, setWebPageIncludePhotos] = useState(true)
  const [webPageOversized, setWebPageOversized] = useState(false)
  // 体积超标时该建议哪条补救路径——`undefined` 表示两条路都已经走到头
  // (抽稀已到 `WEB_PAGE_MIN_POINTS`,照片也已排除),没有进一步的补救可提。
  const [webPageRemedy, setWebPageRemedy] = useState<'route' | 'photo' | undefined>()

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

  /**
   * P3-R4 commit 2:生成即测体积——`webPage.ts` 的模块注释已经论证过为什么
   * 抽稀是体积的决定性因素,这里把那份论证落到用户实际能看到、能操作的地方:
   * 超阈值时不下载、给出实测大小,并提供补救路径,而不是让用户拿到
   * 一个几十 MB、浏览器打开都吃力的文件之后才发现问题。
   *
   * P3-R5 commit 1:P3-R4 交付时这里只有"降低精度"一条路,但抽稀只影响路线
   * 点数组——如果体积超标是检查点照片(`photoUrl` data URI)撑起来的,降低
   * 精度点几次都不会让文件变小,用户会卡在一个没有出口的循环里。这里改用
   * `computeWebPageSizeBreakdown` 先量出照片/路线各占多少,再决定该展示
   * "降低精度"还是"排除随身照片"——只提供实际有效的那一个,不是两个都摆出来
   * 让用户自己猜。
   */
  function handleExportWebPage() {
    if (!activeTrack) return
    try {
      const payload = buildWebPagePayload(activeTrack, cps, {
        maxPoints: webPageMaxPoints, statsOptions, paceParams, raceStartTimeIso: raceStartTime,
        includePhotos: webPageIncludePhotos,
      })
      const html = renderWebPageHtml(payload)
      const bytes = utf8ByteSize(html)
      if (bytes > WEB_PAGE_WARN_BYTES) {
        const breakdown = computeWebPageSizeBreakdown(payload, bytes)
        const canLowerPrecision = webPageMaxPoints > WEB_PAGE_MIN_POINTS
        const canExcludePhotos = webPageIncludePhotos && breakdown.photoBytes > 0

        let remedy: 'route' | 'photo' | undefined
        if (breakdown.dominant === 'photo' && canExcludePhotos) remedy = 'photo'
        else if (canLowerPrecision) remedy = 'route'
        else if (canExcludePhotos) remedy = 'photo'
        setWebPageRemedy(remedy)
        setWebPageOversized(true)

        const photoNote = breakdown.photoBytes > 0
          ? `，其中随身照片约 ${formatBytes(breakdown.photoBytes)}（${Math.round(breakdown.photoShare * 100)}%）`
          : ''
        const remedyHint =
          remedy === 'photo'
            ? '体积主要来自检查点随身照片，降低精度无法减小它——可点击下方"排除随身照片后重新生成"。'
            : remedy === 'route'
              ? '可点击下方"降低精度后重新生成"缩小文件。'
              : '已降到最低抽稀点数且未内嵌照片，暂时没有进一步的补救方式。'
        setMessage(
          `交互网页约 ${formatBytes(bytes)}${photoNote}（当前抽稀上限 ${webPageMaxPoints} 点），偏大不建议直接分享。${remedyHint}`,
        )
        return
      }
      setWebPageOversized(false)
      setWebPageRemedy(undefined)
      triggerBlobDownload(new Blob([html], { type: 'text/html' }), `${filenameStem()}-交互网页.html`)
      setMessage(
        `已导出交互网页（约 ${formatBytes(bytes)}，抽稀上限 ${webPageMaxPoints} 点${webPageIncludePhotos ? '' : '，已排除随身照片'}）`,
      )
    } catch (err) {
      setWebPageOversized(false)
      setWebPageRemedy(undefined)
      setMessage(describeError(err))
    }
  }

  function handleLowerWebPagePrecision() {
    setWebPageMaxPoints((cur) => Math.max(WEB_PAGE_MIN_POINTS, Math.floor(cur / 2)))
    setMessage('已降低精度，请再次点击"导出交互网页"重新生成')
  }

  function handleExcludeWebPagePhotos() {
    setWebPageIncludePhotos(false)
    setMessage('已排除随身照片，请再次点击"导出交互网页"重新生成')
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

      <div className="export-panel__row">
        <button type="button" disabled={!activeTrack || busy} onClick={handleExportWebPage}>
          导出交互网页(HTML)
        </button>
        {webPageOversized && webPageRemedy === 'route' && (
          <button type="button" disabled={!activeTrack || busy} onClick={handleLowerWebPagePrecision}>
            降低精度后重新生成
          </button>
        )}
        {webPageOversized && webPageRemedy === 'photo' && (
          <button type="button" disabled={!activeTrack || busy} onClick={handleExcludeWebPagePhotos}>
            排除随身照片后重新生成
          </button>
        )}
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
