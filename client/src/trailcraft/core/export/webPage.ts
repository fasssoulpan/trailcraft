/**
 * 自包含交互网页导出——P3-R4(方案 V2.1 §5.7「分享的第二形态:自包含交互
 * 网页」)。分享闭环的另一半:视频负责引流("这条路线看起来不错"),这个
 * 单文件 HTML 负责深度查看("这条路线具体怎么走、爬升多大、几点前必须到
 * CP")——两者互补,详见本文件调用方 `ui/ExportPanel.tsx` 的按钮分组。
 *
 * 本文件只产出**数据模型**(`buildWebPagePayload`)和**纯字符串模板**
 * (`renderWebPageHtml`/`buildInteractiveWebPage`),不碰 DOM、不需要浏览器
 * 环境——和 `profileGraphic.ts` 的 `computeProfileChartModel`/
 * `svgFromProfileChartModel` 是同一种"计算与渲染分离"结构,可以在 Node 下
 * 完整单测。生成的 HTML 里内嵌的地图/悬停联动脚本是普通字符串,不在这里
 * (也不可能在 Node/Vitest 下)执行——那部分靠 tests 里的静态断言(不含
 * `http(s)://` 的 script/style/font 引用、payload 形状等)和人工在浏览器里
 * 验证,与 `profileGraphic.ts` 顶部注释里"canvas 光栅化不在 Node 下单测"是
 * 同一个项目约定的延伸。
 *
 * ## 地图图层选型(任务书要求"deliberately choose, say why")
 *
 * 三个选项权衡过:
 *  1. **内嵌 MapLibre GL**——方案要求的可平移/缩放交互效果最接近今天规划
 *     模式的体验,但 MapLibre 本身(压缩前)就有数百 KB,还需要额外的字体/
 *     sprite 资源才能显示注记,和"单文件、离线优先"的目标直接冲突,任务书
 *     已经明确否决。
 *  2. **纯 SVG 渲染轨迹,不叠加底图**——完全离线可用,文件最小,但陌生人
 *     打开分享链接时看到的是一条脱离地理背景的线,不知道这是哪座山、路线
 *     经过什么地形,"深度查看"的价值大打折扣。
 *  3.(**选中**)**手写一个几百行的最小滑动地图**:用一段内联 vanilla JS
 *     实现 Web Mercator 投影 + canvas 绘制,直接向瓦片服务器(复用
 *     `map/basemapStyle.ts` 已经在用的 OSM 光栅瓦片,同一个 URL 模板、同一
 *     句版权文案)请求 PNG 瓦片贴到 canvas 上,轨迹折线和 CP 标记用 canvas
 *     矢量绘制叠加在瓦片之上。比选项 1 轻(生成的脚本本身只有几 KB,是
 *     "打包一个库"和"手写需要的那一小部分逻辑"之间数量级的差异),比选项 2
 *     有用(陌生人能看清路线在地图上的实际位置)。
 *
 *     代价是这条路线需要网络才能看到瓦片——诚实地承认这一点:瓦片服务器
 *     不可达时(`file://` 打开、离线、瓦片域名被墙……),内联脚本只是让
 *     `<img>` 的 `onerror` 静默跳过那一块瓦片(canvas 背景退化成纯色),
 *     轨迹折线、CP 标记、悬停联动、高差图 SVG、检查点列表——这些不依赖网络
 *     的部分照常渲染,不受影响,并显式提示"地图瓦片加载失败"，而不是让整个
 *     页面白屏——这正是任务书要求的"the failure mode honest, exactly as the
 *     main app already degrades"（对照 `map/trackLayer.ts` 的瓦片错误监听/
 *     `state/basemapPref.ts` 的降级思路）。
 *
 * ## 坐标精度与抽稀(任务书标注为"the central constraint")
 *
 * `DEFAULT_MAX_POINTS`/`DEFAULT_COORD_PRECISION` 的选择依据见各自的文档
 * 注释;`buildWebPagePayload` 的调用方(`ui/ExportPanel.tsx`)会在生成后
 * 实测最终 HTML 字节数,超出阈值时提示用户改用更低的 maxPoints 重新生成，
 * 而不是默默产出一个几十 MB、浏览器打开都费劲的文件。
 */
import type { Track } from '../model/track'
import type { CheckPoint, CpKind } from '../model/checkpoint'
import { CP_KIND_LABELS } from '../model/checkpoint'
import type { PaceParams, WarnLevel } from '../pace/models'
import type { StatsOptions } from '../stats/segments'
import { computeSegments } from '../stats/segments'
import { sortCpsByAnchor } from '../stats/cutoffAlign'
import { buildRouteBookRows } from './routeBookData'
import { computeProfileChartModel, svgFromProfileChartModel } from './profileGraphic'
import { decimateIndices } from '../toolbox/decimate'
import { DEFAULT_LINE_WIDTH } from '../model/trackStyle'
import { formatClockHM } from './timeFormat'
import { WARN_LEVEL_LABELS } from '../pace/models'
import { OSM_ATTRIBUTION, OSM_TILE_URL_TEMPLATE } from '../../map/basemapStyle'

export class WebPageDataError extends Error {}

/**
 * 抽稀目标点数——330k 点的真实轨迹(任务书举例)抽到这个数量级后,在典型
 * 分享场景的屏幕宽度(手机到桌面显示器,几百到两千多 CSS 像素)下已经是
 * "每像素多个采样点"，肉眼看不出和全精度的差别；抽稀去掉的多是野外轨迹里
 * 大量近乎共线的冗余 GPS 点，路线形状本身不会因此失真。选 4000 而不是更
 * 保守的 1 万+，是因为地图画布通常只占屏幕一部分（不是整页宽度），有效
 * 渲染宽度往往只有几百像素，4000 点已经远超这个宽度的可分辨密度上限。
 */
export const DEFAULT_MAX_POINTS = 4000

/**
 * 坐标小数位数——5 位小数纬度方向恒为约 1.11m 精度，经度方向随纬度收窄
 * （× cos(lat)，实际更精细，1.11m 是保守上界）。6 位小数（约 0.11m）对一条
 * "分享出去给人看大致怎么走"的路线是过度精度：地图瓦片本身在常见分享场景
 * 的缩放级别下，每像素代表的地面距离通常就有数米，1m 级别的坐标误差在
 * 屏幕上完全不可辨。5 位小数还能让 JSON 里的数字字符串少一位数字，几千个
 * 坐标点累积下来是有意义的体积节省。见 `tests/core/export/webPage.test.ts`
 * 里对舍入误差的实测断言。
 */
export const DEFAULT_COORD_PRECISION = 5

export interface WebPageOptions {
  maxPoints?: number
  coordPrecision?: number
  statsOptions?: StatsOptions
  paceParams?: PaceParams
  raceStartTimeIso?: string
  /**
   * 是否把检查点的 `photoUrl`(缩放后的 JPEG data URI,见 `core/photo/
   * attachPhoto.ts`)内嵌进导出网页。默认 `true`。
   *
   * P3-R5 commit 1 补的缺口:抽稀(`maxPoints`)只改变路线点数组的体积,
   * 对 `photoUrl` 这种整段塞进 payload 的字符串完全没有影响——一条 CP 照片
   * 常常就是几十到上百 KB,几个 CP 带照片就能让体积超标,此时"降低精度"
   * 这个补救对用户毫无用处(点几次都不会变小,体验上是死循环)。`false` 时
   * 每个检查点的 `photoUrl` 被置为 `undefined`,不进入 payload、不出现在
   * 导出网页里——`ExportPanel.tsx` 靠 `computeWebPageSizeBreakdown` 判断
   * 体积超标主要来自照片还是路线数据,再决定提示用户走这条路径还是
   * `maxPoints` 那条。
   */
  includePhotos?: boolean
}

export interface WebPageTrackSeries {
  /** 抽稀后、四舍五入到 `coordPrecision` 位小数的经度序列。 */
  lon: number[]
  lat: number[]
  /**
   * 抽稀后每个保留点的**真实**累计里程(米，取自全精度 `track.points.
   * cumDist`，取整)——不是从抽稀后的折线重新算一遍。抽稀会让折线弦长比
   * 实际路径短（尤其弯道多的越野赛道），如果地图<->高差图悬停联动用"抽稀
   * 折线自己的弦长"当里程，会随里程增加逐渐和高差图的真实里程刻度错位；
   * 直接搬运全精度里程就没有这个问题。
   */
  distM: number[]
  /** 只有轨迹本身有海拔列时才存在；取整到米，供悬停提示显示海拔用。 */
  eleM: number[] | undefined
}

export interface WebPageCheckpoint {
  name: string
  kind: CpKind
  kindLabel: string
  lon: number
  lat: number
  /** 沿全精度轨迹的真实累计里程（米），供悬停/点击后地图定位使用。 */
  distM: number
  photoUrl: string | undefined
}

/** 表格行——每行对应 `computeSegments` 切出的一段，字段已经在生成期格式化
 * 成展示字符串（复用 `timeFormat.ts`），客户端脚本不需要重新实现一遍时刻/
 * 时长格式化逻辑。没有海拔时 `gainM`/`lossM` 是 `undefined`（渲染成
 * "--"），不用 0 冒充"没有爬升"——与 `routeBookData.ts` 拒绝在没有海拔时
 * 生成路书是同一条原则,只是这里的容错边界更宽(路书要求至少一个 CP 才
 * 拒绝；这个网页允许零 CP，此时只有一行"起点 → 终点"）。 */
export interface WebPageSegmentRow {
  label: string
  distKm: string
  gainM: string | undefined
  lossM: string | undefined
  etaLabel: string
  cutoffLabel: string
  levelLabel: string
  level: WarnLevel | undefined
}

export interface WebPagePayload {
  trackName: string
  generatedAtLabel: string
  summary: {
    distKm: string
    gainM: string | undefined
    lossM: string | undefined
  }
  track: WebPageTrackSeries
  checkpoints: WebPageCheckpoint[]
  segments: WebPageSegmentRow[]
  /** 复用 `profileGraphic.ts` 产出的 SVG 字符串；轨迹没有海拔时为
   * `undefined`——页面必须省略高差图区块而不是硬渲染一张空图表。 */
  profileSvg: string | undefined
  /** 高差图几何的三个数字，供内联脚本把"鼠标在 SVG 上的像素 x"换算成
   * "沿途里程"，从而联动地图悬停点——直接复用 `computeProfileChartModel`
   * 算出的同一份几何，不在网页脚本里重新推导一次映射公式。 */
  profileGeom: { x0: number; x1: number; totalDistM: number } | undefined
  trackStyle: { color: string; lineWidth: number }
  basemapAttribution: string
  basemapTileUrlTemplate: string
  dataCredits: string[]
}

function roundTo(v: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

function formatDateTimeLabel(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDistKm(distM: number): string {
  return (distM / 1000).toFixed(2)
}

/**
 * 构建交互网页的完整数据模型。只要求 `track.points.cumDist` 存在（任何
 * 一条线都至少得有里程才谈得上"路线预览"）；海拔、CP 都允许缺失，分别退化
 * 成"省略高差图区块"和"检查点列表为空、只有一行起点到终点的分段"，而不是
 * 抛错——比 `buildRouteBookData` 的前置条件更宽松是刻意的：那个函数服务
 * "路书"这个以 CP 为核心的产物，零 CP 没有意义；这个网页首先是"这条路线
 * 长什么样"的可视化，CP/海拔只是锦上添花的附加信息。
 */
export function buildWebPagePayload(track: Track, cps: CheckPoint[], opts: WebPageOptions = {}): WebPagePayload {
  const cumDist = track.points.cumDist
  if (!cumDist) throw new WebPageDataError('该轨迹缺少里程数据，无法生成交互网页')

  const n = track.points.lon.length
  const maxPoints = opts.maxPoints ?? DEFAULT_MAX_POINTS
  const precision = opts.coordPrecision ?? DEFAULT_COORD_PRECISION
  const idx = decimateIndices(n, maxPoints)

  const lon: number[] = new Array(idx.length)
  const lat: number[] = new Array(idx.length)
  const distM: number[] = new Array(idx.length)
  const eleM: number[] | undefined = track.points.ele ? new Array(idx.length) : undefined
  for (let i = 0; i < idx.length; i++) {
    const srcIdx = idx[i]
    lon[i] = roundTo(track.points.lon[srcIdx], precision)
    lat[i] = roundTo(track.points.lat[srcIdx], precision)
    distM[i] = Math.round(cumDist[srcIdx])
    if (eleM && track.points.ele) eleM[i] = Math.round(track.points.ele[srcIdx])
  }

  const trackCps = cps.filter((c) => c.trackId === track.id)
  const sortedCps = sortCpsByAnchor(trackCps)
  const statsOptions = opts.statsOptions ?? {}
  const segments = computeSegments(track, sortedCps, statsOptions)
  const { rows, totalDistM, totalGainM, totalLossM } = buildRouteBookRows(
    segments,
    sortedCps,
    opts.paceParams,
    opts.raceStartTimeIso,
  )

  const hasElevation = !!track.points.ele
  const includePhotos = opts.includePhotos ?? true
  const cpCoordN = track.points.lon.length
  const checkpoints: WebPageCheckpoint[] = sortedCps.map((cp) => {
    const anchor = Math.min(Math.max(cp.anchorIndex, 0), cpCoordN - 1)
    return {
      name: cp.name,
      kind: cp.kind,
      kindLabel: CP_KIND_LABELS[cp.kind],
      lon: roundTo(track.points.lon[anchor], precision),
      lat: roundTo(track.points.lat[anchor], precision),
      distM: Math.round(cumDist[anchor]),
      photoUrl: includePhotos ? cp.photoUrl : undefined,
    }
  })

  const segmentRows: WebPageSegmentRow[] = rows.map((r) => ({
    label: `${r.fromName} → ${r.toName}`,
    distKm: formatDistKm(r.distM),
    gainM: hasElevation ? Math.round(r.gain).toString() : undefined,
    lossM: hasElevation ? Math.round(r.loss).toString() : undefined,
    etaLabel: r.etaMs !== undefined ? formatClockHM(r.etaMs) : '--',
    cutoffLabel: r.cutoffMs !== undefined ? formatClockHM(r.cutoffMs) : '--',
    levelLabel: r.level !== undefined ? WARN_LEVEL_LABELS[r.level] : '--',
    level: r.level,
  }))

  let profileSvg: string | undefined
  let profileGeom: WebPagePayload['profileGeom']
  if (track.points.ele) {
    const model = computeProfileChartModel(track, cps, {
      statsOptions,
      paceParams: opts.paceParams,
      raceStartTimeIso: opts.raceStartTimeIso,
    })
    profileSvg = svgFromProfileChartModel(model)
    profileGeom = { x0: model.geometry.plot.x0, x1: model.geometry.plot.x1, totalDistM: model.totalDistM }
  }

  return {
    trackName: track.meta.name,
    generatedAtLabel: formatDateTimeLabel(new Date()),
    summary: {
      distKm: formatDistKm(totalDistM),
      gainM: hasElevation ? Math.round(totalGainM).toString() : undefined,
      lossM: hasElevation ? Math.round(totalLossM).toString() : undefined,
    },
    track: { lon, lat, distM, eleM },
    checkpoints,
    segments: segmentRows,
    profileSvg,
    profileGeom,
    trackStyle: { color: track.meta.color ?? '#2563eb', lineWidth: track.meta.lineWidth ?? DEFAULT_LINE_WIDTH },
    basemapAttribution: OSM_ATTRIBUTION,
    basemapTileUrlTemplate: OSM_TILE_URL_TEMPLATE,
    // 和 `overlay/exportCredits.ts` 保持同一种措辞习惯（"影像数据 © ...")，
    // 但不直接调用那个模块：它的分支逻辑（MapTiler/Esri 地形选择）是三维
    // 巡游导出专用的，这张网页的底图选型是固定的、单一的 OSM 光栅瓦片
    // （见 `map/basemapStyle.ts`），套用那套地形/影像判断反而会引入一堆
    // 这里永远不会触发的分支。
    dataCredits: [`影像数据 ${OSM_ATTRIBUTION}`],
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** JSON 内联进 `<script>` 前的转义：`</script`（不区分大小写）会提前截断
 * 脚本标签，U+2028/U+2029 是合法 JSON 字符但曾在部分 JS 引擎里被当作行
 * 结束符处理，不转义可能在极端输入下产出语法错误的内联脚本。 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/**
 * 页面样式——写成一个纯字符串函数（而不是内联在模板里东一段西一段），是
 * 任务书"Write its inline CSS/JS as a template in TypeScript so it is
 * version-controlled and reviewable"的直接要求：单独一个函数，改动能在
 * diff 里看清楚改了什么。系统字体栈、无外部字体请求——这也是"自包含"的
 * 一部分,不只是脚本/瓦片没有外部依赖。
 */
export function buildWebPageStyle(): string {
  return `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #f3f4f6; color: #111827; line-height: 1.5;
}
.tc-page { max-width: 960px; margin: 0 auto; padding: 12px 12px 32px; }
.tc-header { padding: 8px 4px 16px; }
.tc-header h1 { font-size: 1.35rem; margin: 0 0 4px; word-break: break-word; }
.tc-header .tc-meta { font-size: 0.8rem; color: #6b7280; }
.tc-summary { display: flex; gap: 8px; flex-wrap: wrap; margin: 0 0 16px; }
.tc-stat { flex: 1 1 100px; background: #fff; border-radius: 10px; padding: 10px 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
.tc-stat .tc-stat-label { font-size: 0.72rem; color: #6b7280; }
.tc-stat .tc-stat-value { font-size: 1.15rem; font-weight: 600; margin-top: 2px; }
.tc-card { background: #fff; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.06); margin-bottom: 16px; overflow: hidden; }
.tc-card h2 { font-size: 1rem; margin: 0; padding: 12px 14px; border-bottom: 1px solid #f0f1f3; }
.tc-map-wrap { position: relative; height: 52vh; min-height: 320px; max-height: 560px; background: #dbe4ea; touch-action: none; }
.tc-map-canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
.tc-map-controls { position: absolute; right: 10px; top: 10px; display: flex; flex-direction: column; gap: 6px; z-index: 2; }
.tc-map-btn { width: 34px; height: 34px; border-radius: 8px; border: none; background: rgba(255,255,255,0.92); box-shadow: 0 1px 3px rgba(0,0,0,0.25); font-size: 1.1rem; line-height: 1; cursor: pointer; }
.tc-map-btn:active { background: #e5e7eb; }
.tc-map-attribution { position: absolute; right: 6px; bottom: 4px; font-size: 0.62rem; color: #374151; background: rgba(255,255,255,0.78); padding: 1px 5px; border-radius: 4px; z-index: 2; }
.tc-map-warning { position: absolute; left: 8px; top: 8px; right: 8px; z-index: 2; background: rgba(220,38,38,0.92); color: #fff; font-size: 0.72rem; padding: 6px 8px; border-radius: 6px; }
.tc-profile-wrap { padding: 8px 10px 12px; }
.tc-profile-wrap svg { width: 100%; height: auto; display: block; }
.tc-empty { padding: 12px 14px; color: #6b7280; font-size: 0.85rem; }
.tc-table-scroll { overflow-x: auto; }
table.tc-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; min-width: 560px; }
table.tc-table th, table.tc-table td { padding: 7px 10px; text-align: left; border-bottom: 1px solid #f0f1f3; white-space: nowrap; }
table.tc-table th { color: #6b7280; font-weight: 500; background: #fafafa; position: sticky; top: 0; }
table.tc-table tr[data-lon] { cursor: pointer; }
table.tc-table tr[data-lon]:active { background: #f3f4f6; }
.tc-level { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.72rem; color: #fff; }
.tc-level--green { background: #16a34a; }
.tc-level--yellow { background: #ca8a04; }
.tc-level--red { background: #dc2626; }
.tc-credits { font-size: 0.7rem; color: #9ca3af; padding: 4px 6px 20px; text-align: center; }
.tc-credits div { margin-top: 2px; }
@media (max-width: 480px) {
  .tc-header h1 { font-size: 1.15rem; }
  .tc-stat-value { font-size: 1rem; }
}
`.trim()
}

/**
 * 页面脚本——地图(手写最小滑动地图,见本文件顶部注释)+ 地图↔高差图双向
 * 悬停联动 + 检查点表格点击定位。刻意用 `var`/字符串拼接、不用箭头函数/
 * 模板字符串/可选链——单文件导出希望在尽量旧的手机内置浏览器(不少聊天
 * App 的内置 WebView 版本落后)里也能直接跑,不依赖构建期的语法降级。
 * 没有用到任何外部库,整段脚本本身也是"自包含"承诺的一部分。
 */
export function buildWebPageScript(): string {
  return `
(function () {
  'use strict';
  var DATA = window.__TRAILCRAFT_DATA__;
  var track = DATA.track;
  var n = track.lon.length;
  var TILE_SIZE = 256;
  var MIN_ZOOM = 2, MAX_ZOOM = 18;

  function lon2x(lon, z) { return (lon + 180) / 360 * TILE_SIZE * Math.pow(2, z); }
  function lat2y(lat, z) {
    var rad = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * TILE_SIZE * Math.pow(2, z);
  }
  function x2lon(x, z) { return x / (TILE_SIZE * Math.pow(2, z)) * 360 - 180; }
  function y2lat(y, z) {
    var ny = Math.PI - 2 * Math.PI * y / (TILE_SIZE * Math.pow(2, z));
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(ny) - Math.exp(-ny)));
  }

  var canvas = document.getElementById('tcMapCanvas');
  var mapWrap = document.getElementById('tcMapWrap');
  if (!canvas || !mapWrap || n === 0) return;
  var ctx = canvas.getContext('2d');

  var zoom = 13, centerWx = 0, centerWy = 0;
  var tileCache = {};
  var tileTried = 0, tileFailed = 0, tileWarnShown = false;

  var minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (var bi = 0; bi < n; bi++) {
    if (track.lon[bi] < minLon) minLon = track.lon[bi];
    if (track.lon[bi] > maxLon) maxLon = track.lon[bi];
    if (track.lat[bi] < minLat) minLat = track.lat[bi];
    if (track.lat[bi] > maxLat) maxLat = track.lat[bi];
  }
  if (minLon === maxLon) { minLon -= 0.001; maxLon += 0.001; }
  if (minLat === maxLat) { minLat -= 0.001; maxLat += 0.001; }

  function fitView() {
    var w = canvas.clientWidth || mapWrap.clientWidth || 300;
    var h = canvas.clientHeight || mapWrap.clientHeight || 300;
    var z;
    for (z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
      var spanX = lon2x(maxLon, z) - lon2x(minLon, z);
      var spanY = lat2y(minLat, z) - lat2y(maxLat, z);
      if (spanX <= w * 0.85 && spanY <= h * 0.85) break;
    }
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    centerWx = (lon2x(minLon, zoom) + lon2x(maxLon, zoom)) / 2;
    centerWy = (lat2y(minLat, zoom) + lat2y(maxLat, zoom)) / 2;
  }

  function resizeCanvas() {
    var rect = mapWrap.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function tileUrl(z, x, y) {
    return DATA.basemapTileUrlTemplate.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  }

  function getTile(z, x, y) {
    var max = Math.pow(2, z);
    var xx = ((x % max) + max) % max;
    if (y < 0 || y >= max) return null;
    var key = z + '/' + xx + '/' + y;
    var cached = tileCache[key];
    if (cached) return cached;
    var img = new Image();
    tileTried++;
    img.onload = function () { draw(); };
    img.onerror = function () {
      tileFailed++;
      if (!tileWarnShown && tileTried >= 4 && tileFailed >= tileTried) {
        tileWarnShown = true;
        var w = document.getElementById('tcMapWarning');
        if (w) w.hidden = false;
      }
    };
    img.src = tileUrl(z, xx, y);
    tileCache[key] = img;
    return img;
  }

  function worldToScreen(wx, wy) {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    return [wx - centerWx + w / 2, wy - centerWy + h / 2];
  }
  function screenToWorld(sx, sy) {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    return [sx + centerWx - w / 2, sy + centerWy - h / 2];
  }

  var hoverLonLat = null;
  var KIND_COLORS = { cp: '#1d4ed8', aid: '#16a34a', gear: '#ca8a04', danger: '#dc2626', quit: '#6b7280', landmark: '#9333ea' };

  function drawDot(lon, lat, color, r) {
    var wx = lon2x(lon, zoom), wy = lat2y(lat, zoom);
    var s = worldToScreen(wx, wy);
    ctx.beginPath();
    ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s[0], s[1], Math.max(1, r - 1.5), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  var rafPending = false;
  function requestDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; draw(); });
  }

  function draw() {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#dbe4ea';
    ctx.fillRect(0, 0, w, h);

    var z = Math.round(zoom);
    var topLeft = screenToWorld(0, 0);
    var bottomRight = screenToWorld(w, h);
    var tx0 = Math.floor(topLeft[0] / TILE_SIZE), tx1 = Math.floor(bottomRight[0] / TILE_SIZE);
    var ty0 = Math.floor(topLeft[1] / TILE_SIZE), ty1 = Math.floor(bottomRight[1] / TILE_SIZE);
    for (var tx = tx0; tx <= tx1; tx++) {
      for (var ty = ty0; ty <= ty1; ty++) {
        var img = getTile(z, tx, ty);
        if (img && img.complete && img.naturalWidth > 0) {
          var sx = tx * TILE_SIZE - centerWx + w / 2;
          var sy = ty * TILE_SIZE - centerWy + h / 2;
          ctx.drawImage(img, sx, sy, TILE_SIZE, TILE_SIZE);
        }
      }
    }

    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var wx = lon2x(track.lon[i], z), wy = lat2y(track.lat[i], z);
      var s = worldToScreen(wx, wy);
      if (i === 0) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]);
    }
    ctx.strokeStyle = DATA.trackStyle.color;
    ctx.lineWidth = DATA.trackStyle.lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    drawDot(track.lon[0], track.lat[0], '#16a34a', 6);
    drawDot(track.lon[n - 1], track.lat[n - 1], '#dc2626', 6);
    for (var ci = 0; ci < DATA.checkpoints.length; ci++) {
      var cp = DATA.checkpoints[ci];
      drawDot(cp.lon, cp.lat, KIND_COLORS[cp.kind] || '#1d4ed8', 5);
    }
    if (hoverLonLat) drawDot(hoverLonLat[0], hoverLonLat[1], '#111827', 7);
  }

  function setZoom(newZoomRaw, screenPos) {
    var newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(newZoomRaw)));
    if (newZoom === zoom) return;
    var world = screenToWorld(screenPos[0], screenPos[1]);
    var lon = x2lon(world[0], zoom), lat = y2lat(world[1], zoom);
    zoom = newZoom;
    var wx = lon2x(lon, zoom), wy = lat2y(lat, zoom);
    var w = canvas.clientWidth, h = canvas.clientHeight;
    centerWx = wx - (screenPos[0] - w / 2);
    centerWy = wy - (screenPos[1] - h / 2);
    requestDraw();
  }

  function pointerPos(evt) {
    var rect = canvas.getBoundingClientRect();
    return [evt.clientX - rect.left, evt.clientY - rect.top];
  }

  var pointers = {};
  var dragLast = null;
  var lastPinchDist = null;

  canvas.addEventListener('pointerdown', function (evt) {
    canvas.setPointerCapture(evt.pointerId);
    pointers[evt.pointerId] = pointerPos(evt);
    var ids = Object.keys(pointers);
    if (ids.length === 1) { dragLast = pointers[evt.pointerId]; }
    else { dragLast = null; lastPinchDist = null; }
  });

  canvas.addEventListener('pointermove', function (evt) {
    var pos = pointerPos(evt);
    var ids = Object.keys(pointers);
    if (pointers[evt.pointerId]) { pointers[evt.pointerId] = pos; ids = Object.keys(pointers); }

    if (ids.length >= 2) {
      var p0 = pointers[ids[0]], p1 = pointers[ids[1]];
      var dist = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]);
      var mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      if (lastPinchDist) setZoom(zoom + Math.log(dist / lastPinchDist) / Math.LN2, mid);
      lastPinchDist = dist;
      return;
    }
    if (ids.length === 1 && dragLast) {
      var dx = pos[0] - dragLast[0], dy = pos[1] - dragLast[1];
      centerWx -= dx; centerWy -= dy;
      dragLast = pos;
      requestDraw();
      return;
    }
    if (evt.buttons === 0) handleMapHover(pos);
  });

  function endPointer(evt) {
    delete pointers[evt.pointerId];
    var ids = Object.keys(pointers);
    if (ids.length < 2) lastPinchDist = null;
    dragLast = ids.length === 1 ? pointers[ids[0]] : null;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', function (evt) {
    if (!pointers[evt.pointerId]) { hoverLonLat = null; requestDraw(); clearProfileHover(); }
  });

  canvas.addEventListener('wheel', function (evt) {
    evt.preventDefault();
    setZoom(zoom + (evt.deltaY < 0 ? 1 : -1), pointerPos(evt));
  }, { passive: false });

  canvas.addEventListener('dblclick', function (evt) {
    setZoom(zoom + 1, pointerPos(evt));
  });

  var zoomInBtn = document.getElementById('tcZoomIn');
  var zoomOutBtn = document.getElementById('tcZoomOut');
  if (zoomInBtn) zoomInBtn.addEventListener('click', function () { setZoom(zoom + 1, [canvas.clientWidth / 2, canvas.clientHeight / 2]); });
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', function () { setZoom(zoom - 1, [canvas.clientWidth / 2, canvas.clientHeight / 2]); });

  function lonLatAtDist(distM) {
    if (n === 0) return null;
    if (distM <= track.distM[0]) return [track.lon[0], track.lat[0]];
    if (distM >= track.distM[n - 1]) return [track.lon[n - 1], track.lat[n - 1]];
    for (var i = 1; i < n; i++) {
      if (track.distM[i] >= distM) {
        var d0 = track.distM[i - 1], d1 = track.distM[i];
        var frac = d1 > d0 ? (distM - d0) / (d1 - d0) : 0;
        return [
          track.lon[i - 1] + (track.lon[i] - track.lon[i - 1]) * frac,
          track.lat[i - 1] + (track.lat[i] - track.lat[i - 1]) * frac
        ];
      }
    }
    return [track.lon[n - 1], track.lat[n - 1]];
  }

  function handleMapHover(pos) {
    var best = -1, bestD = Infinity;
    for (var i = 0; i < n; i++) {
      var wx = lon2x(track.lon[i], zoom), wy = lat2y(track.lat[i], zoom);
      var s = worldToScreen(wx, wy);
      var dx = s[0] - pos[0], dy = s[1] - pos[1];
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && bestD < 900) {
      hoverLonLat = [track.lon[best], track.lat[best]];
      setProfileHoverByDist(track.distM[best]);
      requestDraw();
    } else {
      if (hoverLonLat) { hoverLonLat = null; requestDraw(); }
      clearProfileHover();
    }
  }

  var profileSvg = document.querySelector('#tcProfileCard svg');
  var profileGeom = DATA.profileGeom;
  var hoverLine = null;

  function ensureHoverLine() {
    if (!profileSvg || hoverLine) return;
    var svgNS = 'http://www.w3.org/2000/svg';
    hoverLine = document.createElementNS(svgNS, 'line');
    var vb = profileSvg.viewBox.baseVal;
    hoverLine.setAttribute('y1', String(vb.y));
    hoverLine.setAttribute('y2', String(vb.y + vb.height));
    hoverLine.setAttribute('stroke', '#111827');
    hoverLine.setAttribute('stroke-width', '1.5');
    hoverLine.setAttribute('stroke-dasharray', '4,3');
    hoverLine.style.display = 'none';
    profileSvg.appendChild(hoverLine);
  }

  function setProfileHoverByDist(distM) {
    if (!profileSvg || !profileGeom) return;
    ensureHoverLine();
    var t = profileGeom.totalDistM > 0 ? distM / profileGeom.totalDistM : 0;
    t = Math.min(Math.max(t, 0), 1);
    var x = profileGeom.x0 + t * (profileGeom.x1 - profileGeom.x0);
    hoverLine.setAttribute('x1', String(x));
    hoverLine.setAttribute('x2', String(x));
    hoverLine.style.display = '';
  }
  function clearProfileHover() { if (hoverLine) hoverLine.style.display = 'none'; }

  if (profileSvg && profileGeom) {
    profileSvg.style.touchAction = 'none';
    var svgRafPending = false;
    profileSvg.addEventListener('pointermove', function (evt) {
      if (svgRafPending) return;
      svgRafPending = true;
      requestAnimationFrame(function () {
        svgRafPending = false;
        var rect = profileSvg.getBoundingClientRect();
        var vb = profileSvg.viewBox.baseVal;
        if (rect.width <= 0) return;
        var scaleX = vb.width / rect.width;
        var x = (evt.clientX - rect.left) * scaleX + vb.x;
        var t = (x - profileGeom.x0) / (profileGeom.x1 - profileGeom.x0);
        t = Math.min(Math.max(t, 0), 1);
        var distM = t * profileGeom.totalDistM;
        setProfileHoverByDist(distM);
        var ll = lonLatAtDist(distM);
        if (ll) { hoverLonLat = ll; requestDraw(); }
      });
    });
    profileSvg.addEventListener('pointerleave', function () {
      clearProfileHover();
      hoverLonLat = null;
      requestDraw();
    });
  }

  var rows = document.querySelectorAll('#tcSegmentTable tr[data-lon]');
  for (var ri = 0; ri < rows.length; ri++) {
    (function (row) {
      row.addEventListener('click', function () {
        var lon = parseFloat(row.getAttribute('data-lon'));
        var lat = parseFloat(row.getAttribute('data-lat'));
        var wx = lon2x(lon, zoom), wy = lat2y(lat, zoom);
        centerWx = wx; centerWy = wy;
        hoverLonLat = [lon, lat];
        requestDraw();
      });
    })(rows[ri]);
  }

  fitView();
  resizeCanvas();
  draw();
  window.addEventListener('resize', function () { resizeCanvas(); draw(); });
})();
`.trim()
}

/** 把 payload 渲染成完整、单文件、内联全部资源的 HTML 字符串——不含任何
 * `http(s)://` 的 `<script src>`/`<link>`/`@font-face url()` 引用，`file://`
 * 直接双击打开和部署到 GitHub Pages / Cloudflare Pages 效果一致（唯一的
 * 网络请求是地图瓦片本身，且瓦片请求失败时页面其余部分仍完整可用，见本
 * 文件顶部"地图图层选型"一节）。 */
export function renderWebPageHtml(payload: WebPagePayload): string {
  const title = escapeHtml(`${payload.trackName} · 路线预览`)

  const summaryTiles = [
    `<div class="tc-stat"><div class="tc-stat-label">全程距离</div><div class="tc-stat-value">${payload.summary.distKm} km</div></div>`,
    payload.summary.gainM !== undefined
      ? `<div class="tc-stat"><div class="tc-stat-label">累计爬升</div><div class="tc-stat-value">${payload.summary.gainM} m</div></div>`
      : '',
    payload.summary.lossM !== undefined
      ? `<div class="tc-stat"><div class="tc-stat-label">累计下降</div><div class="tc-stat-value">${payload.summary.lossM} m</div></div>`
      : '',
  ].join('')

  const profileSection = payload.profileSvg
    ? `<section class="tc-card" id="tcProfileCard"><h2>高差图</h2><div class="tc-profile-wrap">${payload.profileSvg}</div></section>`
    : `<section class="tc-card"><h2>高差图</h2><p class="tc-empty">该轨迹没有海拔数据，未生成高差图</p></section>`

  const hasElevationCols = payload.segments.some((r) => r.gainM !== undefined)
  const cpLonLatByRowIndex = payload.checkpoints.map((c) => ({ lon: c.lon, lat: c.lat }))
  const segmentRowsHtml = payload.segments
    .map((r, i) => {
      const ll = cpLonLatByRowIndex[i]
      const attrs = ll ? ` data-lon="${ll.lon}" data-lat="${ll.lat}"` : ''
      const levelCell = r.level
        ? `<span class="tc-level tc-level--${r.level}">${escapeHtml(r.levelLabel)}</span>`
        : r.levelLabel
      return (
        `<tr${attrs}>` +
        `<td>${escapeHtml(r.label)}</td>` +
        `<td>${r.distKm}</td>` +
        (hasElevationCols ? `<td>${r.gainM ?? '--'}</td><td>${r.lossM ?? '--'}</td>` : '') +
        `<td>${r.etaLabel}</td><td>${r.cutoffLabel}</td><td>${levelCell}</td>` +
        `</tr>`
      )
    })
    .join('')

  const segmentSection = `
<section class="tc-card">
  <h2>分段路书${payload.checkpoints.length === 0 ? '（未标记检查点）' : ''}</h2>
  <div class="tc-table-scroll">
    <table class="tc-table" id="tcSegmentTable">
      <thead><tr>
        <th>段名</th><th>距离(km)</th>
        ${hasElevationCols ? '<th>爬升(m)</th><th>下降(m)</th>' : ''}
        <th>预计到达</th><th>关门时间</th><th>状态</th>
      </tr></thead>
      <tbody>${segmentRowsHtml}</tbody>
    </table>
  </div>
</section>`

  const uniqueCredits = Array.from(new Set(payload.dataCredits))

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<title>${title}</title>
<style>${buildWebPageStyle()}</style>
</head>
<body>
<div class="tc-page">
  <header class="tc-header">
    <h1>${escapeHtml(payload.trackName)}</h1>
    <div class="tc-meta">由 TrailCraft 生成 · ${escapeHtml(payload.generatedAtLabel)}</div>
  </header>

  <div class="tc-summary">${summaryTiles}</div>

  <section class="tc-card">
    <h2>路线地图</h2>
    <div class="tc-map-wrap" id="tcMapWrap">
      <canvas class="tc-map-canvas" id="tcMapCanvas"></canvas>
      <div class="tc-map-controls">
        <button type="button" class="tc-map-btn" id="tcZoomIn" aria-label="放大">+</button>
        <button type="button" class="tc-map-btn" id="tcZoomOut" aria-label="缩小">&minus;</button>
      </div>
      <div class="tc-map-attribution">${escapeHtml(payload.basemapAttribution)}</div>
      <div class="tc-map-warning" id="tcMapWarning" hidden>地图瓦片加载失败（可能无网络），路线与检查点信息不受影响</div>
    </div>
  </section>

  ${profileSection}

  ${segmentSection}

  <div class="tc-credits">
    ${uniqueCredits.map((c) => `<div>${escapeHtml(c)}</div>`).join('')}
    <div>路线与检查点数据由创建者提供，仅供参考，请以现场实际路标/关门时间为准</div>
  </div>
</div>
<script>window.__TRAILCRAFT_DATA__ = ${jsonForScript(payload)};</script>
<script>${buildWebPageScript()}</script>
</body>
</html>`
}

/** `buildWebPagePayload` + `renderWebPageHtml` 的便捷组合——`ui/
 * ExportPanel.tsx` 只需要这一个函数,和 `buildElevationProfileSvg` 对
 * `computeProfileChartModel`+`svgFromProfileChartModel` 的封装是同一种
 * 模式。 */
export function buildInteractiveWebPage(track: Track, cps: CheckPoint[], opts: WebPageOptions = {}): string {
  return renderWebPageHtml(buildWebPagePayload(track, cps, opts))
}

/** 生成 HTML 的 UTF-8 字节数——`TextEncoder` 在浏览器和现代 Node 都可用，
 * 用它而不是 `.length`（那是 UTF-16 code unit 数，中文字符集下会明显低估
 * 实际字节数，误导"文件多大"的判断）。 */
export function utf8ByteSize(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * 体积超标时,"照片"和"路线数据"这两大块占比各是多少,以及哪一块占了大头
 * ——`ExportPanel.tsx` 用这个结果决定该建议用户走哪条补救路径(降低精度 vs
 * 排除照片),而不是像 P3-R4 那样只有"降低精度"一条路(对纯照片超标的情况
 * 完全无效,用户会陷入"降精度、重新生成、还是超标"的死循环——这正是这个
 * commit 要修的缺口)。
 *
 * 纯函数:只读 `payload.checkpoints[].photoUrl` 和调用方量出来的
 * `totalBytes`(即整份 HTML 的 `utf8ByteSize`),不自己渲染 HTML——
 * `ExportPanel.tsx` 已经为了显示"约 X MB"渲染过一次,这里没必要再渲染
 * 一遍。`photoBytes` 是把每个 CP 的 `photoUrl` 字符串按 UTF-8 字节数加总
 * (data URI 是纯 ASCII base64,和用 `.length` 结果相同,这里仍用
 * `utf8ByteSize` 是为了和 `totalBytes` 的量纲严格一致，不留一个"两种字节
 * 计数方式混用"的隐患)；`routeBytes` 不是单独量出来的,而是
 * `totalBytes - photoBytes`——网页里除照片外的一切(路线点数组、CP 元数据、
 * 高差图 SVG、内联 CSS/JS 模板……)都归进这一类，因为它们都会随
 * `maxPoints` 抽稀或轨迹本身的点数变化，是"降低精度"这个补救唯一能影响到
 * 的部分。
 */
export interface WebPageSizeBreakdown {
  /** 整份导出 HTML 的字节数(调用方传入,通常就是 `utf8ByteSize(html)` 的
   * 结果)。 */
  totalBytes: number
  /** 所有检查点 `photoUrl` 字节数之和。 */
  photoBytes: number
  /** `totalBytes - photoBytes`——路线数据 + 页面模板等其余部分。 */
  routeBytes: number
  /** `photoBytes / totalBytes`,`totalBytes` 为 0 时记 0(不产生 NaN)。 */
  photoShare: number
  /** 哪一部分占了大头,决定 `ExportPanel.tsx` 提示哪条补救路径。 */
  dominant: 'photo' | 'route'
}

/**
 * 占比阈值:达到或超过一半即认定"照片是超标的主因"。0.5 是一个不需要过度
 * 精细化的分界——这个函数只需要在"降低精度"和"排除照片"两条路之间二选一,
 * 不需要给出一个连续的置信度,谁占大头就该优先建议解决谁,50% 是这个二分
 * 决策最直接对应"大头"直觉的分界点。
 */
export const PHOTO_DOMINANT_SHARE = 0.5

export function computeWebPageSizeBreakdown(
  payload: Pick<WebPagePayload, 'checkpoints'>,
  totalBytes: number,
): WebPageSizeBreakdown {
  let photoBytes = 0
  for (const cp of payload.checkpoints) {
    if (cp.photoUrl) photoBytes += utf8ByteSize(cp.photoUrl)
  }
  // 防御性 clamp:理论上 photoBytes(payload 里的一部分)不会超过整份渲染后
  // HTML 的字节数,但两者是分别测量的(一个直接量字符串、一个由调用方传入
  // 整页渲染结果),不假设这层不变式永远成立。
  if (photoBytes > totalBytes) photoBytes = totalBytes
  const routeBytes = totalBytes - photoBytes
  const photoShare = totalBytes > 0 ? photoBytes / totalBytes : 0
  const dominant: 'photo' | 'route' = photoShare >= PHOTO_DOMINANT_SHARE ? 'photo' : 'route'
  return { totalBytes, photoBytes, routeBytes, photoShare, dominant }
}
