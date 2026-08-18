import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import type { CheckPoint } from '../../src/core/model/checkpoint'
import {
  anchorPhotosToTrack,
  PHOTO_ANCHOR_MAX_DISTANCE_M,
  PHOTO_MERGE_DISTANCE_M,
  type PhotoGpsInput,
} from '../../src/core/pipeline/photoAnchor'

// 纬度方向 1 度约 111320m,用它把"米"换算成纬度偏移量——纬度方向的偏移
// 不受经度换算里 cos(lat) 那一层复杂度影响,haversine 算出的距离和这个
// 换算几乎精确一致,足够用来构造"恰好在阈值内/外"的测试坐标。
const METERS_PER_DEGREE_LAT = 111320
function metersToLatOffset(m: number): number {
  return m / METERS_PER_DEGREE_LAT
}

// straightTrack (below) runs entirely along a fixed longitude, varying only
// latitude -- so a query offset purely in latitude generally lands ON the
// track's own line (near some other point), not "away from it". Tests that
// need a point genuinely off the track use a longitude offset instead: at
// this fixed test latitude (~39.9N), 1 degree of longitude is about
// METERS_PER_DEGREE_LAT * cos(lat) metres, which is the standard flat-earth
// approximation good enough for these small (hundreds-of-metres) offsets.
const TEST_LAT = 39.9
const METERS_PER_DEGREE_LON = METERS_PER_DEGREE_LAT * Math.cos((TEST_LAT * Math.PI) / 180)
function metersToLonOffset(m: number): number {
  return m / METERS_PER_DEGREE_LON
}

function straightTrack(n = 51): Track {
  const lon = Array.from({ length: n }, () => 116)
  const lat = Array.from({ length: n }, (_, i) => TEST_LAT + i * metersToLatOffset(20)) // 每点间隔约 20m
  return createTrack({ lon, lat }, { name: 't', format: 'kml', fileName: 't.kml' })
}

function outAndBack(): Track {
  // 出程 index 0..10(纬度递增),回程 index 11..20(原路折返),和
  // tests/core/anchor.test.ts 同一个形状,只是把经度换成纬度偏移。
  const n = 21
  const lon = new Array<number>(n).fill(116)
  const lat = new Array<number>(n)
  for (let i = 0; i <= 10; i++) lat[i] = 39.9 + i * metersToLatOffset(100)
  for (let i = 0; i <= 9; i++) lat[11 + i] = 39.9 + (9 - i) * metersToLatOffset(100)
  return createTrack({ lon, lat }, { name: 'oab', format: 'kml', fileName: 'oab.kml' })
}

function photo(patch: Partial<PhotoGpsInput> & { lat: number; lon: number }): PhotoGpsInput {
  return { name: 'IMG', photoUrl: 'data:image/jpeg;base64,x', ...patch }
}

function existingCp(patch: Partial<CheckPoint> & { trackId: string; anchorIndex: number }): CheckPoint {
  return { id: `cp_${patch.anchorIndex}`, name: 'existing', kind: 'cp', ...patch }
}

describe('anchorPhotosToTrack', () => {
  it('returns empty result for an empty photo list', () => {
    const t = straightTrack()
    expect(anchorPhotosToTrack(t, [], [])).toEqual({ created: [], updated: [], rejected: [] })
  })

  it('creates a CP at the nearest track point for a photo close to the track', () => {
    const t = straightTrack()
    // Point index 10 sits at lat 39.9 + 10*20m offset.
    const targetLat = 39.9 + 10 * metersToLatOffset(20)
    const p = photo({ name: 'trailhead', lon: 116, lat: targetLat })
    const result = anchorPhotosToTrack(t, [], [p])
    expect(result.rejected).toEqual([])
    expect(result.updated).toEqual([])
    expect(result.created).toHaveLength(1)
    const cp = result.created[0]
    expect(cp.trackId).toBe(t.id)
    expect(cp.name).toBe('trailhead')
    expect(cp.anchorIndex).toBe(10)
    expect(cp.photoUrl).toBe(p.photoUrl)
    expect(cp.clickLngLat).toEqual([116, targetLat])
    // Default kind: 'landmark' -- a photo-derived checkpoint isn't
    // necessarily an aid station/gear check, and 'landmark' is the one kind
    // that's explicitly reserved for manual/non-inferred assignment
    // (see checkpointImport.ts's inferCpKind doc comment).
    expect(cp.kind).toBe('landmark')
  })

  it('accepts a custom kind override', () => {
    const t = straightTrack()
    const targetLat = 39.9 + 10 * metersToLatOffset(20)
    const p = photo({ lon: 116, lat: targetLat })
    const result = anchorPhotosToTrack(t, [], [p], 'aid')
    expect(result.created[0].kind).toBe('aid')
  })

  it('rejects a photo far from the track, reporting the actual distance', () => {
    const t = straightTrack()
    // Same latitude as track point index 10 (so the along-track component of
    // the distance is ~0) but offset 300m in longitude -- i.e. genuinely off
    // to the side of the track, not just "further along" it.
    const sameLatAsIndex10 = TEST_LAT + 10 * metersToLatOffset(20)
    const farLon = 116 + metersToLonOffset(300)
    const p = photo({ lon: farLon, lat: sameLatAsIndex10 })
    const result = anchorPhotosToTrack(t, [], [p])
    expect(result.created).toEqual([])
    expect(result.updated).toEqual([])
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0].input).toBe(p)
    expect(result.rejected[0].distanceM).toBeGreaterThan(PHOTO_ANCHOR_MAX_DISTANCE_M)
  })

  it('accepts a photo just inside the boundary distance and rejects one just past it', () => {
    const t = straightTrack()
    const sameLatAsIndex10 = TEST_LAT + 10 * metersToLatOffset(20)
    const justInsideLon = 116 + metersToLonOffset(PHOTO_ANCHOR_MAX_DISTANCE_M - 5)
    const justOutsideLon = 116 + metersToLonOffset(PHOTO_ANCHOR_MAX_DISTANCE_M + 30)
    const insideResult = anchorPhotosToTrack(t, [], [photo({ lon: justInsideLon, lat: sameLatAsIndex10 })])
    expect(insideResult.rejected).toEqual([])
    expect(insideResult.created).toHaveLength(1)
    const outsideResult = anchorPhotosToTrack(t, [], [photo({ lon: justOutsideLon, lat: sameLatAsIndex10 })])
    expect(outsideResult.created).toEqual([])
    expect(outsideResult.rejected).toHaveLength(1)
  })

  it('out-and-back: pre-pass ordering anchors two same-spot photos to successive passes, never the same one', () => {
    const t = outAndBack()
    const spotLat = 39.9 + 3 * metersToLatOffset(100) // outbound index 3 / return index 17
    const outbound = photo({ name: 'out', lon: 116, lat: spotLat })
    const back = photo({ name: 'back', lon: 116, lat: spotLat })
    const result = anchorPhotosToTrack(t, [], [outbound, back])
    expect(result.rejected).toEqual([])
    expect(result.created).toHaveLength(2)
    const byName = Object.fromEntries(result.created.map((c) => [c.name, c]))
    expect(byName.out.anchorIndex).toBe(3)
    expect(byName.back.anchorIndex).toBeGreaterThan(10)
    expect(byName.back.anchorIndex).toBeGreaterThan(byName.out.anchorIndex)
  })

  it('merges into an existing nearby CP instead of creating a duplicate', () => {
    const t = straightTrack()
    const targetLat = 39.9 + 10 * metersToLatOffset(20)
    const near = existingCp({ trackId: t.id, anchorIndex: 10, clickLngLat: [116, targetLat], name: '补给站', kind: 'aid' })
    const nudgedLat = targetLat + metersToLatOffset(30) // well within PHOTO_MERGE_DISTANCE_M
    const p = photo({ lon: 116, lat: nudgedLat })
    const result = anchorPhotosToTrack(t, [near], [p])
    expect(result.created).toEqual([])
    expect(result.rejected).toEqual([])
    expect(result.updated).toHaveLength(1)
    expect(result.updated[0].id).toBe(near.id)
    expect(result.updated[0].photoUrl).toBe(p.photoUrl)
    // Everything else about the existing CP is preserved untouched.
    expect(result.updated[0].name).toBe('补给站')
    expect(result.updated[0].kind).toBe('aid')
    expect(result.updated[0].anchorIndex).toBe(10)
  })

  it('does not merge into an existing CP belonging to a different track', () => {
    const t = straightTrack()
    const targetLat = 39.9 + 10 * metersToLatOffset(20)
    const otherTrackCp = existingCp({ trackId: 'other_track', anchorIndex: 10, clickLngLat: [116, targetLat] })
    const p = photo({ lon: 116, lat: targetLat })
    const result = anchorPhotosToTrack(t, [otherTrackCp], [p])
    expect(result.updated).toEqual([])
    expect(result.created).toHaveLength(1)
  })

  it('a photo further than the merge distance but within the accept distance creates a new CP rather than merging', () => {
    const t = straightTrack()
    const targetLat = 39.9 + 10 * metersToLatOffset(20)
    const near = existingCp({ trackId: t.id, anchorIndex: 10, clickLngLat: [116, targetLat] })
    const farEnoughLat = targetLat + metersToLatOffset(PHOTO_MERGE_DISTANCE_M + 20)
    const p = photo({ lon: 116, lat: farEnoughLat })
    const result = anchorPhotosToTrack(t, [near], [p])
    expect(result.updated).toEqual([])
    expect(result.created).toHaveLength(1)
  })

  it('re-running the same batch is idempotent: second pass merges into the CPs the first pass created', () => {
    const t = straightTrack()
    const targetLat = 39.9 + 20 * metersToLatOffset(20)
    const p = photo({ name: 'aid1', lon: 116, lat: targetLat })
    const first = anchorPhotosToTrack(t, [], [p])
    expect(first.created).toHaveLength(1)
    const second = anchorPhotosToTrack(t, first.created, [p])
    expect(second.created).toEqual([])
    expect(second.updated).toHaveLength(1)
    expect(second.updated[0].id).toBe(first.created[0].id)
  })
})
