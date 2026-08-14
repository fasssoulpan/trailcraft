/**
 * 手绘轨迹:把用户在二维平面图上点出的一串顶点变成一条普通 `Track`
 * (P2 轨迹工具箱新增,响应「轨迹规划……加上手绘功能，基于二维平面图」的
 * 需求)。
 *
 * 刻意保持纯函数、不 import 任何 React/MapLibre/Cesium —— 手绘落地为
 * `Track` 之后,下游的每一样东西(工具箱 split/join/reverse/clean/simplify、
 * CP 锚定、分段表、cutoff 预警、GPX 导出、工程存取、3D 巡游)都不需要知道
 * 这条轨迹是画出来的还是导入的,唯一的区别只是它没有 `time` 列——
 * `core/perf/trackKind.ts` 会因此自动把它判定成 `planned`,这是设计上刻意
 * 依赖的行为,不是需要绕过的限制。
 *
 * `points.ele`/`points.time` 整列 undefined(而不是拿 NaN 填一整列)是
 * `core/model/track.ts` 里明文的列约定——手绘轨迹此刻两列都完全没有意义,
 * 直接不带这两列即可,`createTrack` 在 `pts.ele`/`pts.time` 为 undefined 时
 * 本就不会分配数组。
 */
import { createTrack, type Track, type TrackMeta } from '../model/track'
import { computeCumDist, haversine } from '../geo/distance'

/** 一个手绘顶点,`[经度, 纬度]`,WGS-84。 */
export type Vertex = [number, number]

/**
 * 稠密化间距(米)。手绘顶点之间常常是几米到几公里不等(取决于用户点得多
 * 精细/地图缩放级别),这会让:
 *   - 里程/坡度统计粗糙(两点间被当作一段直线,任何弯曲的路径长度都被低估,
 *     坡度也只能算出顶点之间的平均值,不是逐段的真实变化);
 *   - commit 2 的巡游相机在顶点之间跳变而不是平滑推进
 *     (`cesium/cameraPath.ts` 按 `cumDist` 均匀采样相机位置,顶点越稀疏,
 *     相邻采样点之间的朝向变化就越突兀)。
 * 所以在构建 Track 时按固定间距在每条顶点连线上插入中间点。
 *
 * 30 是折衷值,不是任意选的:
 *   - 这恰好是 commit 3 所用地形数据源(Esri WorldElevation3D,见
 *     `cesium/terrainSelection.ts`)的标称分辨率量级——间距明显小于 30 会让
 *     大量新增点落在同一个地形像元内、查询不到任何新信息,只是白白增加
 *     `sampleTerrainMostDetailed` 的请求量(commit 3 按点数批量请求地形,
 *     一条 10km 手绘路线在 10m 间距下会变成约 1000 个点,30m 间距下约
 *     330 个点,网络请求量差 3 倍而地形信息量几乎没有差别);
 *   - 又足够密,不会让统计/相机劣化到"没意义"的地步——30m 间距下,
 *     `core/stats/segments.ts` 的爬升识别、`cesium/cameraPath.ts` 的朝向
 *     插值都有足够多的采样点可用。
 * 每条线段单独按需插值(短于该间距的线段不插入任何点),原始顶点在结果里
 * 100% 保留、位置不变——这是 commit 2 "顶点列表是唯一数据源" 的前提:
 * 后续任何编辑(移动/删除某个原始顶点)都必须还能在 `vertices` 数组里找到
 * 它,稠密化因此只能是"构建 Track 时的一步派生计算",不能反过来改写
 * `vertices` 本身。
 */
export const DENSIFY_SPACING_M = 30

function isFiniteVertex(v: Vertex): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1])
}

/**
 * 按 `spacingM` 在每条相邻顶点连线上插入等距的中间点(经纬度线性插值——
 * 手绘路线的单段长度通常远小于会让球面插值和线性插值产生可观察差异的
 * 尺度,和 `core/toolbox/ops.ts` 的 `projectToMetres` 采用的"轨迹工具箱
 * 处理的都是单次徒步/越野跑量级、可以接受局部投影畸变"是同一个折衷)。
 * 原始顶点总是原样出现在结果里(不被移动、不被去重),0/1 个顶点原样返回。
 */
export function densifyVertices(vertices: readonly Vertex[], spacingM: number = DENSIFY_SPACING_M): Vertex[] {
  if (vertices.length < 2) return vertices.slice()
  const out: Vertex[] = [vertices[0]]
  for (let i = 1; i < vertices.length; i++) {
    const [lon0, lat0] = vertices[i - 1]
    const [lon1, lat1] = vertices[i]
    const segLen = haversine(lon0, lat0, lon1, lat1)
    if (segLen > spacingM) {
      const steps = Math.ceil(segLen / spacingM)
      for (let s = 1; s < steps; s++) {
        const t = s / steps
        out.push([lon0 + (lon1 - lon0) * t, lat0 + (lat1 - lat0) * t])
      }
    }
    out.push([lon1, lat1])
  }
  return out
}

/**
 * 把一串手绘顶点变成一条 `Track`:先稠密化,再算 `cumDist`。不带 `ele`/
 * `time`/`hr` 列(手绘路线没有这些数据),`meta`/`originalCrs` 由调用方传入
 * 或用默认值('wgs84' —— 手绘顶点本来就是在 WGS-84 底图上直接点出来的,
 * 谈不上"原始坐标系转换")。
 *
 * 退化输入显式处理,不静默吞掉:
 *   - 0 个顶点:没有任何几何可言,抛错——这与 `ops.ts#joinTracks` 对
 *     "至少 2 条轨迹"的显式抛错是同一种约定,不构造一个假的空 Track。
 *   - 非有限坐标(NaN/Infinity,理论上不该从地图点击事件里出现,但绘制过程
 *     里的编辑 helper 允许调用方传入任意 Vertex,防御性检查更安全):抛错。
 *   - 1 个顶点 / 2 个完全重合的顶点:不抛错——这是"用户画了一个点就双击
 *     结束"这种边界操作序列的合法产物,不是程序错误。稠密化在顶点数 < 2
 *     或线段长度为 0 时都是无操作,`cumDist` 因此退化成全 0 数组,仍然满足
 *     "非递减"——调用方(`ToolboxPanel`/`appStore`)决定是否要在 UI 上另外
 *     提示"至少画 2 个不同的点才能生成有意义的路线",这里只保证不抛出
 *     意外异常、不产出非法数据。
 */
export function trackFromVertices(vertices: readonly Vertex[], meta: TrackMeta): Track {
  if (vertices.length === 0) {
    throw new Error('trackFromVertices: need at least 1 vertex, got 0')
  }
  for (const v of vertices) {
    if (!isFiniteVertex(v)) {
      throw new Error(`trackFromVertices: non-finite coordinate [${v[0]}, ${v[1]}]`)
    }
  }
  const densified = densifyVertices(vertices)
  const lon = densified.map((v) => v[0])
  const lat = densified.map((v) => v[1])
  const t = createTrack({ lon, lat }, meta)
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

/**
 * 原始(未稠密化)顶点连线的总长度,米。用于绘制过程中的"实时里程"读数——
 * 这条折线的长度和 `trackFromVertices` 最终产出的 Track 总里程理论上相同
 * (稠密化只是在同一条直线段上插点,不改变每段的端到端长度,浮点误差之外
 * 完全一致),所以草稿阶段没必要每次都跑一遍稠密化再算 `cumDist`,直接对
 * 原始顶点求和更省。
 */
export function totalVertexDistance(vertices: readonly Vertex[]): number {
  let sum = 0
  for (let i = 1; i < vertices.length; i++) {
    sum += haversine(vertices[i - 1][0], vertices[i - 1][1], vertices[i][0], vertices[i][1])
  }
  return sum
}

// ---------------------------------------------------------------------------
// 纯顶点编辑 helper —— 都返回新数组,从不修改传入的 `vertices`。
// 手绘阶段的"顶点列表是唯一数据源"(commit 2 的约定,为将来的路网吸附纠偏
// 留出空间)靠的就是这几个函数:任何编辑动作都只对 Vertex[] 操作,从不直接
// 触碰 Track/TypedArray。
// ---------------------------------------------------------------------------

/** 在 `index` 处插入一个新顶点(`index === vertices.length` 等价于追加)。 */
export function insertVertexAt(vertices: readonly Vertex[], index: number, v: Vertex): Vertex[] {
  if (!Number.isInteger(index) || index < 0 || index > vertices.length) {
    throw new Error(`insertVertexAt: index ${index} out of range for ${vertices.length} vertices`)
  }
  const next = vertices.slice()
  next.splice(index, 0, v)
  return next
}

/** 在末尾追加一个顶点——手绘时"点击地图新增一点"的常规路径。 */
export function appendVertex(vertices: readonly Vertex[], v: Vertex): Vertex[] {
  return [...vertices, v]
}

/** 把 `index` 处的顶点移动到新位置(拖拽既有顶点)。 */
export function moveVertex(vertices: readonly Vertex[], index: number, v: Vertex): Vertex[] {
  if (!Number.isInteger(index) || index < 0 || index >= vertices.length) {
    throw new Error(`moveVertex: index ${index} out of range for ${vertices.length} vertices`)
  }
  const next = vertices.slice()
  next[index] = v
  return next
}

/** 删除 `index` 处的顶点。 */
export function deleteVertex(vertices: readonly Vertex[], index: number): Vertex[] {
  if (!Number.isInteger(index) || index < 0 || index >= vertices.length) {
    throw new Error(`deleteVertex: index ${index} out of range for ${vertices.length} vertices`)
  }
  const next = vertices.slice()
  next.splice(index, 1)
  return next
}
