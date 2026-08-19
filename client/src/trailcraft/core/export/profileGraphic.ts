/**
 * 高差图导出——P3-R1 commit 1(方案 V2.1 P4 验收项之一:"高差图导出 SVG +
 * 4× PNG")。
 *
 * `computeProfileChartModel` 是唯一一处"从 Track/CP/配速参数算出图表要画
 * 什么"的地方——SVG 字符串构建(`svgFromProfileChartModel`)和 PNG 画布绘制
 * (`drawProfileChartModelToCanvas`)都只读这份已经算好的 model,不各自重新
 * 调用 `computeProfileGeometry`/`computeSegments`,因此两种输出格式的曲线
 * 形状、坐标轴刻度、CP 标注位置永远一致,不可能画出两条不同的图。
 */
import type { Track } from '../model/track'
import type { CheckPoint } from '../model/checkpoint'
import { buildProfileData } from '../../profile/profileRender'
import { computeSegments, type StatsOptions } from '../stats/segments'
import { sortCpsByAnchor, alignCutoffsToSegments } from '../stats/cutoffAlign'
import { estimateArrivals, type PaceParams, type Arrival } from '../pace/models'
import {
  computeProfileGeometry, computeProfilePoints, selectDistanceTicksKm, selectElevationTicks, placeCpLabels,
  DEFAULT_MARGIN, type Margin, type ProfileGeometry, type ProfilePoint, type CpLabelPlacement,
} from './profileGeometry'

const NO_ELEVATION_MESSAGE = '该轨迹没有海拔数据，无法生成高差图'
const NO_DIST_MESSAGE = '该轨迹缺少里程数据，无法生成高差图'

const DEFAULT_WIDTH_PX = 1400
const DEFAULT_HEIGHT_PX = 480
const DEFAULT_PNG_SCALE = 4

export interface ProfileChartOptions {
  widthPx?: number
  heightPx?: number
  margin?: Margin
  /** 与分段表(SegmentTable.tsx)完全相同的爬升阈值/平滑窗口——不传则用
   * `computeSegments` 自身的默认值,和 appStore 的 DEFAULT_STATS_OPTIONS 一致。 */
  statsOptions?: StatsOptions
  /** 提供配速参数 + 起跑时间才会标注每段预计耗时;只给坡度不给耗时的场景
   * (还没配置配速)下这两者都应省略,而不是喂 undefined 字段。 */
  paceParams?: PaceParams
  raceStartTimeIso?: string
}

export interface SegmentAnnotation {
  fromName: string
  toName: string
  /** 该段终点(CP 或终点)在图表中的像素 x,标注文字贴在这个位置附近。 */
  xAtEnd: number
  netSlopePct: number
  /** 未提供配速参数/起跑时间无效时为 undefined——绝不用 0 冒充"没算出来"。 */
  segTimeSec: number | undefined
}

export interface ProfileChartModel {
  widthPx: number
  heightPx: number
  geometry: ProfileGeometry
  points: ProfilePoint[]
  distanceTicksKm: number[]
  elevationTicks: number[]
  cpLabels: CpLabelPlacement[]
  totalDistM: number
  totalGainM: number
  totalLossM: number
  trackName: string
  segmentAnnotations: SegmentAnnotation[]
}

/**
 * 算出高差图需要的一切:几何映射、抽稀采样点像素坐标、坐标轴刻度、CP 标签
 * 避让位置、累计爬升/下降(与分段表同一份 `computeSegments` 结果,保证和
 * 屏幕上看到的数字一致)、以及可选的逐段坡度/预计耗时标注。
 *
 * 没有海拔列或没有里程(cumDist)时直接抛出中文错误,而不是画一张空图表
 * ——见本任务书"Handle a track with no elevation explicitly"的要求。
 */
export function computeProfileChartModel(
  track: Track,
  cps: CheckPoint[],
  opts: ProfileChartOptions = {},
): ProfileChartModel {
  if (!track.points.ele) throw new Error(NO_ELEVATION_MESSAGE)
  if (!track.points.cumDist) throw new Error(NO_DIST_MESSAGE)
  const profile = buildProfileData(track)
  if (!profile) throw new Error(NO_ELEVATION_MESSAGE)

  const widthPx = opts.widthPx ?? DEFAULT_WIDTH_PX
  const heightPx = opts.heightPx ?? DEFAULT_HEIGHT_PX
  const geometry = computeProfileGeometry(profile, widthPx, heightPx, opts.margin ?? DEFAULT_MARGIN)
  const points = computeProfilePoints(profile, geometry)
  const distanceTicksKm = selectDistanceTicksKm(profile.totalDist)
  const elevationTicks = selectElevationTicks(geometry.minEle, geometry.maxEle)

  // 同一条轨迹可能挂了别的轨迹的 CP(appStore.cps 是全局数组)——和
  // SegmentTable.tsx 一样,必须按 trackId 过滤后才能参与本轨迹的分段/标注。
  const trackCps = cps.filter((c) => c.trackId === track.id)
  const sortedCps = sortCpsByAnchor(trackCps)
  const cumDist = track.points.cumDist
  const cpLabels = placeCpLabels(
    sortedCps.map((c) => ({
      id: c.id,
      name: c.name,
      distM: cumDist[Math.min(Math.max(c.anchorIndex, 0), cumDist.length - 1)],
    })),
    geometry,
  )

  // 与分段表同一个纯函数、同一份 statsOptions——累计爬升/下降因此和屏幕上
  // SegmentTable/PacePanel 显示的数字逐位一致,不是独立算一遍的近似值。
  const segments = computeSegments(track, sortedCps, opts.statsOptions ?? {})
  const totalGainM = segments.reduce((sum, seg) => sum + seg.gain, 0)
  const totalLossM = segments.reduce((sum, seg) => sum + seg.loss, 0)

  let arrivals: Arrival[] | undefined
  let startMs: number | undefined
  if (opts.paceParams && opts.raceStartTimeIso) {
    const parsed = Date.parse(opts.raceStartTimeIso)
    if (!Number.isNaN(parsed)) {
      startMs = parsed
      const cutoffsMs = alignCutoffsToSegments(segments, sortedCps)
      arrivals = estimateArrivals(segments, opts.paceParams, parsed, cutoffsMs)
    }
  }

  const segmentAnnotations: SegmentAnnotation[] = segments.map((seg, i) => {
    const endDistM = cumDist[seg.toIndex]
    const arrival = arrivals?.[i]
    const prevEtaMs = i === 0 ? startMs : arrivals?.[i - 1]?.etaMs
    const segTimeSec = arrival && prevEtaMs !== undefined ? (arrival.etaMs - prevEtaMs) / 1000 : undefined
    return {
      fromName: seg.fromName,
      toName: seg.toName,
      xAtEnd: geometry.toX(endDistM),
      netSlopePct: seg.netSlope * 100,
      segTimeSec,
    }
  })

  return {
    widthPx,
    heightPx,
    geometry,
    points,
    distanceTicksKm,
    elevationTicks,
    cpLabels,
    totalDistM: profile.totalDist,
    totalGainM,
    totalLossM,
    trackName: track.meta.name,
    segmentAnnotations,
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatDurationHM(sec: number): string {
  const totalMin = Math.round(sec / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}分`
}

/** 折线/填充区域的 SVG 路径数据——沿海拔缺失点(finite===false)断开,不把
 * 退化坐标当真实曲线连起来。返回多段(每段独立一条 polyline),调用方各自
 * 拼接成 `<polyline>`/填充 `<path>`。 */
function splitFiniteRuns(points: ProfilePoint[]): ProfilePoint[][] {
  const runs: ProfilePoint[][] = []
  let current: ProfilePoint[] = []
  for (const p of points) {
    if (p.finite) {
      current.push(p)
    } else if (current.length > 0) {
      runs.push(current)
      current = []
    }
  }
  if (current.length > 0) runs.push(current)
  return runs
}

/**
 * 把 `ProfileChartModel` 渲染成矢量 SVG 标记——直接拼字符串,不经过任何
 * canvas 光栅化,打印/缩放不失真。
 */
export function svgFromProfileChartModel(model: ProfileChartModel): string {
  const { widthPx, heightPx, geometry: g, points, distanceTicksKm, elevationTicks, cpLabels, segmentAnnotations } = model
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}" viewBox="0 0 ${widthPx} ${heightPx}" font-family="sans-serif">`)
  parts.push(`<rect x="0" y="0" width="${widthPx}" height="${heightPx}" fill="#ffffff"/>`)

  // 标题 + 累计爬升/下降标注
  parts.push(
    `<text x="${g.margin.left}" y="18" font-size="14" font-weight="600" fill="#111827">${escapeXml(model.trackName)} 高差图</text>`,
  )
  parts.push(
    `<text x="${widthPx - g.margin.right}" y="18" font-size="12" fill="#374151" text-anchor="end">` +
      `累计爬升 ${Math.round(model.totalGainM)}m · 累计下降 ${Math.round(model.totalLossM)}m · 全程 ${(model.totalDistM / 1000).toFixed(1)}km</text>`,
  )

  // 海拔网格线 + 轴标签
  for (const ele of elevationTicks) {
    const y = g.toY(ele)
    parts.push(`<line x1="${g.plot.x0}" y1="${y}" x2="${g.plot.x1}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`)
    parts.push(`<text x="${g.plot.x0 - 8}" y="${y + 4}" font-size="11" fill="#4b5563" text-anchor="end">${Math.round(ele)}m</text>`)
  }
  // 里程网格线 + 轴标签
  for (const km of distanceTicksKm) {
    const x = g.toX(km * 1000)
    parts.push(`<line x1="${x}" y1="${g.plot.y0}" x2="${x}" y2="${g.plot.y1}" stroke="#f3f4f6" stroke-width="1"/>`)
    parts.push(`<text x="${x}" y="${g.plot.y1 + 16}" font-size="11" fill="#4b5563" text-anchor="middle">${km}km</text>`)
  }
  // 坐标轴边框
  parts.push(
    `<rect x="${g.plot.x0}" y="${g.plot.y0}" width="${g.plot.x1 - g.plot.x0}" height="${g.plot.y1 - g.plot.y0}" fill="none" stroke="#9ca3af" stroke-width="1"/>`,
  )

  // 填充剖面 + 折线轮廓(逐段断开,跳过海拔缺失区间)
  const baselineY = g.plot.y1
  for (const run of splitFiniteRuns(points)) {
    if (run.length === 0) continue
    const fillD = [`M ${run[0].x} ${baselineY}`, ...run.map((p) => `L ${p.x} ${p.y}`), `L ${run[run.length - 1].x} ${baselineY}`, 'Z'].join(' ')
    parts.push(`<path d="${fillD}" fill="#93c5fd" fill-opacity="0.45" stroke="none"/>`)
    const lineD = run.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
    parts.push(`<path d="${lineD}" fill="none" stroke="#2563eb" stroke-width="2"/>`)
  }

  // 逐段坡度 / 预计耗时标注(仅当算出来了才画,不用 0 占位)
  for (const seg of segmentAnnotations) {
    const label = seg.segTimeSec !== undefined
      ? `${seg.netSlopePct >= 0 ? '+' : ''}${seg.netSlopePct.toFixed(1)}% · ${formatDurationHM(seg.segTimeSec)}`
      : `${seg.netSlopePct >= 0 ? '+' : ''}${seg.netSlopePct.toFixed(1)}%`
    parts.push(
      `<text x="${seg.xAtEnd}" y="${g.plot.y0 - 6}" font-size="10" fill="#6b7280" text-anchor="end" transform="rotate(-30 ${seg.xAtEnd} ${g.plot.y0 - 6})">${escapeXml(label)}</text>`,
    )
  }

  // CP 竖线 + 圆点 + 名称(按 row 错开,避免密集 CP 的标签重叠)
  const rowHeight = 14
  for (const cpLabel of cpLabels) {
    parts.push(`<line x1="${cpLabel.x}" y1="${g.plot.y0}" x2="${cpLabel.x}" y2="${g.plot.y1}" stroke="#dc2626" stroke-width="1" stroke-dasharray="3,3"/>`)
    parts.push(`<circle cx="${cpLabel.x}" cy="${g.plot.y0}" r="3" fill="#dc2626"/>`)
    const labelY = g.plot.y0 - 10 - cpLabel.row * rowHeight
    parts.push(`<text x="${cpLabel.x}" y="${labelY}" font-size="11" fill="#991b1b" text-anchor="middle">${escapeXml(cpLabel.name)}</text>`)
  }

  parts.push('</svg>')
  return parts.join('')
}

/** `computeProfileChartModel` + `svgFromProfileChartModel` 的便捷组合——
 * 大多数调用方(UI 导出按钮、Excel 嵌图)只需要这一个函数。 */
export function buildElevationProfileSvg(track: Track, cps: CheckPoint[], opts: ProfileChartOptions = {}): string {
  return svgFromProfileChartModel(computeProfileChartModel(track, cps, opts))
}

/**
 * 把同一份 `ProfileChartModel` 绘制到一个已经按 `scale` 放大过的 2D
 * canvas 上下文——和 `svgFromProfileChartModel` 逐项对应同一批坐标/刻度/
 * 标签,只是渲染 API 换成 canvas 调用。不在 Node 下单测(项目约定:canvas
 * 光栅化不在 Node/Vitest 环境验证,只测到 model 这一层)。
 */
function drawProfileChartModelToCanvas(ctx: CanvasRenderingContext2D, model: ProfileChartModel): void {
  const { widthPx, heightPx, geometry: g, points, distanceTicksKm, elevationTicks, cpLabels, segmentAnnotations } = model

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, widthPx, heightPx)

  ctx.fillStyle = '#111827'
  ctx.font = '600 14px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(`${model.trackName} 高差图`, g.margin.left, 18)

  ctx.fillStyle = '#374151'
  ctx.font = '12px sans-serif'
  ctx.textAlign = 'right'
  ctx.fillText(
    `累计爬升 ${Math.round(model.totalGainM)}m · 累计下降 ${Math.round(model.totalLossM)}m · 全程 ${(model.totalDistM / 1000).toFixed(1)}km`,
    widthPx - g.margin.right,
    18,
  )

  ctx.strokeStyle = '#e5e7eb'
  ctx.lineWidth = 1
  ctx.fillStyle = '#4b5563'
  ctx.font = '11px sans-serif'
  for (const ele of elevationTicks) {
    const y = g.toY(ele)
    ctx.beginPath()
    ctx.moveTo(g.plot.x0, y)
    ctx.lineTo(g.plot.x1, y)
    ctx.stroke()
    ctx.textAlign = 'right'
    ctx.fillText(`${Math.round(ele)}m`, g.plot.x0 - 8, y + 4)
  }
  ctx.strokeStyle = '#f3f4f6'
  for (const km of distanceTicksKm) {
    const x = g.toX(km * 1000)
    ctx.beginPath()
    ctx.moveTo(x, g.plot.y0)
    ctx.lineTo(x, g.plot.y1)
    ctx.stroke()
    ctx.textAlign = 'center'
    ctx.fillText(`${km}km`, x, g.plot.y1 + 16)
  }
  ctx.strokeStyle = '#9ca3af'
  ctx.strokeRect(g.plot.x0, g.plot.y0, g.plot.x1 - g.plot.x0, g.plot.y1 - g.plot.y0)

  const baselineY = g.plot.y1
  for (const run of splitFiniteRuns(points)) {
    if (run.length === 0) continue
    ctx.beginPath()
    ctx.moveTo(run[0].x, baselineY)
    for (const p of run) ctx.lineTo(p.x, p.y)
    ctx.lineTo(run[run.length - 1].x, baselineY)
    ctx.closePath()
    ctx.fillStyle = 'rgba(147, 197, 253, 0.45)'
    ctx.fill()

    ctx.beginPath()
    run.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
    ctx.strokeStyle = '#2563eb'
    ctx.lineWidth = 2
    ctx.stroke()
  }

  ctx.fillStyle = '#6b7280'
  ctx.font = '10px sans-serif'
  for (const seg of segmentAnnotations) {
    const label = seg.segTimeSec !== undefined
      ? `${seg.netSlopePct >= 0 ? '+' : ''}${seg.netSlopePct.toFixed(1)}% · ${formatDurationHM(seg.segTimeSec)}`
      : `${seg.netSlopePct >= 0 ? '+' : ''}${seg.netSlopePct.toFixed(1)}%`
    ctx.save()
    ctx.translate(seg.xAtEnd, g.plot.y0 - 6)
    ctx.rotate((-30 * Math.PI) / 180)
    ctx.textAlign = 'right'
    ctx.fillText(label, 0, 0)
    ctx.restore()
  }

  const rowHeight = 14
  for (const cpLabel of cpLabels) {
    ctx.strokeStyle = '#dc2626'
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(cpLabel.x, g.plot.y0)
    ctx.lineTo(cpLabel.x, g.plot.y1)
    ctx.stroke()
    ctx.setLineDash([])

    ctx.fillStyle = '#dc2626'
    ctx.beginPath()
    ctx.arc(cpLabel.x, g.plot.y0, 3, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = '#991b1b'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(cpLabel.name, cpLabel.x, g.plot.y0 - 10 - cpLabel.row * rowHeight)
  }
}

export interface ProfilePngOptions extends ProfileChartOptions {
  /** 输出分辨率倍率——方案要求"4× 设备缩放",默认即 4。 */
  pngScale?: number
}

/**
 * 渲染 4× 分辨率 PNG(用于粘贴进文档)。只能在浏览器环境调用(依赖真实
 * canvas 2D 上下文),不在 Node/Vitest 下单测——见本文件顶部注释。
 */
export async function renderElevationProfilePng(
  track: Track,
  cps: CheckPoint[],
  opts: ProfilePngOptions = {},
): Promise<Blob> {
  const model = computeProfileChartModel(track, cps, opts)
  const scale = opts.pngScale ?? DEFAULT_PNG_SCALE

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(model.widthPx * scale)
  canvas.height = Math.round(model.heightPx * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法获取 canvas 2D 绘图上下文，当前环境不支持导出 PNG')
  ctx.scale(scale, scale)
  drawProfileChartModelToCanvas(ctx, model)

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('PNG 生成失败'))
    }, 'image/png')
  })
}
