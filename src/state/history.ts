/**
 * 通用撤销/重做栈。
 *
 * 快照只持有对状态对象的引用,不做深拷贝——这样才能承受住 33 万点级别的
 * 真实轨迹数据。这个"零拷贝"设计成立的前提是:被记录的状态永远不会被原地
 * 修改(参见 core/toolbox/ops.ts 的注释:所有轨迹操作都返回全新对象)。一旦
 * 有任何代码路径对 tracks 数组或 Track 本身做 in-place mutation,历史记录里
 * 保存的"旧快照"会被悄悄改写,undo/redo 就会读到错误的状态。
 *
 * ## API 设计:为什么 undo/redo 需要调用方传入"当前状态"
 *
 * 一个看起来自然、但是错的实现:
 * ```ts
 * undo() { const s = this.undoStack.pop(); if (s) this.redoStack.push(s); return s }
 * redo() { const s = this.redoStack.pop(); if (s) this.undoStack.push(s); return s }
 * ```
 * `push(label, state)` 记录的是"变更前"的状态(pre-change snapshot)。按照上面
 * 的写法,`undo()` 把这个 pre-change 快照本身推入了 redoStack —— 但那正是
 * undo 刚刚恢复出来的状态,而不是 undo 之前(也就是变更后)的状态。于是
 * `redo()` 弹出的还是同一个 pre-change 快照,相当于把 undo 又执行了一遍,
 * undo→redo 并不能回到"变更后"的状态,形不成正确的来回跳转。
 *
 * 根治办法:undo/redo 都以调用方持有的"当前状态"为参数,由 History 负责把
 * 它推入另一侧的栈,再弹出并返回目标状态。这样每次 undo 都会把"当前状态"
 * (即 redo 应该恢复到的状态)如实存入 redoStack,undo→redo 就能精确复原。
 */

export interface Snapshot<T> {
  label: string
  state: T
}

/** 撤销栈深度上限:长时间编辑会不断 push,不加上限会无界增长。 */
const DEFAULT_MAX_DEPTH = 50

export class History<T> {
  private undoStack: Snapshot<T>[] = []
  private redoStack: Snapshot<T>[] = []
  private readonly maxDepth: number

  constructor(maxDepth: number = DEFAULT_MAX_DEPTH) {
    this.maxDepth = maxDepth
  }

  /**
   * 记录一次变更前的状态,并清空 redo 栈(新的分支历史使旧的重做路径失效)。
   * 超过深度上限时丢弃最旧的条目,只保留最近 maxDepth 条。
   */
  push(label: string, state: T): void {
    this.undoStack.push({ label, state })
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.splice(0, this.undoStack.length - this.maxDepth)
    }
    this.redoStack = []
  }

  /**
   * 撤销。`current` 是调用方当前持有的状态(即变更后的状态),会被存入
   * redoStack 供后续 redo() 使用。返回应当恢复到的状态(变更前的状态);
   * undo 栈为空时返回 undefined,且不触碰任一栈。
   */
  undo(current: T): Snapshot<T> | undefined {
    const s = this.undoStack.pop()
    if (!s) return undefined
    this.redoStack.push({ label: s.label, state: current })
    return s
  }

  /**
   * 重做。`current` 是调用方当前持有的状态(即撤销后的状态),会被存入
   * undoStack 供后续 undo() 使用。返回应当恢复到的状态(重做后的状态);
   * redo 栈为空时返回 undefined,且不触碰任一栈。
   */
  redo(current: T): Snapshot<T> | undefined {
    const s = this.redoStack.pop()
    if (!s) return undefined
    this.undoStack.push({ label: s.label, state: current })
    return s
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** undo 将要撤销的那次操作的标签(即撤销栈顶)。 */
  get undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label
  }

  /** redo 将要重做的那次操作的标签(即重做栈顶)。 */
  get redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label
  }

  /** 清空撤销/重做历史。 */
  clear(): void {
    this.undoStack = []
    this.redoStack = []
  }
}
