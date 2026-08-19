/**
 * 打印版配速卡——P3-R1 commit 3(方案 V2.1 P4:"配速卡(腕带尺寸打印模板)")。
 * 这是"选手真正带去比赛、跑步时能瞥一眼看懂"的那张纸,不是又一张分段表的
 * 缩小版截图。
 *
 * 物理尺寸:180mm(宽)× 60mm(高)。
 * - 宽度 180mm:成年人前臂周长通常在 220~280mm,180mm 的纸条绕一圈贴在
 *   小臂上会留出足够的搭接/胶带余量,不会绕不过来;比典型腕带产品(约
 *   190~220mm)略保守,优先保证"贴得上"而不是"贴得紧"。
 * - 高度 60mm:按"跑动中瞥一眼就要看清"的可读性要求(约 9~10pt 等宽字体,
 *   单行数据算上留白约 7mm)反推,10mm 留给标题+表头,6mm 留给页码/图例,
 *   剩余空间能放下约 6 行数据——覆盖大多数百公里以内赛事的 CP 数量。
 *   CP 数量超出一张卡片能装下的行数时不做缩小字号"硬塞"(那样就违反了
 *   "跑步时能看清"的前提),而是分页成多张同样尺寸的卡片,见
 *   `paginatePaceCardRows`。
 *
 * 全黑白印刷(不依赖任何颜色):红黄绿三档预警在配速卡里改用符号
 * (✕ / ! / 无符号)而不是颜色区分——路书/Excel 那种彩色底色在黑白打印机
 * 或褪色的彩色墨盒下会完全丢失区分度,而这张卡片恰恰是最可能被直接用
 * 黑白打印机打出来的一份产物。
 */
import type { RouteBookData } from './routeBookData'
import { formatClockHM, formatMarginCompact } from './timeFormat'
import type { WarnLevel } from '../pace/models'

export interface PaceCardDimensionsMm {
  widthMm: number
  heightMm: number
}

export const DEFAULT_CARD_DIMENSIONS_MM: PaceCardDimensionsMm = { widthMm: 180, heightMm: 60 }

// 见本文件顶部注释——这三个常量是 60mm 高度到"约 6 行"这个具体数字的来源,
// 单独导出方便测试直接对着断言,而不是把 6 这个数字硬编码进测试里。
export const HEADER_HEIGHT_MM = 10
export const ROW_HEIGHT_MM = 7
export const FOOTER_HEIGHT_MM = 6

/** 给定卡片高度,一页最多能放几行数据——高度不足以放标题+表头+一行数据时
 * 仍然保底返回 1(不返回 0/负数让分页逻辑产生空页或死循环)。 */
export function rowsPerCard(dims: PaceCardDimensionsMm): number {
  const available = dims.heightMm - HEADER_HEIGHT_MM - FOOTER_HEIGHT_MM
  return Math.max(1, Math.floor(available / ROW_HEIGHT_MM))
}

// ── 列选择 ──────────────────────────────────────────────────────────────

/** CP 名称列(`name`)是固定的——一张点不出"这是哪个 CP"的卡片没有意义,
 * 因此不在可选列表里,永远显示。以下是"腕带空间是硬约束,用户自选"的那
 * 部分列。 */
export type PaceCardColumnKey = 'mileage' | 'ascent' | 'eta' | 'cutoff' | 'margin'

export const PACE_CARD_COLUMN_LABELS: Record<PaceCardColumnKey, string> = {
  mileage: '里程(km)',
  ascent: '累计爬升(m)',
  eta: '预计到达',
  cutoff: '关门时间',
  margin: '关门余量',
}

/** 列的固定展示顺序——`PACE_CARD_COLUMN_LABELS` 的 key 遍历顺序在 JS 里
 * 是稳定的,但显式导出一份顺序常量,不依赖调用方或未来重构时对象字面量
 * 属性顺序不变这条隐含假设。 */
export const PACE_CARD_COLUMN_ORDER: PaceCardColumnKey[] = ['mileage', 'ascent', 'eta', 'cutoff', 'margin']

/** 方案要求的默认四列:里程、累计爬升、预计到达、关门时间——"关门余量"是
 * 本项目在此基础上新增的第五个可选列,默认不勾选,留给用户按需加。 */
export const DEFAULT_PACE_CARD_COLUMNS: PaceCardColumnKey[] = ['mileage', 'ascent', 'eta', 'cutoff']

/**
 * 把用户的自由勾选结果整理成一份稳定、去重、按固定顺序排列的列列表。
 * 用户一列都不选时(腕带空间宁可空着也不想要任何数字,这种输入不该产出
 * 一张只有 CP 名字的卡片——大概率是误操作)回退到默认四列,而不是生成
 * 一张信息量为零的卡片。
 */
export function selectPaceCardColumns(selected: PaceCardColumnKey[]): PaceCardColumnKey[] {
  const wanted = new Set(selected)
  const ordered = PACE_CARD_COLUMN_ORDER.filter((c) => wanted.has(c))
  return ordered.length > 0 ? ordered : DEFAULT_PACE_CARD_COLUMNS
}

// ── 行数据 ──────────────────────────────────────────────────────────────

export interface PaceCardRow {
  name: string
  mileageKm: string
  ascentM: string
  eta: string
  cutoff: string
  margin: string
  /** 用于选择黑白安全符号(见本文件顶部注释),`undefined`(没有起跑时间/
   * 没有配速模型)不画任何符号——不伪造一个"安全"状态。 */
  level: WarnLevel | undefined
}

/** 从 `RouteBookData`(已经和分段表共用同一套 computeSegments/
 * estimateArrivals 结果)取每个 CP 的累计里程/累计爬升/预计到达/关门时间——
 * 不重新计算任何一个数字。包含最后一行(终点),因为完赛预计时间对配速卡
 * 同样有用。 */
export function buildPaceCardRows(data: RouteBookData): PaceCardRow[] {
  return data.rows.map((r) => ({
    name: r.toName,
    mileageKm: (r.cumDistM / 1000).toFixed(1),
    ascentM: r.cumGainM.toFixed(0),
    eta: r.etaMs !== undefined ? formatClockHM(r.etaMs) : '--',
    cutoff: r.cutoffMs !== undefined ? formatClockHM(r.cutoffMs) : '--',
    margin: formatMarginCompact(r.marginSec),
    level: r.level,
  }))
}

// ── 分页 ────────────────────────────────────────────────────────────────

export interface PaceCardPage {
  /** 0-based 页码。 */
  pageIndex: number
  pageCount: number
  rows: PaceCardRow[]
}

/**
 * 把行数据按 `rowsPerCard` 切成若干页,每页都是同样物理尺寸的独立卡片
 * (方案要求"配速卡"是可打印/裁切的实体,CP 太多时应该是"多拿几张卡片",
 * 不是"一张卡片塞不下就变形/缩字号到看不清")。零行(理论上不会发生,
 * `buildRouteBookData` 已经保证至少一个 CP)时仍返回一页空表格,而不是
 * 空数组——调用方不需要再单独判断"没有页"这种边界。
 */
export function paginatePaceCardRows(rows: PaceCardRow[], dims: PaceCardDimensionsMm = DEFAULT_CARD_DIMENSIONS_MM): PaceCardPage[] {
  const perPage = rowsPerCard(dims)
  const pageCount = Math.max(1, Math.ceil(rows.length / perPage))
  const pages: PaceCardPage[] = []
  for (let p = 0; p < pageCount; p++) {
    pages.push({ pageIndex: p, pageCount, rows: rows.slice(p * perPage, (p + 1) * perPage) })
  }
  return pages
}

// ── SVG 渲染 ────────────────────────────────────────────────────────────

const STATUS_GLYPH: Record<WarnLevel, string> = { green: '', yellow: '!', red: '✕' } // ✕

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const COL_VALUE: Record<PaceCardColumnKey, (row: PaceCardRow) => string> = {
  mileage: (r) => r.mileageKm,
  ascent: (r) => r.ascentM,
  eta: (r) => r.eta,
  cutoff: (r) => r.cutoff,
  margin: (r) => r.margin,
}

/**
 * 渲染单页配速卡为 SVG——`width`/`height` 直接写成 `${mm}mm`,`viewBox` 的
 * 用户单位与毫米一一对应,这样大多数支持 SVG 物理尺寸的打印/查看器会按
 * 真实毫米数出图,不需要用户手动设缩放比例。全程只用黑色描边/填充
 * (`#000`/`#fff`),不使用任何彩色——见本文件顶部"全黑白印刷"说明。
 */
export function svgFromPaceCardPage(
  page: PaceCardPage,
  trackName: string,
  columns: PaceCardColumnKey[],
  dims: PaceCardDimensionsMm = DEFAULT_CARD_DIMENSIONS_MM,
): string {
  const { widthMm: w, heightMm: h } = dims
  const nameColWidthMm = w * 0.28
  const dataColWidthMm = (w - nameColWidthMm) / Math.max(columns.length, 1)

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" font-family="monospace">`)
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#fff" stroke="#000" stroke-width="0.3"/>`)

  const titleY = 5
  parts.push(
    `<text x="2" y="${titleY}" font-size="3.2" font-weight="700" fill="#000">${escapeXml(trackName)}</text>` +
      `<text x="${w - 2}" y="${titleY}" font-size="2.6" fill="#000" text-anchor="end">${page.pageIndex + 1}/${page.pageCount}</text>`,
  )

  const headerY = HEADER_HEIGHT_MM
  parts.push(`<line x1="0" y1="${headerY}" x2="${w}" y2="${headerY}" stroke="#000" stroke-width="0.4"/>`)
  parts.push(`<text x="1" y="${headerY - 1.5}" font-size="2.6" font-weight="700" fill="#000">CP</text>`)
  columns.forEach((col, i) => {
    const x = nameColWidthMm + i * dataColWidthMm + 1
    parts.push(`<text x="${x}" y="${headerY - 1.5}" font-size="2.6" font-weight="700" fill="#000">${escapeXml(PACE_CARD_COLUMN_LABELS[col])}</text>`)
  })

  page.rows.forEach((row, i) => {
    const rowY = headerY + (i + 1) * ROW_HEIGHT_MM
    const textY = rowY - ROW_HEIGHT_MM / 2 + 1.2
    parts.push(`<line x1="0" y1="${rowY}" x2="${w}" y2="${rowY}" stroke="#000" stroke-width="0.15"/>`)
    const glyph = row.level !== undefined ? STATUS_GLYPH[row.level] : ''
    const weight = row.level === 'red' ? '700' : '400'
    parts.push(
      `<text x="1" y="${textY}" font-size="3" font-weight="${weight}" fill="#000">${glyph ? glyph + ' ' : ''}${escapeXml(row.name)}</text>`,
    )
    columns.forEach((col, ci) => {
      const x = nameColWidthMm + ci * dataColWidthMm + 1
      parts.push(`<text x="${x}" y="${textY}" font-size="2.8" font-weight="${weight}" fill="#000">${escapeXml(COL_VALUE[col](row))}</text>`)
    })
  })

  parts.push('</svg>')
  return parts.join('')
}

/**
 * `buildRouteBookData` 已经算好的一整份路书数据 → 一组配速卡页面(SVG
 * 字符串数组,一页一张)。行数据不重复计算——直接复用 `buildPaceCardRows`。
 */
export function buildPaceCardSvgPages(
  data: RouteBookData,
  columns: PaceCardColumnKey[] = DEFAULT_PACE_CARD_COLUMNS,
  dims: PaceCardDimensionsMm = DEFAULT_CARD_DIMENSIONS_MM,
): string[] {
  const rows = buildPaceCardRows(data)
  const cols = selectPaceCardColumns(columns)
  const pages = paginatePaceCardRows(rows, dims)
  return pages.map((page) => svgFromPaceCardPage(page, data.trackName, cols, dims))
}
