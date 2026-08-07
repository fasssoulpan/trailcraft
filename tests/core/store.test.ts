import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../../src/state/appStore'
import { createTrack } from '../../src/core/model/track'
import { History } from '../../src/state/history'

function makeTrack(fileName: string) {
  return createTrack(
    { lon: [116.1, 116.2], lat: [39.9, 39.95] },
    { name: fileName, format: 'gpx', fileName },
  )
}

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      tracks: [], sourceMemory: {}, activeTrackId: undefined, hover: undefined,
      canUndo: false, canRedo: false, undoLabel: undefined, redoLabel: undefined, history: new History(),
    })
  })

  it('addTrack appends and sets active', () => {
    const t = makeTrack('a.gpx')
    useAppStore.getState().addTrack(t)
    const s = useAppStore.getState()
    expect(s.tracks).toEqual([t])
    expect(s.activeTrackId).toBe(t.id)
  })

  it('addTrack twice keeps both and activates the latest', () => {
    const t1 = makeTrack('a.gpx')
    const t2 = makeTrack('b.gpx')
    useAppStore.getState().addTrack(t1)
    useAppStore.getState().addTrack(t2)
    const s = useAppStore.getState()
    expect(s.tracks).toEqual([t1, t2])
    expect(s.activeTrackId).toBe(t2.id)
  })

  it('removeTrack removes only the target', () => {
    const t1 = makeTrack('a.gpx')
    const t2 = makeTrack('b.gpx')
    useAppStore.getState().addTrack(t1)
    useAppStore.getState().addTrack(t2)
    useAppStore.getState().removeTrack(t1.id)
    const s = useAppStore.getState()
    expect(s.tracks).toEqual([t2])
  })

  it('removeTrack of the active track clears activeTrackId', () => {
    const t1 = makeTrack('a.gpx')
    useAppStore.getState().addTrack(t1)
    expect(useAppStore.getState().activeTrackId).toBe(t1.id)
    useAppStore.getState().removeTrack(t1.id)
    expect(useAppStore.getState().activeTrackId).toBeUndefined()
  })

  it('removeTrack of a non-active track leaves activeTrackId untouched', () => {
    const t1 = makeTrack('a.gpx')
    const t2 = makeTrack('b.gpx')
    useAppStore.getState().addTrack(t1)
    useAppStore.getState().addTrack(t2) // active is t2
    useAppStore.getState().removeTrack(t1.id)
    expect(useAppStore.getState().activeTrackId).toBe(t2.id)
  })

  it('removeTrack of a hovered track clears hover', () => {
    const t1 = makeTrack('a.gpx')
    useAppStore.getState().addTrack(t1)
    useAppStore.getState().setHover({ trackId: t1.id, index: 0 })
    useAppStore.getState().removeTrack(t1.id)
    expect(useAppStore.getState().hover).toBeUndefined()
  })

  it('removeTrack of a non-hovered track leaves hover untouched', () => {
    const t1 = makeTrack('a.gpx')
    const t2 = makeTrack('b.gpx')
    useAppStore.getState().addTrack(t1)
    useAppStore.getState().addTrack(t2)
    useAppStore.getState().setHover({ trackId: t2.id, index: 1 })
    useAppStore.getState().removeTrack(t1.id)
    expect(useAppStore.getState().hover).toEqual({ trackId: t2.id, index: 1 })
  })

  it('setHover sets and clears', () => {
    useAppStore.getState().setHover({ trackId: 'trk_x', index: 5 })
    expect(useAppStore.getState().hover).toEqual({ trackId: 'trk_x', index: 5 })
    useAppStore.getState().setHover(undefined)
    expect(useAppStore.getState().hover).toBeUndefined()
  })

  it('rememberSource adds and overwrites an existing creator entry', () => {
    useAppStore.getState().rememberSource('COROS', 'wgs84')
    expect(useAppStore.getState().sourceMemory).toEqual({ COROS: 'wgs84' })
    useAppStore.getState().rememberSource('COROS', 'gcj02')
    expect(useAppStore.getState().sourceMemory).toEqual({ COROS: 'gcj02' })
    useAppStore.getState().rememberSource('Garmin', 'bd09')
    expect(useAppStore.getState().sourceMemory).toEqual({ COROS: 'gcj02', Garmin: 'bd09' })
  })

  describe('undo/redo', () => {
    it('applyOp changes tracks and enables undo', () => {
      const t1 = makeTrack('a.gpx')
      useAppStore.getState().addTrack(t1)
      expect(useAppStore.getState().canUndo).toBe(false)

      useAppStore.getState().applyOp('reverse', (tracks) => tracks.map((t) => ({ ...t, id: `${t.id}_rev` })))
      const s = useAppStore.getState()
      expect(s.tracks[0].id).toBe(`${t1.id}_rev`)
      expect(s.canUndo).toBe(true)
      expect(s.canRedo).toBe(false)
    })

    it('undo restores the previous track list', () => {
      const t1 = makeTrack('a.gpx')
      useAppStore.getState().addTrack(t1)
      useAppStore.getState().applyOp('reverse', (tracks) => tracks.map((t) => ({ ...t, id: `${t.id}_rev` })))
      useAppStore.getState().undo()
      const s = useAppStore.getState()
      expect(s.tracks).toEqual([t1])
      expect(s.canUndo).toBe(false)
      expect(s.canRedo).toBe(true)
    })

    it('undo then redo returns to the post-op list', () => {
      const t1 = makeTrack('a.gpx')
      useAppStore.getState().addTrack(t1)
      useAppStore.getState().applyOp('reverse', (tracks) => tracks.map((t) => ({ ...t, id: `${t.id}_rev` })))
      const afterOp = useAppStore.getState().tracks
      useAppStore.getState().undo()
      useAppStore.getState().redo()
      const s = useAppStore.getState()
      expect(s.tracks).toEqual(afterOp)
      expect(s.canUndo).toBe(true)
      expect(s.canRedo).toBe(false)
    })

    it('applyOp after undo clears redo', () => {
      const t1 = makeTrack('a.gpx')
      useAppStore.getState().addTrack(t1)
      useAppStore.getState().applyOp('reverse', (tracks) => tracks.map((t) => ({ ...t, id: `${t.id}_rev` })))
      useAppStore.getState().undo()
      expect(useAppStore.getState().canRedo).toBe(true)
      useAppStore.getState().applyOp('reverse again', (tracks) => tracks.map((t) => ({ ...t, id: `${t.id}_rev2` })))
      expect(useAppStore.getState().canRedo).toBe(false)
    })

    it('undo that removes the active track clears activeTrackId', () => {
      const t1 = makeTrack('a.gpx')
      useAppStore.getState().addTrack(t1)
      // simulate a split/join op that replaces t1 with a differently-id'd track
      useAppStore.getState().applyOp('split', () => [makeTrack('a-part.gpx')])
      const newTrackId = useAppStore.getState().tracks[0].id
      useAppStore.getState().setActive(newTrackId)
      useAppStore.getState().undo()
      const s = useAppStore.getState()
      expect(s.tracks).toEqual([t1])
      expect(s.activeTrackId).toBeUndefined()
    })

    it('undo/redo on empty history are no-ops', () => {
      const t1 = makeTrack('a.gpx')
      useAppStore.getState().addTrack(t1)
      useAppStore.getState().undo()
      expect(useAppStore.getState().tracks).toEqual([t1])
      useAppStore.getState().redo()
      expect(useAppStore.getState().tracks).toEqual([t1])
    })

    it('removeTrack is undoable: undo brings the removed track back', () => {
      const t1 = makeTrack('a.gpx')
      const t2 = makeTrack('b.gpx')
      useAppStore.getState().addTrack(t1)
      useAppStore.getState().addTrack(t2)
      useAppStore.getState().removeTrack(t1.id)
      expect(useAppStore.getState().tracks).toEqual([t2])
      expect(useAppStore.getState().canUndo).toBe(true)

      useAppStore.getState().undo()
      const s = useAppStore.getState()
      expect(s.tracks).toEqual([t1, t2])
      expect(s.canRedo).toBe(true)

      useAppStore.getState().redo()
      expect(useAppStore.getState().tracks).toEqual([t2])
    })

    it('mirrored undoLabel/redoLabel track the underlying history', () => {
      const t1 = makeTrack('a.gpx')
      useAppStore.getState().addTrack(t1)
      expect(useAppStore.getState().undoLabel).toBeUndefined()

      useAppStore.getState().applyOp('reverse', (tracks) => tracks.map((t) => ({ ...t, id: `${t.id}_rev` })))
      expect(useAppStore.getState().undoLabel).toBe('reverse')
      expect(useAppStore.getState().redoLabel).toBeUndefined()

      useAppStore.getState().undo()
      expect(useAppStore.getState().undoLabel).toBeUndefined()
      expect(useAppStore.getState().redoLabel).toBe('reverse')
    })
  })
})
