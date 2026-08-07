import { describe, it, expect } from 'vitest'
import { History } from '../../src/state/history'

describe('History', () => {
  it('push then undo returns the pushed state and enables redo', () => {
    const h = new History<number>()
    h.push('inc', 1) // pre-change state was 1
    expect(h.canUndo).toBe(true)
    expect(h.canRedo).toBe(false)
    const s = h.undo(2) // caller currently holds 2 (post-change)
    expect(s?.state).toBe(1)
    expect(h.canRedo).toBe(true)
    expect(h.canUndo).toBe(false)
  })

  it('undo followed by redo round-trips back to the post-change state', () => {
    const h = new History<number>()
    h.push('inc', 1)
    const undone = h.undo(2)
    expect(undone?.state).toBe(1)
    const redone = h.redo(undone!.state)
    expect(redone?.state).toBe(2)
    expect(h.canRedo).toBe(false)
    expect(h.canUndo).toBe(true)
  })

  it('a new push after undo clears the redo stack', () => {
    const h = new History<number>()
    h.push('a', 1)
    h.undo(2)
    expect(h.canRedo).toBe(true)
    h.push('b', 2)
    expect(h.canRedo).toBe(false)
  })

  it('undo/redo on empty stacks return undefined and flags are false', () => {
    const h = new History<number>()
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.undo(1)).toBeUndefined()
    expect(h.redo(1)).toBeUndefined()
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
  })

  it('multiple sequential undos unwind in reverse order', () => {
    const h = new History<number>()
    h.push('a', 1) // pre-change: 1, becomes 2
    h.push('b', 2) // pre-change: 2, becomes 3
    h.push('c', 3) // pre-change: 3, becomes 4
    let cur = 4
    const first = h.undo(cur)
    expect(first?.state).toBe(3)
    cur = first!.state
    const second = h.undo(cur)
    expect(second?.state).toBe(2)
    cur = second!.state
    const third = h.undo(cur)
    expect(third?.state).toBe(1)
    cur = third!.state
    expect(h.canUndo).toBe(false)
    expect(h.undo(cur)).toBeUndefined()
  })

  it('labels are preserved on undo/redo snapshots', () => {
    const h = new History<number>()
    h.push('rename', 1)
    const undone = h.undo(2)
    expect(undone?.label).toBe('rename')
    const redone = h.redo(undone!.state)
    expect(redone?.label).toBe('rename')
  })

  it('undoLabel/redoLabel report the top-of-stack label, undefined when empty', () => {
    const h = new History<number>()
    expect(h.undoLabel).toBeUndefined()
    expect(h.redoLabel).toBeUndefined()
    h.push('a', 1)
    h.push('b', 2)
    expect(h.undoLabel).toBe('b')
    const undone = h.undo(3)
    expect(h.undoLabel).toBe('a')
    expect(h.redoLabel).toBe('b')
    h.redo(undone!.state)
    expect(h.redoLabel).toBeUndefined()
  })

  it('clear empties both stacks', () => {
    const h = new History<number>()
    h.push('a', 1)
    h.undo(2)
    expect(h.canUndo || h.canRedo).toBe(true)
    h.clear()
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.undoLabel).toBeUndefined()
    expect(h.redoLabel).toBeUndefined()
  })

  it('depth cap drops the oldest entries while keeping the most recent ones', () => {
    const h = new History<number>(3)
    h.push('a', 1)
    h.push('b', 2)
    h.push('c', 3)
    h.push('d', 4) // exceeds cap of 3, drops 'a'
    let cur = 5
    const first = h.undo(cur) // undoes 'd', restores pre-change state 4
    expect(first?.label).toBe('d')
    expect(first?.state).toBe(4)
    cur = first!.state
    const second = h.undo(cur)
    expect(second?.label).toBe('c')
    expect(second?.state).toBe(3)
    cur = second!.state
    const third = h.undo(cur)
    expect(third?.label).toBe('b')
    expect(third?.state).toBe(2)
    // 'a' was dropped by the depth cap, so nothing left to undo
    expect(h.canUndo).toBe(false)
  })

  it('depth cap of 1 keeps only the single most recent entry', () => {
    const h = new History<number>(1)
    h.push('a', 1)
    h.push('b', 2)
    const undone = h.undo(3)
    expect(undone?.label).toBe('b')
    expect(undone?.state).toBe(2)
    expect(h.canUndo).toBe(false)
  })
})
