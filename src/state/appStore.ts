import { create } from 'zustand'
import { newId, type Crs, type Track } from '../core/model/track'
import type { CheckPoint, CpKind } from '../core/model/checkpoint'
import { anchorMonotonic } from '../core/stats/anchor'
import type { StatsOptions } from '../core/stats/segments'
import type { PaceParams } from '../core/pace/models'
import { defaultLocalTimeToday } from '../core/util/localTime'
import { History } from './history'

export interface HoverState { trackId: string; index: number } // 全轨迹点索引

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
  removeTrack(id: string): void
  setActive(id: string): void
  setHover(h?: HoverState): void
  rememberSource(creator: string, crs: Crs): void
  applyOp(label: string, fn: (tracks: Track[]) => Track[]): void
  addCp(kind: CpKind, name: string, lngLat: [number, number]): void
  updateCp(id: string, patch: Partial<CheckPoint>): void
  removeCp(id: string): void
  reorderCp(id: string, direction: -1 | 1): void
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
 * cps 不在这里处理:CheckPoint(core/model/checkpoint.ts)本身不存 trackId,
 * 不持有指向具体轨迹的引用,因此没有"悬空引用"可言——它只是一份和
 * anchorIndex 绑定的坐标列表,tracks 变化时保持原样,由上层(CpPanel /
 * SegmentTable)按需重新解释。
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
 * 对缺失 clickLngLat 的 CP(理论上不会出现,addCp 总是带着点击坐标创建),
 * 兜底用它当前 anchorIndex 对应的轨迹坐标当作"点击位置",保证类型安全且
 * 不抛异常。
 */
function reanchorAll(track: Track, cps: CheckPoint[]): CheckPoint[] {
  const { lon, lat } = track.points
  const clicks: [number, number][] = cps.map((c) => {
    if (c.clickLngLat) return c.clickLngLat
    const i = Math.min(Math.max(c.anchorIndex, 0), lon.length - 1)
    return [lon[i] ?? 0, lat[i] ?? 0]
  })
  const indices = anchorMonotonic(lon, lat, clicks)
  return cps.map((c, i) => ({ ...c, anchorIndex: indices[i] }))
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
  canUndo: false, canRedo: false, history: new History<EditableState>(),
  addTrack: (t) => set((s) => ({ tracks: [...s.tracks, t], activeTrackId: t.id })),
  removeTrack: (id) => {
    const s = get()
    s.history.push('删除轨迹', { tracks: s.tracks, cps: s.cps })
    const tracks = s.tracks.filter((x) => x.id !== id)
    set({
      tracks,
      activeTrackId: s.activeTrackId === id ? undefined : s.activeTrackId,
      hover: s.hover?.trackId === id ? undefined : s.hover,
      ...historyFlags(s.history),
    })
  },
  setActive: (id) => set({ activeTrackId: id }),
  setHover: (h) => set({ hover: h }),
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
    const tracks = fn(s.tracks)
    const reconciled = reconcileDangling(tracks, s.activeTrackId, s.hover)
    const resolvedActive = resolveActiveTrackAfterOp(tracks, oldActiveIdx)
    const activeTrackId = reconciled.activeTrackId ?? resolvedActive?.id
    const cps = resolvedActive ? reanchorAll(resolvedActive, s.cps) : s.cps
    set({ tracks, cps, activeTrackId, hover: reconciled.hover, ...historyFlags(s.history) })
  },

  addCp: (kind, name, lngLat) => {
    const s = get()
    const track = s.tracks.find((t) => t.id === s.activeTrackId)
    if (!track) return // 没有激活轨迹时无处可锚定,静默放弃
    s.history.push('新增 CP', { tracks: s.tracks, cps: s.cps })
    const newCp: CheckPoint = { id: newId('cp'), name, kind, anchorIndex: 0, clickLngLat: lngLat }
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
    s.history.push('删除 CP', { tracks: s.tracks, cps: s.cps })
    const remaining = s.cps.filter((c) => c.id !== id)
    const track = s.tracks.find((t) => t.id === s.activeTrackId)
    const cps = track ? reanchorAll(track, remaining) : remaining
    set({ cps, ...historyFlags(s.history) })
  },

  reorderCp: (id, direction) => {
    const s = get()
    const idx = s.cps.findIndex((c) => c.id === id)
    if (idx === -1) return
    const targetIdx = idx + direction
    if (targetIdx < 0 || targetIdx >= s.cps.length) return
    s.history.push('调整 CP 顺序', { tracks: s.tracks, cps: s.cps })
    const reordered = [...s.cps]
    const [item] = reordered.splice(idx, 1)
    reordered.splice(targetIdx, 0, item)
    const track = s.tracks.find((t) => t.id === s.activeTrackId)
    const cps = track ? reanchorAll(track, reordered) : reordered
    set({ cps, ...historyFlags(s.history) })
  },

  // 阈值/平滑窗口是纯展示态的调参,不需要走撤销栈(调参本身可随时再调回去)。
  setStatsOptions: (patch) => set((s) => ({ statsOptions: { ...s.statsOptions, ...patch } })),

  // 配速参数/起跑时间同理:纯展示态调参,不入撤销栈。
  setPaceParams: (patch) => set((s) => ({ paceParams: { ...s.paceParams, ...patch } })),
  setRaceStartTime: (iso) => set({ raceStartTime: iso }),

  loadProjectData: (data) =>
    set({
      tracks: data.tracks,
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
