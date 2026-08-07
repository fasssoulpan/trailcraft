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

/**
 * 往返(out-and-back)轨迹,同一份合成数据用在 tests/core/anchor.test.ts:
 * 出程 index 0..10 (lon 116.000..116.010),回程 index 11..20 原路折返
 * (lon 116.009..116.000)。lon=116.003 在出程 index 3 与回程 index 17 各
 * 出现一次,用来验证 store 层的 CP 增删改是否正确地把"锚定无错趟"接到了
 * anchorMonotonic 上,而不只是简单地各自独立找最近点。
 */
function outAndBackTrack() {
  const n = 21
  const lon = new Float64Array(n)
  const lat = new Float64Array(n)
  for (let i = 0; i <= 10; i++) {
    lon[i] = 116 + i * 0.001
    lat[i] = 39.9
  }
  for (let i = 0; i <= 9; i++) {
    lon[11 + i] = 116.009 - i * 0.001
    lat[11 + i] = 39.9
  }
  return createTrack({ lon, lat }, { name: 'oab', format: 'gpx', fileName: 'oab.gpx' })
}

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      tracks: [], sourceMemory: {}, activeTrackId: undefined, hover: undefined,
      cps: [], statsOptions: { threshold: 5, smoothWindow: 5 },
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

  describe('checkpoints', () => {
    it('addCp re-anchors all CPs in list order (out-and-back headline case)', () => {
      const t = outAndBackTrack()
      useAppStore.getState().addTrack(t)
      useAppStore.getState().addCp('cp', 'CP1', [116.003, 39.9])
      useAppStore.getState().addCp('cp', 'CP2', [116.003, 39.9])
      const cps = useAppStore.getState().cps
      expect(cps).toHaveLength(2)
      expect(cps[0].anchorIndex).toBe(3)
      expect(cps[1].anchorIndex).toBeGreaterThan(10)
    })

    it('addCp forces a later CP forward even when its true nearest point lies before an earlier anchor', () => {
      const t = outAndBackTrack()
      useAppStore.getState().addTrack(t)
      useAppStore.getState().addCp('cp', 'CP1', [116.008, 39.9]) // anchors at 8
      useAppStore.getState().addCp('cp', 'CP2', [116.001, 39.9]) // globally-nearest is index 1, before CP1
      const cps = useAppStore.getState().cps
      expect(cps[0].anchorIndex).toBe(8)
      expect(cps[1].anchorIndex).toBe(19)
    })

    it('removeCp re-anchors the remaining CPs from scratch', () => {
      const t = outAndBackTrack()
      useAppStore.getState().addTrack(t)
      useAppStore.getState().addCp('cp', 'CP1', [116.008, 39.9])
      useAppStore.getState().addCp('cp', 'CP2', [116.001, 39.9])
      let cps = useAppStore.getState().cps
      expect(cps[1].anchorIndex).toBe(19) // forced forward while CP1 exists

      useAppStore.getState().removeCp(cps[0].id)
      cps = useAppStore.getState().cps
      expect(cps).toHaveLength(1)
      expect(cps[0].name).toBe('CP2')
      expect(cps[0].anchorIndex).toBe(1) // no longer constrained by CP1, back to its true nearest point
    })

    it('reorderCp changes anchoring order and re-anchors', () => {
      const t = outAndBackTrack()
      useAppStore.getState().addTrack(t)
      useAppStore.getState().addCp('cp', 'A', [116.003, 39.9])
      useAppStore.getState().addCp('cp', 'B', [116.003, 39.9])
      let cps = useAppStore.getState().cps
      expect(cps[0].name).toBe('A')
      expect(cps[0].anchorIndex).toBe(3)
      expect(cps[1].name).toBe('B')
      expect(cps[1].anchorIndex).toBeGreaterThan(10)

      useAppStore.getState().reorderCp(cps[1].id, -1) // move B ahead of A
      cps = useAppStore.getState().cps
      expect(cps[0].name).toBe('B')
      expect(cps[0].anchorIndex).toBe(3) // B now anchors first, claims index 3
      expect(cps[1].name).toBe('A')
      expect(cps[1].anchorIndex).toBeGreaterThan(10) // A pushed to the return leg
    })

    it('reorderCp out of bounds is a no-op', () => {
      const t = outAndBackTrack()
      useAppStore.getState().addTrack(t)
      useAppStore.getState().addCp('cp', 'A', [116.003, 39.9])
      const [cp] = useAppStore.getState().cps
      useAppStore.getState().reorderCp(cp.id, -1) // already first
      expect(useAppStore.getState().cps).toEqual([cp])
      useAppStore.getState().reorderCp(cp.id, 1) // already last
      expect(useAppStore.getState().cps).toEqual([cp])
    })

    it('updateCp with a direct anchorIndex patch is preserved, not overwritten by re-anchoring', () => {
      const t = outAndBackTrack()
      useAppStore.getState().addTrack(t)
      useAppStore.getState().addCp('cp', 'CP1', [116.003, 39.9])
      const cpId = useAppStore.getState().cps[0].id
      useAppStore.getState().updateCp(cpId, { anchorIndex: 15 })
      expect(useAppStore.getState().cps[0].anchorIndex).toBe(15)
    })

    it('updateCp merges non-anchor fields (kind, cutoffTime) without touching anchorIndex', () => {
      const t = outAndBackTrack()
      useAppStore.getState().addTrack(t)
      useAppStore.getState().addCp('cp', 'CP1', [116.003, 39.9])
      const cpId = useAppStore.getState().cps[0].id
      const before = useAppStore.getState().cps[0].anchorIndex
      useAppStore.getState().updateCp(cpId, { kind: 'aid', cutoffTime: '2026-08-07T14:00:00+08:00' })
      const cp = useAppStore.getState().cps[0]
      expect(cp.kind).toBe('aid')
      expect(cp.cutoffTime).toBe('2026-08-07T14:00:00+08:00')
      expect(cp.anchorIndex).toBe(before)
    })

    it('undo restores both tracks and cps together', () => {
      const t = outAndBackTrack()
      useAppStore.getState().addTrack(t)
      useAppStore.getState().addCp('cp', 'CP1', [116.003, 39.9])
      expect(useAppStore.getState().cps).toHaveLength(1)

      useAppStore.getState().addCp('cp', 'CP2', [116.008, 39.9])
      expect(useAppStore.getState().cps).toHaveLength(2)

      useAppStore.getState().undo()
      expect(useAppStore.getState().cps).toHaveLength(1)
      expect(useAppStore.getState().tracks).toEqual([t])
      expect(useAppStore.getState().canRedo).toBe(true)

      useAppStore.getState().redo()
      expect(useAppStore.getState().cps).toHaveLength(2)
    })

    it('a track-only applyOp still snapshots cps, so undoing it leaves cps untouched', () => {
      const t = outAndBackTrack()
      useAppStore.getState().addTrack(t)
      useAppStore.getState().addCp('cp', 'CP1', [116.003, 39.9])
      const cpsBefore = useAppStore.getState().cps

      useAppStore.getState().applyOp('reverse', (tracks) => tracks.map((tr) => ({ ...tr, id: `${tr.id}_rev` })))
      expect(useAppStore.getState().cps).toEqual(cpsBefore)

      useAppStore.getState().undo()
      expect(useAppStore.getState().cps).toEqual(cpsBefore)
      expect(useAppStore.getState().tracks).toEqual([t])
    })

    it('setStatsOptions merges into the existing options', () => {
      useAppStore.getState().setStatsOptions({ threshold: 7 })
      expect(useAppStore.getState().statsOptions).toEqual({ threshold: 7, smoothWindow: 5 })
      useAppStore.getState().setStatsOptions({ smoothWindow: 9 })
      expect(useAppStore.getState().statsOptions).toEqual({ threshold: 7, smoothWindow: 9 })
    })

    it('addCp without an active track is a no-op', () => {
      useAppStore.getState().addCp('cp', 'CP1', [116.003, 39.9])
      expect(useAppStore.getState().cps).toHaveLength(0)
    })
  })
})
