import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../../src/state/appStore'
import { createTrack } from '../../src/core/model/track'
import { History } from '../../src/state/history'
import { reverseTrack, removeAnomalies, simplifyTrack } from '../../src/core/toolbox/ops'

// color/lineWidth are set explicitly (arbitrary values) so these tracks
// pass through addTrack's backfillTrackStyles() unchanged -- see
// core/model/trackStyle.ts: a track that already carries both fields is
// returned as the exact same object, which is what lets the many
// `toEqual([t1, ...])` assertions below keep comparing against the literal
// each test constructed, instead of having to re-fetch the post-addTrack
// (palette-assigned) version from the store every time.
function makeTrack(fileName: string) {
  return createTrack(
    { lon: [116.1, 116.2], lat: [39.9, 39.95] },
    { name: fileName, format: 'gpx', fileName, color: '#123456', lineWidth: 2 },
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
  return createTrack({ lon, lat }, { name: 'oab', format: 'gpx', fileName: 'oab.gpx', color: '#123456', lineWidth: 2 })
}

/**
 * 单方向直线轨迹(不折返),21 个点,lon 从 116.000 递增到 116.020,lat 恒为
 * 39.9。用于 reverseTrack / removeAnomalies / simplifyTrack 的 CP 重新锚定
 * 测试——刻意避开 outAndBackTrack 那种同一经度出现两次的折返形状,这样
 * "最近点" 在几何上永远唯一,断言不会被单调约束的副作用干扰。
 */
function straightTrack() {
  const n = 21
  const lon = new Float64Array(n)
  const lat = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lon[i] = 116 + i * 0.001
    lat[i] = 39.9
  }
  return createTrack({ lon, lat }, { name: 'straight', format: 'gpx', fileName: 'straight.gpx' })
}

/**
 * 6 点共线直线轨迹,专门配合 simplifyTrack(tolerance=1) 用——完全共线时
 * Douglas-Peucker 在任何 tolerance>0 下都会把所有中间点全部丢弃,只留
 * 首尾两点,点数从 6 骤降到 2,足以暴露"抽稀后 CP anchorIndex 越界"的
 * 场景。
 */
function collinearTrack() {
  const lon = [0, 0.0001, 0.0002, 0.0003, 0.0004, 0.0005]
  const lat = [0, 0, 0, 0, 0, 0]
  return createTrack({ lon, lat }, { name: 'line', format: 'gpx', fileName: 'line.gpx' })
}

/**
 * 复刻 tests/core/toolbox.test.ts 里 removeAnomalies 的异常点用例:5 点中的
 * index 2 是一次~500m 的瞬移,被剔除后剩下 keep=[0,1,3,4],新轨迹只有 4 点。
 */
function anomalyTrack() {
  const dLat = 2 / 111320 // ~2m per step
  const jumpLat = 500 / 111320 // ~500m jump
  const lat = [0, dLat, 2 * dLat + jumpLat, 3 * dLat, 4 * dLat]
  const lon = [0, 0, 0, 0, 0]
  const time = [0, 1000, 2000, 3000, 4000]
  return createTrack({ lon, lat, time }, { name: 'anomaly', format: 'gpx', fileName: 'anomaly.gpx' })
}

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      tracks: [], sourceMemory: {}, activeTrackId: undefined, hover: undefined,
      cps: [], statsOptions: { threshold: 5, smoothWindow: 5 }, locateRequest: undefined,
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

  describe('locate requests', () => {
    it('requestLocate records the track id', () => {
      useAppStore.getState().requestLocate('trk_x')
      expect(useAppStore.getState().locateRequest?.trackId).toBe('trk_x')
    })

    // MapView watches `locateRequest` to drive the map camera (see
    // src/map/MapView.tsx); if it only compared trackId, a second click on
    // the same row would look like "no change" and the camera would never
    // move the second time. `seq` is what makes each click distinct and
    // observable even when trackId repeats.
    it('repeated requestLocate calls on the same track each bump seq, so each is separately observable', () => {
      useAppStore.getState().requestLocate('trk_x')
      const first = useAppStore.getState().locateRequest
      expect(first).toEqual({ trackId: 'trk_x', seq: 1 })

      useAppStore.getState().requestLocate('trk_x')
      const second = useAppStore.getState().locateRequest
      expect(second).toEqual({ trackId: 'trk_x', seq: 2 })
      expect(second).not.toBe(first) // a new object, so subscribers relying on reference equality also see the change
    })

    it('requestLocate on a different track updates trackId and still bumps seq', () => {
      useAppStore.getState().requestLocate('trk_a')
      useAppStore.getState().requestLocate('trk_b')
      expect(useAppStore.getState().locateRequest).toEqual({ trackId: 'trk_b', seq: 2 })
    })

    it('clearLocateRequest clears the pending request', () => {
      useAppStore.getState().requestLocate('trk_x')
      useAppStore.getState().clearLocateRequest()
      expect(useAppStore.getState().locateRequest).toBeUndefined()
    })
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

    it('an applyOp that replaces the active track (even with identical geometry) carries the cp trackId to the replacement, and undo restores the original binding', () => {
      const t = outAndBackTrack()
      useAppStore.getState().addTrack(t)
      useAppStore.getState().addCp('cp', 'CP1', [116.003, 39.9])
      const cpsBefore = useAppStore.getState().cps

      useAppStore.getState().applyOp('reverse', (tracks) => tracks.map((tr) => ({ ...tr, id: `${tr.id}_rev` })))
      const newTrackId = useAppStore.getState().tracks[0].id
      expect(newTrackId).toBe(`${t.id}_rev`)
      // Same geometry, same clickLngLat -> anchorIndex is unchanged by the
      // reanchor; only trackId follows the track's new id.
      expect(useAppStore.getState().cps).toEqual(cpsBefore.map((c) => ({ ...c, trackId: newTrackId })))

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

  describe('applyOp re-anchors cps against the resulting active track', () => {
    it('simplifyTrack: cp anchorIndex stays within the drastically-reduced bounds, near its original click', () => {
      const t = collinearTrack()
      useAppStore.getState().addTrack(t)
      // clicks exactly on the interior point at index 3
      useAppStore.getState().addCp('cp', 'MID', [0.0003, 0])
      expect(useAppStore.getState().cps[0].anchorIndex).toBe(3)

      useAppStore.getState().applyOp('抽稀', (tracks) => {
        const idx = tracks.findIndex((tr) => tr.id === t.id)
        const simplified = simplifyTrack(tracks[idx], 1)
        const next = [...tracks]
        next.splice(idx, 1, simplified)
        return next
      })

      const newTrack = useAppStore.getState().tracks[0]
      expect(newTrack.points.lon.length).toBe(2) // collapsed to endpoints only
      const cp = useAppStore.getState().cps[0]
      expect(cp.anchorIndex).toBeGreaterThanOrEqual(0)
      expect(cp.anchorIndex).toBeLessThan(newTrack.points.lon.length)
      // click was at lon 0.0003, closer to the surviving endpoint at 0.0005 than to 0
      expect(cp.anchorIndex).toBe(1)
    })

    it('reverseTrack: a cp near the old end re-anchors to a small (new-start) index, not the stale large one', () => {
      const t = straightTrack() // 21 points, lon 116.000..116.020
      useAppStore.getState().addTrack(t)
      useAppStore.getState().addCp('cp', 'NEAR-OLD-END', [116.018, 39.9]) // old index 18
      expect(useAppStore.getState().cps[0].anchorIndex).toBe(18)

      useAppStore.getState().applyOp('反向', (tracks) => {
        const idx = tracks.findIndex((tr) => tr.id === t.id)
        const r = reverseTrack(tracks[idx])
        const next = [...tracks]
        next.splice(idx, 1, r)
        return next
      })

      const cp = useAppStore.getState().cps[0]
      // old index 18 of 21 points lands at new index 20-18=2 after reversal
      expect(cp.anchorIndex).toBe(2)
      expect(cp.anchorIndex).toBeLessThan(5) // small: near the new start
      expect(cp.anchorIndex).not.toBe(18) // not the stale, unreanchored value
    })

    it('removeAnomalies: indices remain valid after points shift', () => {
      const t = anomalyTrack()
      useAppStore.getState().addTrack(t)
      // click exactly on the last point (old index 4), which survives the cleanup
      useAppStore.getState().addCp('cp', 'LAST', [0, 4 * (2 / 111320)])
      expect(useAppStore.getState().cps[0].anchorIndex).toBe(4)

      useAppStore.getState().applyOp('清洗异常点', (tracks) => {
        const idx = tracks.findIndex((tr) => tr.id === t.id)
        const cleaned = removeAnomalies(tracks[idx])
        const next = [...tracks]
        next.splice(idx, 1, cleaned)
        return next
      })

      const newTrack = useAppStore.getState().tracks[0]
      expect(newTrack.points.lon.length).toBe(4) // one anomaly dropped
      const cp = useAppStore.getState().cps[0]
      expect(cp.anchorIndex).toBeGreaterThanOrEqual(0)
      expect(cp.anchorIndex).toBeLessThan(newTrack.points.lon.length)
      expect(cp.anchorIndex).toBe(3) // old index 4 shifts to new index 3 (kept = [0,1,3,4])
    })

    it('a cp missing clickLngLat cannot be geometrically re-anchored, so its anchorIndex is clamped into the new bounds instead', () => {
      const t = straightTrack()
      useAppStore.getState().addTrack(t)
      useAppStore.getState().addCp('cp', 'NOLOC', [116.018, 39.9]) // anchorIndex 18
      const cpId = useAppStore.getState().cps[0].id
      useAppStore.getState().updateCp(cpId, { clickLngLat: undefined })
      expect(useAppStore.getState().cps[0].anchorIndex).toBe(18)
      expect(useAppStore.getState().cps[0].clickLngLat).toBeUndefined()

      useAppStore.getState().applyOp('抽稀', (tracks) => {
        const idx = tracks.findIndex((tr) => tr.id === t.id)
        const simplified = simplifyTrack(tracks[idx], 1) // collinear-ish -> collapses hard
        const next = [...tracks]
        next.splice(idx, 1, simplified)
        return next
      })

      const newTrack = useAppStore.getState().tracks[0]
      const cp = useAppStore.getState().cps[0]
      // no crash, no undefined/out-of-range value -- clamped into [0, newLength-1]
      expect(cp.anchorIndex).toBeGreaterThanOrEqual(0)
      expect(cp.anchorIndex).toBeLessThan(newTrack.points.lon.length)
    })

    it('undo restores both the old track and the old cp anchors together', () => {
      const t = straightTrack()
      useAppStore.getState().addTrack(t)
      useAppStore.getState().addCp('cp', 'NEAR-OLD-END', [116.018, 39.9])
      const tracksBefore = useAppStore.getState().tracks
      const cpsBefore = useAppStore.getState().cps
      expect(cpsBefore[0].anchorIndex).toBe(18)

      useAppStore.getState().applyOp('反向', (tracks) => {
        const idx = tracks.findIndex((tr) => tr.id === t.id)
        const r = reverseTrack(tracks[idx])
        const next = [...tracks]
        next.splice(idx, 1, r)
        return next
      })
      expect(useAppStore.getState().cps[0].anchorIndex).not.toBe(18) // re-anchored post-op

      useAppStore.getState().undo()
      expect(useAppStore.getState().tracks).toEqual(tracksBefore)
      expect(useAppStore.getState().cps).toEqual(cpsBefore)
      expect(useAppStore.getState().cps[0].anchorIndex).toBe(18) // old anchor restored, not left re-anchored
    })
  })

  describe('multi-track checkpoint binding (trackId)', () => {
    it('cps stay bound to the track they were placed on: track A cps are distinguishable from track B cps by trackId, and switching active track does not corrupt A\'s anchors', () => {
      const a = outAndBackTrack()
      useAppStore.getState().addTrack(a)
      useAppStore.getState().addCp('cp', 'A-CP1', [116.003, 39.9])
      const aCpBefore = useAppStore.getState().cps[0]

      const b = makeTrack('b.gpx')
      useAppStore.getState().addTrack(b) // b becomes active
      useAppStore.getState().addCp('cp', 'B-CP1', [116.15, 39.92])

      const allCps = useAppStore.getState().cps
      expect(allCps).toHaveLength(2)
      expect(allCps.filter((c) => c.trackId === a.id)).toEqual([aCpBefore])
      expect(allCps.filter((c) => c.trackId === b.id)).toHaveLength(1)

      // Switching the active track back to A is a bare field assignment now
      // that CPs carry their own trackId -- it must not re-anchor or
      // otherwise mutate A's cp.
      useAppStore.getState().setActive(a.id)
      expect(useAppStore.getState().cps.find((c) => c.trackId === a.id)).toEqual(aCpBefore)
      useAppStore.getState().setActive(b.id)
      expect(useAppStore.getState().cps.find((c) => c.trackId === a.id)).toEqual(aCpBefore)
    })

    it('a toolbox op on track A carries A\'s cps to the replacement track and leaves track B\'s cps completely untouched', () => {
      const a = outAndBackTrack()
      useAppStore.getState().addTrack(a)
      useAppStore.getState().addCp('cp', 'A-CP1', [116.003, 39.9])

      const b = makeTrack('b.gpx')
      useAppStore.getState().addTrack(b)
      useAppStore.getState().addCp('cp', 'B-CP1', [116.15, 39.92])
      const bCpBefore = useAppStore.getState().cps.find((c) => c.trackId === b.id)!

      useAppStore.getState().setActive(a.id)
      useAppStore.getState().applyOp('反向', (tracks) => {
        const idx = tracks.findIndex((tr) => tr.id === a.id)
        const r = reverseTrack(tracks[idx])
        const next = [...tracks]
        next.splice(idx, 1, r)
        return next
      })

      const newA = useAppStore.getState().tracks.find((t) => t.id !== b.id)!
      expect(newA.id).not.toBe(a.id) // toolbox ops always mint a new track id

      const allCps = useAppStore.getState().cps
      expect(allCps).toHaveLength(2)
      const aCp = allCps.find((c) => c.name === 'A-CP1')!
      expect(aCp.trackId).toBe(newA.id) // carried forward to the replacement, not orphaned
      const bCp = allCps.find((c) => c.name === 'B-CP1')!
      expect(bCp).toEqual(bCpBefore) // a different track's cp: completely untouched
    })

    it('deleting a track removes its checkpoints and leaves the other track\'s checkpoints untouched', () => {
      const a = outAndBackTrack()
      useAppStore.getState().addTrack(a)
      useAppStore.getState().addCp('cp', 'A-CP1', [116.003, 39.9])
      const b = makeTrack('b.gpx')
      useAppStore.getState().addTrack(b)
      useAppStore.getState().addCp('cp', 'B-CP1', [116.15, 39.92])
      const bCpBefore = useAppStore.getState().cps.find((c) => c.trackId === b.id)!
      expect(useAppStore.getState().cps).toHaveLength(2)

      useAppStore.getState().removeTrack(a.id)
      const remaining = useAppStore.getState().cps
      expect(remaining).toEqual([bCpBefore])
    })

    it('undo restores a deleted track\'s checkpoints together with the track itself', () => {
      const a = outAndBackTrack()
      useAppStore.getState().addTrack(a)
      useAppStore.getState().addCp('cp', 'A-CP1', [116.003, 39.9])
      const cpsBefore = useAppStore.getState().cps

      useAppStore.getState().removeTrack(a.id)
      expect(useAppStore.getState().cps).toHaveLength(0)

      useAppStore.getState().undo()
      expect(useAppStore.getState().cps).toEqual(cpsBefore)
      expect(useAppStore.getState().tracks).toEqual([a])
    })
  })
})
