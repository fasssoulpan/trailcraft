import { describe, it, expect } from 'vitest'
import { createTrack } from '../../src/core/model/track'
import { checkpointsFromWaypoints, inferCpKind } from '../../src/core/pipeline/checkpointImport'
import type { KmlWaypoint } from '../../src/core/parsers/kml'

function straightTrack(n = 21) {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.001)
  const lat = Array.from({ length: n }, () => 39.9)
  return createTrack({ lon, lat }, { name: 't', format: 'kml', fileName: 't.kml' })
}

describe('inferCpKind', () => {
  it('classifies a name containing 补给 as an aid station', () => {
    expect(inferCpKind('CP3补给站-40km')).toBe('aid')
  })
  it('defaults to plain cp for anything else', () => {
    expect(inferCpKind('CP1二道营-12.5km')).toBe('cp')
    expect(inferCpKind('起终点-庆典广场')).toBe('cp')
  })
})

describe('checkpointsFromWaypoints', () => {
  it('returns [] for an empty waypoint list', () => {
    expect(checkpointsFromWaypoints(straightTrack(), [])).toEqual([])
  })

  it('produces one CheckPoint per waypoint, bound to the track id, with the click position preserved', () => {
    const track = straightTrack()
    const waypoints: KmlWaypoint[] = [
      { name: 'CP1', lon: 116.005, lat: 39.9 },
      { name: 'CP2补给', lon: 116.015, lat: 39.9 },
    ]
    const cps = checkpointsFromWaypoints(track, waypoints)
    expect(cps).toHaveLength(2)
    expect(cps[0].trackId).toBe(track.id)
    expect(cps[0].name).toBe('CP1')
    expect(cps[0].kind).toBe('cp')
    expect(cps[1].kind).toBe('aid')
    expect(cps[0].clickLngLat).toEqual([116.005, 39.9])
  })

  it('anchors via anchorMonotonic: indices are non-decreasing in waypoint (document) order', () => {
    // Out-and-back track: index 0..10 outbound (lon 116.000..116.010),
    // 11..20 return (lon 116.009..116.000) -- same shape as anchor.test.ts.
    const n = 21
    const lon = new Array<number>(n)
    const lat = new Array<number>(n).fill(39.9)
    for (let i = 0; i <= 10; i++) lon[i] = 116 + i * 0.001
    for (let i = 0; i <= 9; i++) lon[11 + i] = 116.009 - i * 0.001
    const track = createTrack({ lon, lat }, { name: 't', format: 'kml', fileName: 't.kml' })

    // Two waypoints at the same physical spot, listed in document order as
    // "outbound pass" then "return pass" -- exactly the out-and-back case
    // anchorMonotonic exists to get right.
    const waypoints: KmlWaypoint[] = [
      { name: 'CP-out', lon: 116.003, lat: 39.9 },
      { name: 'CP-back', lon: 116.003, lat: 39.9 },
    ]
    const cps = checkpointsFromWaypoints(track, waypoints)
    expect(cps[0].anchorIndex).toBe(3)
    expect(cps[1].anchorIndex).toBeGreaterThan(10)
    expect(cps[1].anchorIndex).toBeGreaterThan(cps[0].anchorIndex)
  })
})
