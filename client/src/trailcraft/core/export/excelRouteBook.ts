/**
 * Excel 路书导出——P3-R1 commit 2(方案 V2.1 P4 验收项:"ExcelJS 生成含样式的
 * 两 Sheet 路书(全程概述 + 节点明细),嵌入高差图,Excel/WPS/Google Sheets
 * 打开样式不丢失")。
 *
 * 拆成两层,和 `profileGraphic.ts` 的 model/render 分层同一个思路:
 * - `buildWorkbookModel`(本文件,纯函数):把 `RouteBookData` 转成"两个
 *   Sheet 各自要写哪些行、每个状态格用什么颜色"这样一份普通对象,不碰
 *   ExcelJS。可以在 Node 下直接单测行/列内容是否正确,不需要真的生成一个
 *   .xlsx 文件去解析验证。
 * - `generateRouteBookWorkbook`(本文件,依赖 ExcelJS,异步):把上面那份
 *   模型机械地写进一个 `ExcelJS.Workbook`,只做"翻译",不包含任何业务
 *   判断——业务判断(比如红黄绿阈值)已经在 `RouteBookData`/`estimateArrivals`
 *   里做完了,这里绝不重新发明一套判断规则。
 *
 * ExcelJS(~1MB+ minified)通过和 Cesium 完全一样的动态 `import()` 边界加载
 * (见 `type ExcelJSModule = typeof import('exceljs')` 与
 * `src/ui/FlyView.tsx` 顶部同款注释),因此绝不会进入主 bundle。
 */
import type { RouteBookData } from './routeBookData'
import { WARN_LEVEL_LABELS, WARN_LEVEL_COLORS, type WarnLevel } from '../pace/models'
import { formatDurationCompactHM, formatClockHM, formatMarginCompact } from './timeFormat'

// 只在真正调用 generateRouteBookWorkbook 时才会触发的动态 import——静态
// import 一旦写在模块顶层就会把 exceljs 拖进主 bundle,和 Cesium 的处理方式
// 必须完全一致(见 vite.config.ts 对 Cesium manualChunks 的注释)。
type ExcelJSModule = typeof import('exceljs')

// ── Pure model ──────────────────────────────────────────────────────────

export interface OverviewRow {
  label: string
  value: string
}

export interface OverviewSheetModel {
  sheetName: string
  title: string
  rows: OverviewRow[]
}

export interface NodeDetailRow {
  fromName: string
  toName: string
  /** 已格式化的文本单元格,和 `SegmentTable.tsx` 表格逐位一致的四舍五入
   * 规则(见该函数的实现)——保证 Excel 里看到的数字与屏幕上分段表完全
   * 相同,不是另一套四舍五入结果。 */
  distKm: string
  gainM: string
  lossM: string
  gradePct: string
  segTime: string
  eta: string
  cutoff: string
  margin: string
  statusLabel: string
  /** 驱动状态格底色的原始档位;`undefined`(没有起跑时间/没有配速模型时)
   * 不上色,只显示占位符文本。 */
  statusLevel: WarnLevel | undefined
}

export interface NodeDetailSheetModel {
  sheetName: string
  headers: string[]
  rows: NodeDetailRow[]
}

export interface WorkbookModel {
  overview: OverviewSheetModel
  nodeDetail: NodeDetailSheetModel
}

const PACE_MODEL_LABEL: Record<'tobler' | 'practical', string> = { tobler: 'Tobler 徒步函数', practical: '实用档' }

function formatMmSs(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const NODE_DETAIL_HEADERS = [
  '起点', '终点', '距离 (km)', '爬升 (m)', '下降 (m)', '净坡度 (%)',
  '预计段时间 (h:mm)', '预计到达 (HH:mm)', '关门时间 (HH:mm)', '关门余量 (±h:mm)', '状态',
]

/**
 * 把 `RouteBookData` 转成 Excel 要写的两个 Sheet 的行数据。不依赖 ExcelJS,
 * 因此可以脱离真实 .xlsx 生成过程单独验证正确性。
 */
export function buildWorkbookModel(data: RouteBookData): WorkbookModel {
  const model = data.paceParams.model ?? 'practical'

  const overviewRows: OverviewRow[] = [
    { label: '轨迹名称', value: data.trackName },
    { label: '全程距离', value: `${(data.totalDistM / 1000).toFixed(2)} km` },
    { label: '总爬升', value: `${data.totalGainM.toFixed(0)} m` },
    { label: '总下降', value: `${data.totalLossM.toFixed(0)} m` },
    { label: '起跑时间', value: data.startMs !== undefined ? new Date(data.startMs).toLocaleString('zh-CN') : '--（起跑时间无效）' },
    {
      label: '预计完赛时间',
      value: data.finishEtaMs !== undefined ? new Date(data.finishEtaMs).toLocaleString('zh-CN') : '--',
    },
    { label: '配速模型', value: PACE_MODEL_LABEL[model] },
    { label: '平路配速', value: `${formatMmSs(data.paceParams.flatPaceSecPerKm)} / 公里` },
    { label: '爬升垂直速度 (VAM)', value: `${data.paceParams.vamMPerH} m/h` },
    { label: '下坡折算系数', value: `${data.paceParams.descentFactor} 秒/米下降` },
    { label: '疲劳减速', value: `${data.paceParams.fatiguePctPerHour}% / 小时` },
  ]

  const nodeRows: NodeDetailRow[] = data.rows.map((r) => ({
    fromName: r.fromName,
    toName: r.toName,
    distKm: (r.distM / 1000).toFixed(2),
    gainM: r.gain.toFixed(0),
    lossM: r.loss.toFixed(0),
    gradePct: (r.netSlope * 100).toFixed(1),
    segTime: r.segTimeSec !== undefined ? formatDurationCompactHM(r.segTimeSec) : '--',
    eta: r.etaMs !== undefined ? formatClockHM(r.etaMs) : '--',
    cutoff: r.cutoffMs !== undefined ? formatClockHM(r.cutoffMs) : '--',
    margin: formatMarginCompact(r.marginSec),
    statusLabel: r.level !== undefined ? WARN_LEVEL_LABELS[r.level] : '--',
    statusLevel: r.level,
  }))

  return {
    overview: { sheetName: '全程概述', title: `${data.trackName} · 路书`, rows: overviewRows },
    nodeDetail: { sheetName: '节点明细', headers: NODE_DETAIL_HEADERS, rows: nodeRows },
  }
}

// ── ExcelJS generation ──────────────────────────────────────────────────

const HEADER_FILL_ARGB = 'FF1F2937' // 深灰蓝,呼应 App 深色面板配色
const HEADER_FONT_ARGB = 'FFFFFFFF'
const THIN_BORDER_ARGB = 'FFD1D5DB'

/** '#16a34a' → 'FF16A34A'——ExcelJS 的 ARGB 颜色格式,复用
 * `WARN_LEVEL_COLORS` 而不是在这里重新定义一套红黄绿色值(该常量本身已经
 * 与 `App.css` 的状态列颜色保持一致,见其定义处注释)。 */
function toArgb(hex: string): string {
  return `FF${hex.replace('#', '').toUpperCase()}`
}

function thinBorder() {
  const b = { style: 'thin' as const, color: { argb: THIN_BORDER_ARGB } }
  return { top: b, left: b, bottom: b, right: b }
}

/**
 * 生成真正的 .xlsx 文件(`Blob`)。样式选择刻意避开一批 Excel 高级特性,
 * 保证 WPS/Google Sheets 重新打开后样式/数据不丢失(方案 V2.1 P4 验收项的
 * 明确要求):
 *
 * - 不用条件格式(conditional formatting)规则表达红黄绿,而是在生成时就
 *   算好每个单元格该是什么颜色、写成静态填充——WPS 对条件格式规则的解析
 *   支持一直不稳定,静态填充没有这个风险。
 * - 不用 ExcelJS 的结构化 Table(`addTable`)对象,只写普通单元格 +
 *   手工表头样式——结构化 Table 在 WPS/Google Sheets 里偶发丢失整张表的
 *   样式或被强制转成普通区域。
 * - 数字/时刻一律写成预先格式化好的文本(如 "3:25"、"14:30"),不用 Excel
 *   的自定义 numFmt(如时长/负数的自定义格式代码)——这类代码在 Excel、
 *   WPS、Google Sheets 三者之间的语法支持差异正是最容易在跨平台打开时
 *   出现"数字变乱码"的地方。代价是这些列在电子表格里不能直接参与数值
 *   运算,但路书首要是打印/查阅而不是二次计算,可接受。
 * - 图片用最基础的"左上角 + 显式宽高"两点定位(`ImagePosition`),不使用
 *   `oneCell`/`editAs` 等更复杂的锚定选项。
 * - 不设置打印区域、自动筛选、分组/大纲——这些都是"锦上添花"但在不同实现
 *   之间兼容性证据最少的特性。
 */
export async function generateRouteBookWorkbook(model: WorkbookModel, profilePng?: ArrayBuffer): Promise<Blob> {
  const ExcelJS: ExcelJSModule = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  wb.creator = 'TrailCraft'
  wb.created = new Date()

  // ---- Sheet 1: 全程概述 ----
  const ws1 = wb.addWorksheet(model.overview.sheetName, { views: [{ state: 'frozen', ySplit: 1 }] })
  ws1.columns = [{ header: '项目', width: 20 }, { header: '数值', width: 42 }]
  ws1.getRow(1).values = ['项目', '数值']
  ws1.getRow(1).font = { bold: true, color: { argb: HEADER_FONT_ARGB } } as never
  ws1.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } }
  ws1.getRow(1).eachCell((cell) => {
    cell.border = thinBorder()
  })

  for (const row of model.overview.rows) {
    const excelRow = ws1.addRow([row.label, row.value])
    excelRow.eachCell((cell) => {
      cell.border = thinBorder()
    })
    excelRow.getCell(1).font = { bold: true }
  }

  if (profilePng) {
    const imageId = wb.addImage({ buffer: profilePng, extension: 'png' })
    const imageTopRow = model.overview.rows.length + 3
    ws1.addImage(imageId, {
      tl: { col: 0, row: imageTopRow },
      ext: { width: 700, height: 240 },
    })
  }

  // ---- Sheet 2: 节点明细 ----
  const ws2 = wb.addWorksheet(model.nodeDetail.sheetName, { views: [{ state: 'frozen', ySplit: 1 }] })
  const colWidths = [14, 14, 10, 10, 10, 10, 14, 14, 14, 14, 8]
  ws2.columns = model.nodeDetail.headers.map((header, i) => ({ header, width: colWidths[i] ?? 12 }))
  ws2.getRow(1).values = model.nodeDetail.headers
  ws2.getRow(1).font = { bold: true, color: { argb: HEADER_FONT_ARGB } } as never
  ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } }
  ws2.getRow(1).eachCell((cell) => {
    cell.border = thinBorder()
    cell.alignment = { horizontal: 'center', vertical: 'middle' } as never
  })

  for (const row of model.nodeDetail.rows) {
    const excelRow = ws2.addRow([
      row.fromName, row.toName, row.distKm, row.gainM, row.lossM, row.gradePct,
      row.segTime, row.eta, row.cutoff, row.margin, row.statusLabel,
    ])
    excelRow.eachCell((cell) => {
      cell.border = thinBorder()
      cell.alignment = { horizontal: 'center', vertical: 'middle' } as never
    })
    excelRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' } as never
    excelRow.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' } as never

    if (row.statusLevel !== undefined) {
      const statusCell = excelRow.getCell(model.nodeDetail.headers.length)
      statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: toArgb(WARN_LEVEL_COLORS[row.statusLevel]) } }
      statusCell.font = { bold: true, color: { argb: HEADER_FONT_ARGB } } as never
    }
  }

  const buffer = await wb.xlsx.writeBuffer()
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
