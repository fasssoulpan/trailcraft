import { create } from 'zustand'
import type { Crs, Track } from '../core/model/track'
import { History } from './history'

export interface HoverState { trackId: string; index: number } // 全轨迹点索引

/**
 * 可撤销的可编辑状态切片。刻意做成对象而不是裸的 Track[] ——
 * 后续任务会把 checkpoints 之类的状态也纳入撤销范围,届时只需在这个对象上
 * 加字段,不会是一次破坏性变更。
 */
export interface EditableState {
  tracks: Track[]
}

interface AppState {
  tracks: Track[]
  activeTrackId?: string
  hover?: HoverState
  sourceMemory: Record<string, Crs>
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
  undo(): void
  redo(): void
}

/**
 * undo/redo 之后,若 activeTrackId/hover 指向的轨迹已经不存在于恢复出的
 * tracks 列表中,清掉它们——这与 removeTrack 里已经修好的"悬空引用"是同一
 * 类 bug,只是触发路径从"删除单条轨迹"变成了"整体状态被替换"。
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

export const useAppStore = create<AppState>((set, get) => ({
  tracks: [], sourceMemory: {}, canUndo: false, canRedo: false, history: new History<EditableState>(),
  addTrack: (t) => set((s) => ({ tracks: [...s.tracks, t], activeTrackId: t.id })),
  removeTrack: (id) => {
    const s = get()
    s.history.push('删除轨迹', { tracks: s.tracks })
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

  applyOp: (label, fn) => {
    const s = get()
    s.history.push(label, { tracks: s.tracks })
    const tracks = fn(s.tracks)
    const reconciled = reconcileDangling(tracks, s.activeTrackId, s.hover)
    set({ tracks, ...reconciled, ...historyFlags(s.history) })
  },

  undo: () => {
    const s = get()
    const snap = s.history.undo({ tracks: s.tracks })
    if (!snap) return
    const reconciled = reconcileDangling(snap.state.tracks, s.activeTrackId, s.hover)
    set({ tracks: snap.state.tracks, ...reconciled, ...historyFlags(s.history) })
  },

  redo: () => {
    const s = get()
    const snap = s.history.redo({ tracks: s.tracks })
    if (!snap) return
    const reconciled = reconcileDangling(snap.state.tracks, s.activeTrackId, s.hover)
    set({ tracks: snap.state.tracks, ...reconciled, ...historyFlags(s.history) })
  },
}))
