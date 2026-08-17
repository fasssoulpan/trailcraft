/**
 * 高差图(SVG / PNG)共用的纯几何层——P3-R1 commit 1。
 *
 * 刻意和实际渲染(SVG 字符串拼接 / canvas 绘制)分离成单独文件:这里的每一
 * 个函数都只做数字换算,不产出任何标记语言或 canvas 调用,因此可以在 Node
 * 下直接单测(里程/海拔 → 像素坐标的映射、坐标轴刻度选择、CP label 避让)。
 * `profileGraphic.ts` 的 SVG 构建函数和 PNG 画布绘制函数都从同一个
 * `computeProfileGeometry`/`computeProfilePoints` 结果取数——这是保证两种
 * 输出格式不会画出两条不同曲线的关键:两者永远读同一份已经算好的坐标,不是
 * 各自从原始数据重新算一遍。
 */
import type { ProfileData } from '../../profile/profileRender'

export interface Margin {
  top: number
  right: number
  bottom: number
  left: number
}

/** 默认边距:左侧留给海拔轴标签,底部留给里程轴标签 + 图例。 */
export const DEFAULT_MARGIN: Margin = { top: 28, right: 24, bottom: 44, left: 60 }

export interface ProfileGeometry {
  widthPx: number
  heightPx: number
  margin: Margin
  /** 纵轴映射用的海拔范围(已加过内边距,不等于 profile.minEle/maxEle 本身)。 */
  minEle: number
  maxEle: number
  totalDistM: number
  /** 绘图区(坐标轴内侧矩形)边界,像素。 */
  plot: { x0: number; y0: number; x1: number; y1: number }
  /** 累计里程(米)→ 像素 x。 */
  toX(distM: number): number
  /** 海拔(米)→ 像素 y(y 向下增长,和 SVG/canvas 坐标系一致)。 */
  toY(eleM: number): number
}

/**
 * 构建几何映射。`profile.totalDist <= 0`(单点轨迹/里程恒为 0)与
 * `profile.minEle === profile.maxEle`(平坦轨迹)都不做除法分支——`toX`/
 * `toY` 内部对跨度为 0 的情况各自兜底,不产生 NaN/Infinity。
 */
export function computeProfileGeometry(
  profile: ProfileData,
  widthPx: number,
  heightPx: number,
  margin: Margin = DEFAULT_MARGIN,
): ProfileGeometry {
  const x0 = margin.left
  const x1 = Math.max(widthPx - margin.right, x0 + 1)
  const y0 = margin.top
  const y1 = Math.max(heightPx - margin.bottom, y0 + 1)
  const plotW = x1 - x0
  const plotH = y1 - y0

  const totalDistM = profile.totalDist
  // 海拔范围加 8% 内边距,让折线不贴着图表上下边缘;全平轨迹(span===0)则
  // 退化成固定 10m 的对称留白,同样避免除以 0。
  const eleSpan = profile.maxEle - profile.minEle
  const pad = eleSpan > 0 ? eleSpan * 0.08 : 10
  const minEle = profile.minEle - pad
  const maxEle = profile.maxEle + pad
  const eleRange = maxEle - minEle

  function toX(distM: number): number {
    const t = totalDistM > 0 ? distM / totalDistM : 0
    return x0 + Math.min(Math.max(t, 0), 1) * plotW
  }
  function toY(eleM: number): number {
    const t = eleRange > 0 ? (eleM - minEle) / eleRange : 0.5
    return y0 + (1 - Math.min(Math.max(t, 0), 1)) * plotH
  }

  return { widthPx, heightPx, margin, minEle, maxEle, totalDistM, plot: { x0, y0, x1, y1 }, toX, toY }
}

export interface ProfilePoint {
  x: number
  y: number
  distM: number
  /** 原始(可能为 NaN)海拔读数。 */
  eleM: number
  /** eleM 是否为有限数——单点海拔缺失时 y 会退化落在图表底部,渲染层必须
   * 用这个标志决定要不要连线/要不要在该点断开,而不是把退化坐标当真实数据画。 */
  finite: boolean
}

/** 把抽稀后的 profile 采样点整体投影成像素坐标——SVG 折线/填充路径和 canvas
 * 逐点 lineTo 调用共同的数据源。 */
export function computeProfilePoints(profile: ProfileData, geom: ProfileGeometry): ProfilePoint[] {
  const pts: ProfilePoint[] = []
  for (let i = 0; i < profile.dist.length; i++) {
    const eleM = profile.ele[i]
    const finite = Number.isFinite(eleM)
    pts.push({
      x: geom.toX(profile.dist[i]),
      y: geom.toY(finite ? eleM : geom.minEle),
      distM: profile.dist[i],
      eleM,
      finite,
    })
  }
  return pts
}

// ── 坐标轴刻度选择("nice numbers" 算法,d3-ticks 同款思路) ──────────────

/** 把一个跨度归到 1/2/5 × 10^n 的"整齐"数量级上。`round=true` 用于步长本身
 * (允许四舍五入到最近的 1/2/5),`round=false` 用于总跨度(必须保证覆盖,
 * 只能向上取整到 1/2/5/10)。 */
function niceNum(range: number, round: boolean): number {
  if (range <= 0) return 1
  const exponent = Math.floor(Math.log10(range))
  const fraction = range / Math.pow(10, exponent)
  let niceFraction: number
  if (round) {
    if (fraction < 1.5) niceFraction = 1
    else if (fraction < 3) niceFraction = 2
    else if (fraction < 7) niceFraction = 5
    else niceFraction = 10
  } else {
    if (fraction <= 1) niceFraction = 1
    else if (fraction <= 2) niceFraction = 2
    else if (fraction <= 5) niceFraction = 5
    else niceFraction = 10
  }
  return niceFraction * Math.pow(10, exponent)
}

/**
 * 在 [min, max] 区间内生成大致 targetCount 个"整齐"刻度值,首尾覆盖整个
 * 区间(可能略微超出 min/max,这是 nice-ticks 算法的正常行为——调用方按
 * 需要自行裁剪)。`min === max`(退化区间)直接返回该单值,不做除以 0 的
 * 步长计算。
 */
export function niceTicks(min: number, max: number, targetCount: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || targetCount <= 0) return []
  if (min === max) return [min]
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  const range = niceNum(hi - lo, false)
  const step = niceNum(range / Math.max(targetCount - 1, 1), true)
  const niceMin = Math.floor(lo / step) * step
  const niceMax = Math.ceil(hi / step) * step
  const ticks: number[] = []
  // 1e-9 * step 的容差:纯浮点累加到 niceMax 时可能因舍入差一点点够不到,
  // 漏掉本该包含的最后一个刻度。
  for (let v = niceMin; v <= niceMax + step * 1e-6; v += step) {
    ticks.push(Math.round(v / step) * step)
  }
  return ticks
}

/** 里程轴刻度(公里),裁剪到 [0, totalDistM 对应的公里数] 之内——图表横轴
 * 就是这段范围,超出的刻度没有意义。`totalDistM <= 0` 时只有一个 0 刻度。 */
export function selectDistanceTicksKm(totalDistM: number, targetCount = 6): number[] {
  const totalKm = totalDistM / 1000
  if (!(totalKm > 0)) return [0]
  return niceTicks(0, totalKm, targetCount).filter((t) => t >= -1e-9 && t <= totalKm + 1e-9)
}

/** 海拔轴刻度(米)。不裁剪到 [minEle, maxEle] 之外——和里程轴不同,海拔轴
 * 允许刻度略微超出数据范围(这正是留白的意义),调用方按 geometry 里已经
 * 加过内边距的 minEle/maxEle 传入即可让刻度和绘图区上下边界对齐。 */
export function selectElevationTicks(minEle: number, maxEle: number, targetCount = 5): number[] {
  return niceTicks(minEle, maxEle, targetCount)
}

// ── CP 标签避让 ─────────────────────────────────────────────────────────

export interface CpLabelInput {
  id: string
  name: string
  distM: number
}

export interface CpLabelPlacement {
  id: string
  name: string
  distM: number
  x: number
  /** 从 0 开始的行号——同一行内任意两个 label 的像素间距都 >= minGapPx;
   * 相邻两个 CP 里程太近时,后一个会被挤到 row 1、2……而不是和前一个重叠。 */
  row: number
}

/**
 * 贪心避让:按里程升序处理每个 CP,把它放进"和该行最后一个已放置 label 的
 * 水平间距 >= minGapPx"的第一行;放不下就另开新行。由于处理顺序已经按里程
 * 排序,"该行最后一个"就是该行里离当前 CP 最近、最可能冲突的那个,这个贪心
 * 策略对一维区间标签避让是最优的(等价于经典的区间图着色贪心解法)。
 */
export function placeCpLabels(cps: CpLabelInput[], geom: { toX(distM: number): number }, minGapPx = 44): CpLabelPlacement[] {
  const sorted = [...cps].sort((a, b) => a.distM - b.distM).map((c) => ({ ...c, x: geom.toX(c.distM) }))
  const rowLastX: number[] = []
  const placements: CpLabelPlacement[] = []
  for (const c of sorted) {
    let row = 0
    while (row < rowLastX.length && c.x - rowLastX[row] < minGapPx) row++
    rowLastX[row] = c.x
    placements.push({ id: c.id, name: c.name, distM: c.distM, x: c.x, row })
  }
  return placements
}
