import { create } from 'zustand'
import { newId, type Crs, type Track } from '../core/model/track'
import type { TrackKind } from '../core/perf/trackKind'
import type { CheckPoint, CpKind } from '../core/model/checkpoint'
import { anchorMonotonic } from '../core/stats/anchor'
import { nearestVertex } from '../core/geo/nearestVertex'
import { checkpointsFromWaypoints } from '../core/pipeline/checkpointImport'
import type { KmlWaypoint } from '../core/pipeline/import'
import type { StatsOptions } from '../core/stats/segments'
import type { PaceParams } from '../core/pace/models'
import { defaultLocalTimeToday } from '../core/util/localTime'
import { backfillTrackStyles } from '../core/model/trackStyle'
import {
  appendVertex, checkDensifyBudget, deleteVertex, moveVertex, trackFromVertices, type Vertex,
} from '../core/toolbox/draw'
import { applySampledElevation } from '../core/toolbox/elevation'
import { History } from './history'
import { loadMode, saveMode, type Mode } from './mode'
import { loadBasemapStyle, saveBasemapStyle, type BasemapScope, type BasemapStyle } from './basemapPref'
import { loadLayerPrefs, saveLayerPrefs } from './layerPrefs'

export interface HoverState { trackId: string; index: number } // 全轨迹点索引

/**
 * 巡游相机模式,与 `cesium/flythrough.ts` 的 `CameraMode` 保持同一组字面量
 * 但故意不从那个文件 import 类型——那个模块顶层 `import`s `cesium`
 * (真实 WebGL/DOM 环境),appStore.ts 是纯逻辑,任何一天不小心把它换成值
 * import(而不是 type-only)都会把 Cesium 拖进主 bundle。重复一行字面量
 * 联合类型比冒这个险更便宜。
 */
export type FlythroughCameraMode = 'follow' | 'orbit' | 'free'

/**
 * 可撤销的可编辑状态切片。刻意做成对象而不是裸的 Track[] ——
 * checkpoints 加进来之后(本任务),两者共用同一份撤销/重做历史:任何一次
 * CP 编辑(新增/删除/重排)都和轨迹工具箱操作一样,先把变更前的 {tracks, cps}
 * 整体推入 History,再整体写回,undo/redo 因此总是同时回滚两者,不会出现
 * "轨迹撤销了但 CP 没跟着撤销"的不一致状态。
 */
export interface EditableState {
  tracks: Track[]
  cps: CheckPoint[]
}

const DEFAULT_STATS_OPTIONS: StatsOptions = { threshold: 5, smoothWindow: 5 }

/** 配速面板的默认参数:实用档、6 分/公里平路配速、VAM 600 m/h、下坡每米 0.25 秒、每小时 3% 疲劳减速。 */
const DEFAULT_PACE_PARAMS: PaceParams = {
  model: 'practical',
  flatPaceSecPerKm: 360,
  vamMPerH: 600,
  descentFactor: 0.25,
  fatiguePctPerHour: 3,
}

interface AppState {
  tracks: Track[]
  activeTrackId?: string
  hover?: HoverState
  /**
   * 手绘轨迹的进行中状态(P2 轨迹工具箱新增)。和 `hover`/`locateRequest`
   * 同一类:纯会话态交互状态,不进撤销历史(草稿阶段每一次加点/拖动都
   * push 一条 undo 记录既没意义也会淹没真正有意义的操作历史),也不进
   * 工程文件(未完成的手绘草稿不是"轨迹"，没有理由被保存/加载)。
   *
   * `drawVertices` 是 `core/toolbox/draw.ts` 里"顶点列表是唯一数据源"的
   * 那份顶点列表本体——`MapView.tsx` 的点击/拖拽只操作这个数组(通过
   * `addDrawVertex`/`moveDrawVertex`/`deleteDrawVertex`,底层调用
   * `core/toolbox/draw.ts` 的同名纯函数),从不直接构造 Track,直到
   * `finishDraw` 才把它变成一条真正的 Track。这样以后要接路网吸附纠偏
   * (方案 V2.1 §5.2,当前明确不在本次范围内),只需要在这个数组上插入一步
   * 改写逻辑,不需要碰任何下游代码。
   *
   * `drawCursor` 只用于地图上"从最后一个顶点到当前鼠标位置"的橡皮筋线段
   * 预览——和 `hover` 一样,通过 rAF 节流的 mousemove 更新(见
   * `MapView.tsx`),不是每次原始鼠标事件都触发一次 store 写入。
   */
  drawMode: boolean
  drawVertices: Vertex[]
  drawCursor?: Vertex
  /**
   * A pending "move the camera onto this track" request from the "定位"
   * button on a TrackList row (MapView owns the actual map instance, so it
   * can't be commanded directly -- see the comment on `requestLocate`).
   * `seq` is a monotonically increasing counter rather than the request
   * being reduced to just `trackId`: clicking 定位 twice in a row on the
   * *same* track must fire the camera move twice (e.g. the user manually
   * panned away in between), but a plain "did the id change" watcher in
   * MapView would collapse the second click into a no-op since the id is
   * identical to the one already recorded.
   */
  locateRequest?: { trackId: string; seq: number }
  sourceMemory: Record<string, Crs>
  cps: CheckPoint[]
  statsOptions: StatsOptions
  /**
   * 配速面板参数与起跑时间是纯 UI 设置(用户随时可调、调完直接生效,没有
   * "撤销这次调参"的心智模型),因此和 statsOptions 一样刻意放在撤销历史
   * 之外——EditableState 只覆盖 tracks/cps。
   */
  paceParams: PaceParams
  raceStartTime: string
  /**
   * 巡游播放倍速(1x~20x)与相机模式(跟随/俯瞰/自由)——和 paceParams/
   * statsOptions 一样不进撤销栈(倍速/相机模式随时可调,没有"撤销这次
   * 调速"的心智模型)。**但与 paceParams/statsOptions 不同的是也不进工程
   * 文件**——那两个是"这条路线该怎么配速/怎么统计"的规划态参数,值得随
   * 工程保存;巡游倍速/相机模式纯粹是"我这次想怎么看"的会话态偏好,与
   * 具体工程内容无关,保存进工程文件反而会把上次看巡游时随手调的倍速
   * 带进下次打开的、可能完全不同的工程里。`core/model/project.ts`的
   * `serializeProject`/`deserializeProject` 因此不接触这两个字段。
   *
   * 刻意 **不** 把巡游的实时进度/里程/当前点索引放进这里——那些数据由
   * `cesium/flythrough.ts` 的 `FlythroughEngine` 通过回调、以最高 60Hz
   * 的频率上报(见该文件 `FlythroughProgressInfo` 的注释),塞进 Zustand
   * 会让全局 store 以那个频率触发订阅者重渲染;`FlyView.tsx` 把这部分
   * 数据放在自己的组件本地 state 里,只转发给 `FlyControls.tsx`。
   */
  flythroughSpeed: number
  flythroughCameraMode: FlythroughCameraMode
  setFlythroughSpeed(speed: number): void
  setFlythroughCameraMode(mode: FlythroughCameraMode): void
  /**
   * 规划模式 / 巡游模式(2D planning vs. 3D flythrough, App.tsx switches
   * between MapView and FlyView on this). A pure UI setting like paceParams
   * above: not in the undo history, not in the project file -- switching
   * modes must never lose or roll back tracks/cps. Persisted to localStorage
   * via state/mode.ts (mirroring layout.ts) so reopening the app returns to
   * the last-used mode; that persistence is a side effect of `setMode`
   * itself, not something callers have to remember to do separately.
   */
  mode: Mode
  setMode(mode: Mode): void
  /**
   * Basemap style (3D 卫星图 / 二维平面图, P1 §3.5, milestone N6 commit 1) --
   * another pure UI setting, same category as `mode` above: not in the undo
   * history, not in the project file. Remembered **separately per mode**
   * (planning vs flythrough, matching `state/basemapPref.ts`'s own
   * `BasemapScope`) rather than as one shared value -- a user who prefers the
   * plain OSM style while planning but wants satellite imagery while flying
   * through shouldn't have one choice clobber the other. `LayerPanel.tsx` is
   * the only UI surface that writes these; `MapView.tsx`/`FlyView.tsx` each
   * read their own mode's field and apply it to their own map engine.
   */
  planBasemapStyle: BasemapStyle
  flyBasemapStyle: BasemapStyle
  setBasemapStyle(scope: BasemapScope, style: BasemapStyle): void
  /**
   * Contour-overlay / distance-radar on-off toggles (P1 §3.6/§3.7, milestone
   * N6 commits 3-4) -- `state/layerPrefs.ts`'s own doc comment explains why
   * these are single booleans (not per-mode like `planBasemapStyle`/
   * `flyBasemapStyle` above): both overlays are Cesium/flythrough-only today,
   * but the on/off *intent* itself should carry across a mode switch rather
   * than reset every time the user leaves and returns to 巡游模式.
   */
  contoursEnabled: boolean
  radarEnabled: boolean
  setContoursEnabled(enabled: boolean): void
  setRadarEnabled(enabled: boolean): void
  canUndo: boolean
  canRedo: boolean
  undoLabel?: string
  redoLabel?: string
  /**
   * History 实例本身放进 store state(而不是模块级单例闭包变量),纯粹是为了
   * 可测试性:它内部用可变数组维护两个栈,组件不应该也不需要直接订阅它——
   * 真正驱动重渲染的是下面的 canUndo/canRedo 布尔量,每次变更后同步更新。
   * 放进 state 只是为了让测试能通过 setState({ history: new History() })
   * 在用例之间重置撤销历史,避免不同测试互相污染。
   */
  history: History<EditableState>
  addTrack(t: Track): void
  /**
   * Turns a KML import's waypoints (see `core/pipeline/import.ts`'s
   * `ImportResult.waypoints`) into CheckPoints anchored on `track` and
   * appends them to `cps`. Kept as a separate action from `addTrack` (rather
   * than an optional param on it) because most callers of `addTrack` --
   * GPX/FIT imports, undo/redo, toolbox ops -- never have waypoints to add;
   * `ImportPanel.tsx` calls this right after `addTrack` only when a KML
   * import actually produced some. No-ops (and does not touch history) for
   * an empty waypoint list, matching `addTrack` itself not being on the undo
   * stack -- an imported track's checkpoints appearing/disappearing together
   * with it is the expected undo granularity here, not a step of their own.
   */
  addImportedCheckpoints(track: Track, waypoints: KmlWaypoint[]): void
  removeTrack(id: string): void
  updateTrackStyle(id: string, patch: { color?: string; lineWidth?: number }): void
  /**
   * 手动覆盖(或清除覆盖,传 `undefined`)某条轨迹的实跑/规划判别结果——
   * P2 §3.1(里程碑 Q1)"误判时用户可手动覆盖"的验收点。写入
   * `Track.meta.kindOverride`(该字段的文档注释解释了为什么放在 meta 上:
   * 免费获得 `core/model/project.ts` 的持久化,不用碰 project.ts 一行代码),
   * 和 `updateTrackStyle` 同一类操作——都是"随时可再改回去"的属性调整,不
   * 走撤销栈(不 `history.push`);解析出"最终该显示哪个判别结果"的逻辑
   * 不在这里,由 `core/perf/trackKind.ts` 的 `resolveTrackKind` 统一做,这里
   * 只管把用户的选择写进 Track。
   */
  setTrackKindOverride(id: string, kind: TrackKind | undefined): void
  setActive(id: string): void
  setHover(h?: HoverState): void
  /**
   * 手绘模式的开/关。开启时清空任何残留的顶点/光标(比如上一次手绘取消后
   * 又重新开始),并顺带清掉 `hover`——`MapView.tsx` 让手绘模式和"悬停找最
   * 近点/点击加 CP"互斥,不该出现"手绘中同时还留着上一次悬停高亮"的
   * 视觉混乱。关闭时同样清空草稿——`toggleDrawMode(false)` 和 `cancelDraw`
   * 因此行为完全一致,是同一件事的两个入口(前者是"再点一次开关"，后者是
   * ToolboxPanel 的"取消"按钮),没必要维护两套清空逻辑。
   */
  setDrawMode(on: boolean): void
  addDrawVertex(v: Vertex): void
  moveDrawVertex(index: number, v: Vertex): void
  deleteDrawVertex(index: number): void
  setDrawCursor(v?: Vertex): void
  /** 丢弃当前手绘草稿,不落地成 Track。 */
  cancelDraw(): void
  /**
   * 把当前草稿顶点交给 `core/toolbox/draw.ts#trackFromVertices` 落地成一条
   * 新 Track,走 `applyOp` 挂进撤销历史(和 split/join/reverse/清洗/抽稀
   * 完全一样的入口,手绘因此天然获得"可撤销")。顶点数不足 2 时静默无操作
   * ——`trackFromVertices` 本身对 1 个顶点并不抛错(见该函数文档),但
   * "画一条只有 1 个点的路线"对用户来说不是一次有意义的完成操作，交由
   * `ToolboxPanel` 的按钮 disabled 状态在此之前就挡掉，这里的检查只是
   * 兜底防御。
   */
  finishDraw(): void
  /**
   * 把 `cesium/terrainSample.ts#sampleTrackElevation` 已经采样好的高程数组
   * 写回 `trackId` 对应的轨迹(P2「补全高程」)。和 `finishDraw` 一样走
   * `applyOp`——补全高程是一次可撤销的轨迹编辑,不应该绕开撤销栈。真正的
   * 网络请求由调用方(`ToolboxPanel.tsx`)在调这个方法之前、通过 Cesium
   * 动态 import 边界另一侧的 `sampleTrackElevation` 完成;这个方法本身
   * 只做同步的"结果落地"这一步,和 store 里其它任何 action 一样不碰网络、
   * 不 import cesium。
   *
   * 全部采样失败(`heights` 里没有一个非 undefined 值)时不 push 历史、
   * 不改动 `tracks`——`core/toolbox/elevation.ts#applySampledElevation` 的
   * "全部失败就原样返回输入 Track"约定决定了这里没有任何有意义的变更可
   * 撤销,提前弹出反而会在撤销栈里留一条"什么都没变"的空操作。
   *
   * 找不到 `trackId`,或轨迹在采样发起之后、结果落地之前已经被替换成点数
   * 不同的另一条轨迹(比如用户同时又做了一次抽稀)时,静默放弃、返回
   * `undefined`——`heights` 数组是针对发起采样那一刻的点数生成的,套用到
   * 点数已经变化的轨迹上没有意义,不能强行按下标对应。
   */
  setTrackElevation(
    trackId: string,
    heights: (number | undefined)[],
  ): { sampledCount: number; failedCount: number } | undefined
  /**
   * Records a request to move the map camera onto `trackId`. MapView watches
   * `locateRequest` and, once it has acted on it (via `trackLayer.ts`'s
   * `locateTrack`), calls `clearLocateRequest` -- see that field's doc
   * comment for why `seq` (not just `trackId`) is what actually changes on
   * every call, so repeated clicks on the same track each get their own turn.
   */
  requestLocate(trackId: string): void
  clearLocateRequest(): void
  rememberSource(creator: string, crs: Crs): void
  applyOp(label: string, fn: (tracks: Track[]) => Track[]): void
  addCp(kind: CpKind, name: string, lngLat: [number, number]): void
  updateCp(id: string, patch: Partial<CheckPoint>): void
  removeCp(id: string): void
  reorderCp(id: string, direction: -1 | 1): void
  /**
   * Commits the result of `core/pipeline/photoAnchor.ts#anchorPhotosToTrack`
   * (P3-R2 commit 3 -- batch EXIF-GPS photo anchoring) to the store in one
   * undoable step. `CpPanel.tsx` computes `created`/`updated` by calling that
   * pure function itself (same division of labour as `ImportPanel.tsx`
   * calling `importInWorker` and only handing the *result* to the store);
   * this action's only job is the state transition. `updated` entries are
   * full replacement objects (already carrying the new `photoUrl`, see that
   * function's own doc comment) matched back into `s.cps` by `id`, not a
   * patch -- there's nothing else to merge.
   */
  addPhotoCheckpoints(created: CheckPoint[], updated: CheckPoint[]): void
  setStatsOptions(patch: Partial<StatsOptions>): void
  setPaceParams(patch: Partial<PaceParams>): void
  setRaceStartTime(iso: string): void
  /**
   * 整体替换为一个刚加载/导入的工程:tracks/cps/paceParams/statsOptions 全部
   * 替换,并清空撤销历史——旧工程的撤销栈对新工程的内容没有意义,留着反而
   * 可能让用户 undo 回到"上一个工程"的状态,数据来源完全不同,不该混在
   * 同一条历史里。
   */
  loadProjectData(data: {
    tracks: Track[]
    cps: CheckPoint[]
    paceParams: PaceParams
    statsOptions: StatsOptions
    raceStartTime?: string
  }): void
  undo(): void
  redo(): void
}

/**
 * undo/redo 之后,若 activeTrackId/hover 指向的轨迹已经不存在于恢复出的
 * tracks 列表中,清掉它们——这与 removeTrack 里已经修好的"悬空引用"是同一
 * 类 bug,只是触发路径从"删除单条轨迹"变成了"整体状态被替换"。
 *
 * cps 不在这里处理:CheckPoint(core/model/checkpoint.ts)现在带 trackId,
 * undo/redo 整体替换 tracks/cps 快照时两者本就是同一次 push 进历史栈的,
 * cps 的 trackId 绑定天然和恢复出的 tracks 一致,没有额外的悬空引用要清。
 */
function reconcileDangling(
  tracks: Track[],
  activeTrackId: string | undefined,
  hover: HoverState | undefined,
): { activeTrackId: string | undefined; hover: HoverState | undefined } {
  const ids = new Set(tracks.map((t) => t.id))
  return {
    activeTrackId: activeTrackId !== undefined && ids.has(activeTrackId) ? activeTrackId : undefined,
    hover: hover !== undefined && ids.has(hover.trackId) ? hover : undefined,
  }
}

/**
 * History 内部状态的变化(push/undo/redo 后栈的深度、栈顶标签)不会自动触发
 * React 重渲染——它是 store state 里的一个稳定引用,zustand 只在引用变化时
 * 通知订阅者。每次调用完 history 的方法之后都要把这四个派生量重新镜像进
 * store state,组件订阅这些镜像字段而不是 history 实例本身。
 */
function historyFlags(history: History<EditableState>) {
  return {
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undoLabel: history.undoLabel,
    redoLabel: history.redoLabel,
  }
}

/**
 * 按 cps 当前列表顺序,把每个 CP 的 clickLngLat 重新喂给 anchorMonotonic,
 * 整体重新锚定(而不是只锚定新增/未受影响的那一个)——单调约束本身依赖顺序,
 * 插入/删除/重排任何一个 CP 都可能合法地改变后面 CP 该锚定到哪一次经过,
 * 这是折返赛道"锚定无错趟"验收要求的核心。
 *
 * 只重新锚定 trackId === track.id 的那个子集,其余(属于别的轨迹的)CP 原样
 * 透传、连位置都不挪——这个函数现在可能收到混合多条轨迹的 cps 列表(调用方
 * 大多懒得先自己过滤),必须自己保证不去动不相关的 CP,否则会把它们的
 * anchorIndex 错误地按传入的 track 重新计算。子集内部的相对顺序完全保留,
 * 单调约束因此只在"同一条轨迹自己的 CP 之间"生效,不受其它轨迹的 CP 是否
 * 交错在列表中间影响。
 *
 * 对子集中缺失 clickLngLat 的 CP(理论上不会出现,addCp 总是带着点击坐标
 * 创建),兜底用它当前 anchorIndex 对应的轨迹坐标当作"点击位置",保证类型
 * 安全且不抛异常。
 */
function reanchorAll(track: Track, cps: CheckPoint[]): CheckPoint[] {
  const relevant = cps.filter((c) => c.trackId === track.id)
  if (relevant.length === 0) return cps

  const { lon, lat } = track.points
  const clicks: [number, number][] = relevant.map((c) => {
    if (c.clickLngLat) return c.clickLngLat
    const i = Math.min(Math.max(c.anchorIndex, 0), lon.length - 1)
    return [lon[i] ?? 0, lat[i] ?? 0]
  })
  const indices = anchorMonotonic(lon, lat, clicks)
  const reanchoredIndex = new Map(relevant.map((c, i) => [c.id, indices[i]]))
  return cps.map((c) => {
    const idx = reanchoredIndex.get(c.id)
    return idx === undefined ? c : { ...c, anchorIndex: idx }
  })
}

/**
 * applyOp 之后,找出"接替原激活轨迹"的那条新轨迹,用来重新锚定 CP。
 *
 * 工具箱操作(split/join/reverse/clean/simplify,定义于 core/toolbox/ops.ts)
 * 全部通过 derive()/createTrack() 产出全新 id 的 Track——操作前后 id 必然
 * 不同,没法按 id 找"对应的新轨迹"。这里改用"操作前激活轨迹在旧 tracks
 * 数组里的下标"来定位,这与 ToolboxPanel 里各操作自己遵循的 splice 约定
 * 完全一致:
 *   - reverse / 清洗异常点 / 抽稀:1 对 1 替换,新轨迹落在原下标位置——
 *     这里的定位总是准确的。
 *   - splitAt:1 对 2,`next.splice(idx, 1, a, b)` 让前半段 a 占据原下标——
 *     P0 的显式选择是"CP 全部重新锚定到 a(前半段)上",b(后半段)上的 CP
 *     需要用户之后手动检查/调整,不在本次范围内。
 *   - joinTracks:n 对 1,只有当原激活轨迹恰好是"列表中第一条被选中的
 *     轨迹"时,这个下标才会精确对上拼接结果——这是已知的 P0 局限,不是
 *     本函数试图掩盖的 bug;拼接后建议用户手动核对 CP。
 * 找不到原激活轨迹(操作前本来就没有激活轨迹)或者操作后 tracks 变成空
 * 数组时,返回 undefined,调用方应保持 cps 原样、不做任何锚定尝试。
 */
function resolveActiveTrackAfterOp(tracks: Track[], oldActiveIdx: number): Track | undefined {
  if (oldActiveIdx === -1 || tracks.length === 0) return undefined
  return tracks[Math.min(oldActiveIdx, tracks.length - 1)]
}

export const useAppStore = create<AppState>((set, get) => ({
  tracks: [], sourceMemory: {}, cps: [], statsOptions: DEFAULT_STATS_OPTIONS,
  paceParams: DEFAULT_PACE_PARAMS, raceStartTime: defaultLocalTimeToday(6, 0),
  flythroughSpeed: 1, flythroughCameraMode: 'follow',
  mode: loadMode(),
  setMode: (mode) => {
    saveMode(mode)
    set({ mode })
  },
  planBasemapStyle: loadBasemapStyle('plan'),
  flyBasemapStyle: loadBasemapStyle('fly'),
  setBasemapStyle: (scope, style) => {
    saveBasemapStyle(scope, style)
    set(scope === 'plan' ? { planBasemapStyle: style } : { flyBasemapStyle: style })
  },
  contoursEnabled: loadLayerPrefs().contoursEnabled,
  radarEnabled: loadLayerPrefs().radarEnabled,
  setContoursEnabled: (enabled) => {
    const s = get()
    saveLayerPrefs({ contoursEnabled: enabled, radarEnabled: s.radarEnabled })
    set({ contoursEnabled: enabled })
  },
  setRadarEnabled: (enabled) => {
    const s = get()
    saveLayerPrefs({ contoursEnabled: s.contoursEnabled, radarEnabled: enabled })
    set({ radarEnabled: enabled })
  },
  canUndo: false, canRedo: false, history: new History<EditableState>(),
  // 新导入轨迹如果自带 color/lineWidth(理论上不会——importInWorker 产出
  // 的 Track 从不设置这两个字段)就原样保留,否则由 backfillTrackStyles
  // 按当前已有轨迹的颜色序列分配下一个调色板颜色,保证新旧轨迹相邻不撞色。
  // 传入 [...s.tracks, t] 而不是只传 [t] 是为了让 backfillTrackStyles 能看到
  // "已经在用的颜色"序列;已有轨迹的 meta 早就设过 color/lineWidth,函数
  // 内部的 `if (unchanged) return t` 保证它们原样返回同一个对象引用,不会
  // 无意义地触发它们的重渲染。
  addTrack: (t) => {
    const s = get()
    const tracks = backfillTrackStyles([...s.tracks, t])
    const added = tracks[tracks.length - 1]
    set({ tracks, activeTrackId: added.id })
  },
  addImportedCheckpoints: (track, waypoints) => {
    if (waypoints.length === 0) return
    const s = get()
    const newCps = checkpointsFromWaypoints(track, waypoints)
    set({ cps: [...s.cps, ...newCps] })
  },
  // 颜色/粗细是纯展示态属性(和 paceParams/statsOptions 同类),调整它们不
  // 需要撤销栈——用户随时可以再调回去,不需要"撤销这次改色"的心智模型。
  updateTrackStyle: (id, patch) =>
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, meta: { ...t.meta, ...patch } } : t)),
    })),
  setTrackKindOverride: (id, kind) =>
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, meta: { ...t.meta, kindOverride: kind } } : t)),
    })),
  removeTrack: (id) => {
    const s = get()
    s.history.push('删除轨迹', { tracks: s.tracks, cps: s.cps })
    const tracks = s.tracks.filter((x) => x.id !== id)
    // CPs are bound to a track via trackId (core/model/checkpoint.ts); once
    // that track is gone there is nothing left for their anchorIndex to mean
    // anything relative to, so they must go with it rather than being left
    // behind as orphans that silently stop being displayed anywhere.
    const cps = s.cps.filter((c) => c.trackId !== id)
    set({
      tracks,
      cps,
      activeTrackId: s.activeTrackId === id ? undefined : s.activeTrackId,
      hover: s.hover?.trackId === id ? undefined : s.hover,
      ...historyFlags(s.history),
    })
  },
  setActive: (id) => set({ activeTrackId: id }),
  setHover: (h) => set({ hover: h }),
  drawMode: false, drawVertices: [], drawCursor: undefined,
  setDrawMode: (on) =>
    set({ drawMode: on, drawVertices: [], drawCursor: undefined, hover: on ? undefined : get().hover }),
  addDrawVertex: (v) => set((s) => ({ drawVertices: appendVertex(s.drawVertices, v) })),
  moveDrawVertex: (index, v) => set((s) => ({ drawVertices: moveVertex(s.drawVertices, index, v) })),
  deleteDrawVertex: (index) => set((s) => ({ drawVertices: deleteVertex(s.drawVertices, index) })),
  setDrawCursor: (v) => set({ drawCursor: v }),
  cancelDraw: () => set({ drawMode: false, drawVertices: [], drawCursor: undefined }),
  finishDraw: () => {
    const s = get()
    if (s.drawVertices.length < 2) return
    // Defect 3 (代码审查): refuse rather than silently truncate a route that
    // would densify past DENSIFY_MAX_POINTS -- ToolboxPanel already disables
    // the "完成" button and shows a visible warning once this would be
    // false (see its own `checkDensifyBudget` usage), so reaching here with
    // an over-budget draft should only happen via some other/future caller
    // of this action; this is the last-resort backstop, same silent-no-op
    // style as the `< 2` guard just above it.
    if (!checkDensifyBudget(s.drawVertices).ok) return
    const vertices = s.drawVertices
    let created: Track | undefined
    s.applyOp('手绘轨迹', (tracks) => {
      created = trackFromVertices(vertices, {
        name: `手绘路线 ${tracks.length + 1}`,
        format: 'gpx',
        fileName: '手绘路线.gpx',
      })
      return backfillTrackStyles([...tracks, created])
    })
    // applyOp resolves the active track by the OLD active track's index
    // (see resolveActiveTrackAfterOp's doc comment) -- that logic is built
    // for 1-for-1/1-for-N *replacements*, not appends, so it never points at
    // the newly drawn track. Set it explicitly here, same as `addTrack`
    // does for imports, so finishing a drawn route selects it immediately.
    set({ drawMode: false, drawVertices: [], drawCursor: undefined, activeTrackId: created?.id ?? get().activeTrackId })
  },

  setTrackElevation: (trackId, heights) => {
    const s = get()
    const track = s.tracks.find((t) => t.id === trackId)
    if (!track) return undefined
    // Cheap pure preview (no history side effect) purely to decide whether
    // there's anything worth pushing onto the undo stack -- see this
    // action's own doc comment for why a total failure must not push a
    // no-op history entry.
    const preview = applySampledElevation(track, heights)
    if (preview.sampledCount === 0) return { sampledCount: 0, failedCount: preview.failedCount }

    s.applyOp('补全高程', (tracks) => {
      const idx = tracks.findIndex((t) => t.id === trackId)
      if (idx === -1) return tracks
      const current = tracks[idx]
      // heights was generated against the point count at sampling time; if
      // the track's shape changed since (another op landed while the
      // network request was in flight), the array no longer lines up with
      // this track's indices -- discard rather than let
      // applySampledElevation's own length-mismatch guard throw mid-applyOp.
      if (current.points.lon.length !== heights.length) return tracks
      const result = applySampledElevation(current, heights)
      const next = [...tracks]
      next.splice(idx, 1, result.track)
      return next
    })
    return { sampledCount: preview.sampledCount, failedCount: preview.failedCount }
  },

  requestLocate: (trackId) =>
    set((s) => ({ locateRequest: { trackId, seq: (s.locateRequest?.seq ?? 0) + 1 } })),
  clearLocateRequest: () => set({ locateRequest: undefined }),
  rememberSource: (creator, crs) => set((s) => ({ sourceMemory: { ...s.sourceMemory, [creator]: crs } })),

  // 工具箱操作(split/join/reverse/清洗/抽稀)每次都替换出全新 id、常常是
  // 全新点数的 Track——CP 的 anchorIndex 是对某条具体轨迹 points 数组的
  // 下标缓存,不重新锚定就会立刻出现"越界"(抽稀后点数骤减)或"数值没变但
  // 几何位置错位"(reverse 后同一下标指向另一端)两类 bug。这里把重新锚定
  // 收在 applyOp 这一个入口里(而不是逐个操作调用处补丁),保证以后任何新
  // 加的工具箱操作都不可能漏掉这一步——具体定位"重新锚定到哪条新轨迹"的
  // 规则见 resolveActiveTrackAfterOp 的注释。
  applyOp: (label, fn) => {
    const s = get()
    s.history.push(label, { tracks: s.tracks, cps: s.cps })
    const oldActiveIdx = s.tracks.findIndex((t) => t.id === s.activeTrackId)
    const oldActiveTrackId = oldActiveIdx !== -1 ? s.tracks[oldActiveIdx].id : undefined
    const tracks = fn(s.tracks)
    const reconciled = reconcileDangling(tracks, s.activeTrackId, s.hover)
    const resolvedActive = resolveActiveTrackAfterOp(tracks, oldActiveIdx)
    const activeTrackId = reconciled.activeTrackId ?? resolvedActive?.id

    // Toolbox ops replace the active Track with a brand-new one (new id --
    // see resolveActiveTrackAfterOp's comment for exactly which replacement
    // this resolves to per-op). Any CP still bound (via trackId) to the OLD
    // active track's id has to be re-pointed at the new one *before*
    // reanchorAll runs, or it fails reanchorAll's `trackId === track.id`
    // filter and is left permanently orphaned the moment this op commits --
    // there's no later point at which the binding could be fixed up. CPs
    // belonging to any other track are untouched, same as always.
    let cps = s.cps
    if (resolvedActive && oldActiveTrackId !== undefined && resolvedActive.id !== oldActiveTrackId) {
      cps = cps.map((c) => (c.trackId === oldActiveTrackId ? { ...c, trackId: resolvedActive.id } : c))
    }
    cps = resolvedActive ? reanchorAll(resolvedActive, cps) : cps

    set({ tracks, cps, activeTrackId, hover: reconciled.hover, ...historyFlags(s.history) })
  },

  addCp: (kind, name, lngLat) => {
    const s = get()
    const track = s.tracks.find((t) => t.id === s.activeTrackId)
    if (!track) return // 没有激活轨迹时无处可锚定,静默放弃
    s.history.push('新增 CP', { tracks: s.tracks, cps: s.cps })
    const newCp: CheckPoint = { id: newId('cp'), trackId: track.id, name, kind, anchorIndex: 0, clickLngLat: lngLat }
    const cps = reanchorAll(track, [...s.cps, newCp])
    set({ cps, ...historyFlags(s.history) })
  },

  // 手动微调(比如 ±步进锚点)是用户在主动覆盖算法的锚定结果,不应该被
  // 自动重新锚定悄悄冲掉——因此 updateCp 无论 patch 里是否包含 anchorIndex,
  // 都只做逐字段合并,从不触发 reanchorAll。
  updateCp: (id, patch) => {
    const s = get()
    s.history.push('编辑 CP', { tracks: s.tracks, cps: s.cps })
    const cps = s.cps.map((c) => (c.id === id ? { ...c, ...patch } : c))
    set({ cps, ...historyFlags(s.history) })
  },

  removeCp: (id) => {
    const s = get()
    const removed = s.cps.find((c) => c.id === id)
    if (!removed) return
    s.history.push('删除 CP', { tracks: s.tracks, cps: s.cps })
    const remaining = s.cps.filter((c) => c.id !== id)
    // Re-anchor against the removed CP's own track (not necessarily the
    // currently-active one -- callers filter to the active track today, but
    // this must stay correct even if that ever changes), so the remaining
    // siblings on that track re-claim whichever indices the deleted one was
    // occupying in the monotonic ordering.
    const track = s.tracks.find((t) => t.id === removed.trackId)
    const cps = track ? reanchorAll(track, remaining) : remaining
    set({ cps, ...historyFlags(s.history) })
  },

  reorderCp: (id, direction) => {
    const s = get()
    const idx = s.cps.findIndex((c) => c.id === id)
    if (idx === -1) return
    const trackId = s.cps[idx].trackId
    // Reordering must stay scoped to CPs that belong to the same track:
    // s.cps can hold CPs from multiple tracks interleaved in arbitrary
    // order (trackId is what actually groups them, not adjacency in this
    // flat list), so "move by one position in s.cps" would let a CP jump
    // past -- and get reordered relative to -- a different track's CP that
    // has nothing to do with it. Swap with the nearest same-track sibling
    // instead, wherever it actually sits in the flat array.
    const siblingIdxs: number[] = []
    s.cps.forEach((c, i) => { if (c.trackId === trackId) siblingIdxs.push(i) })
    const localIdx = siblingIdxs.indexOf(idx)
    const targetLocal = localIdx + direction
    if (targetLocal < 0 || targetLocal >= siblingIdxs.length) return
    const otherIdx = siblingIdxs[targetLocal]

    s.history.push('调整 CP 顺序', { tracks: s.tracks, cps: s.cps })
    const reordered = [...s.cps]
    ;[reordered[idx], reordered[otherIdx]] = [reordered[otherIdx], reordered[idx]]
    const track = s.tracks.find((t) => t.id === trackId)
    const cps = track ? reanchorAll(track, reordered) : reordered
    set({ cps, ...historyFlags(s.history) })
  },

  addPhotoCheckpoints: (created, updated) => {
    if (created.length === 0 && updated.length === 0) return
    const s = get()
    const trackId = created[0]?.trackId ?? updated[0]?.trackId
    const track = s.tracks.find((t) => t.id === trackId)
    s.history.push('照片自动生成 CP', { tracks: s.tracks, cps: s.cps })
    const updatedById = new Map(updated.map((c) => [c.id, c]))
    const merged = [...s.cps.map((c) => updatedById.get(c.id) ?? c), ...created]

    let cps = merged
    if (track) {
      // 不能像 addCp 那样简单地把新 CP 追加到列表末尾就直接交给
      // reanchorAll:reanchorAll 信任"列表顺序就是沿赛道前进的顺序"(这是
      // 单调锚定的前提,见该函数自己的注释),而一批新的照片 CP 很可能和
      // 已有 CP(比如从 KML 导入的官方检查点)沿赛道方向交错分布——如果
      // 有一个新 CP 实际位置比某个已有 CP 更靠前,却因为"新的都排在后面"
      // 被排在它后面,anchorMonotonic 的单调地板会把它错误地锁死在那个
      // 已有 CP 之后。做法和 checkpointImport.ts / photoAnchor.ts 同一个
      // 两阶段预处理:先把这条轨迹自己的 CP 子集按各自独立的最近点下标
      // 重新排序,再交给 reanchorAll(它内部会照这个新顺序重新跑一遍
      // anchorMonotonic)。已有 CP 之间原本就是按赛道顺序排的,这一步对
      // 它们只是重新确认、不改变相对顺序,只把新 CP 正确地插进中间。
      const { lon, lat } = track.points
      const trackPosition = (c: CheckPoint): number =>
        c.clickLngLat ? nearestVertex(lon, lat, c.clickLngLat[0], c.clickLngLat[1]).index : c.anchorIndex
      const relevant = merged.filter((c) => c.trackId === track.id)
      const others = merged.filter((c) => c.trackId !== track.id)
      const sortedRelevant = [...relevant].sort((a, b) => trackPosition(a) - trackPosition(b))
      cps = reanchorAll(track, [...others, ...sortedRelevant])
    }
    set({ cps, ...historyFlags(s.history) })
  },

  // 阈值/平滑窗口是纯展示态的调参,不需要走撤销栈(调参本身可随时再调回去)。
  setStatsOptions: (patch) => set((s) => ({ statsOptions: { ...s.statsOptions, ...patch } })),

  // 配速参数/起跑时间同理:纯展示态调参,不入撤销栈。
  setPaceParams: (patch) => set((s) => ({ paceParams: { ...s.paceParams, ...patch } })),
  setRaceStartTime: (iso) => set({ raceStartTime: iso }),

  // 巡游倍速/相机模式同理:纯展示态调参,不入撤销栈,不进工程文件。
  setFlythroughSpeed: (speed) => set({ flythroughSpeed: speed }),
  setFlythroughCameraMode: (mode) => set({ flythroughCameraMode: mode }),

  // backfillTrackStyles covers project files saved before per-track
  // color/lineWidth existed (schema_version is still '1.0' -- see
  // core/model/project.ts -- so an old file's tracks simply lack those two
  // meta fields rather than failing to parse); freshly-saved projects
  // already carry them and pass through unchanged.
  loadProjectData: (data) =>
    set({
      tracks: backfillTrackStyles(data.tracks),
      cps: data.cps,
      paceParams: data.paceParams,
      statsOptions: data.statsOptions,
      raceStartTime: data.raceStartTime ?? get().raceStartTime,
      activeTrackId: data.tracks[0]?.id,
      hover: undefined,
      history: new History<EditableState>(),
      canUndo: false, canRedo: false, undoLabel: undefined, redoLabel: undefined,
    }),

  undo: () => {
    const s = get()
    const snap = s.history.undo({ tracks: s.tracks, cps: s.cps })
    if (!snap) return
    const reconciled = reconcileDangling(snap.state.tracks, s.activeTrackId, s.hover)
    set({ tracks: snap.state.tracks, cps: snap.state.cps, ...reconciled, ...historyFlags(s.history) })
  },

  redo: () => {
    const s = get()
    const snap = s.history.redo({ tracks: s.tracks, cps: s.cps })
    if (!snap) return
    const reconciled = reconcileDangling(snap.state.tracks, s.activeTrackId, s.hover)
    set({ tracks: snap.state.tracks, cps: snap.state.cps, ...reconciled, ...historyFlags(s.history) })
  },
}))
