import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '../../src/state/appStore'
import { createTrack } from '../../src/core/model/track'

function makeTrack(fileName: string) {
  return createTrack(
    { lon: [116.1, 116.2], lat: [39.9, 39.95] },
    { name: fileName, format: 'gpx', fileName },
  )
}

describe('appStore', () => {
  beforeEach(() => {
    useAppStore.setState({ tracks: [], sourceMemory: {}, activeTrackId: undefined, hover: undefined })
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
})
