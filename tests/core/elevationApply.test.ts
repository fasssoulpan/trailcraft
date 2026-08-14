import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import { applySampledElevation } from '../../src/core/toolbox/elevation'

function mk(lon: number[], lat: number[]): Track {
  const t = createTrack({ lon, lat }, { name: '手绘', format: 'gpx', fileName: 'drawn.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

describe('applySampledElevation', () => {
  it('writes all heights when every point sampled successfully', () => {
    const t = mk([0, 1, 2], [0, 0, 0])
    const result = applySampledElevation(t, [10, 20, 30])
    expect(result.sampledCount).toBe(3)
    expect(result.failedCount).toBe(0)
    expect(Array.from(result.track.points.ele!)).toEqual([10, 20, 30])
  })

  it('does not mutate the source track', () => {
    const t = mk([0, 1, 2], [0, 0, 0])
    applySampledElevation(t, [10, 20, 30])
    expect(t.points.ele).toBeUndefined()
  })

  it('produces a new track with a new id and suffixed name', () => {
    const t = mk([0, 1], [0, 0])
    const result = applySampledElevation(t, [5, 6])
    expect(result.track.id).not.toBe(t.id)
    expect(result.track.meta.name).toBe('手绘 ·高程')
  })

  it('uses NaN (never 0) for individually failed points, using a fake sampler that fails every third point', () => {
    const lon = [0, 1, 2, 3, 4, 5]
    const lat = [0, 0, 0, 0, 0, 0]
    const t = mk(lon, lat)
    // Fake sampler: every 3rd point "fails" (undefined), rest succeed with a
    // distinguishable height so the mapping back onto indices is verified.
    const heights = lon.map((_, i) => (i % 3 === 2 ? undefined : 100 + i))
    const result = applySampledElevation(t, heights)
    expect(result.sampledCount).toBe(4)
    expect(result.failedCount).toBe(2)
    const ele = Array.from(result.track.points.ele!)
    expect(ele[0]).toBe(100)
    expect(ele[1]).toBe(101)
    expect(Number.isNaN(ele[2])).toBe(true)
    expect(ele[3]).toBe(103)
    expect(ele[4]).toBe(104)
    expect(Number.isNaN(ele[5])).toBe(true)
  })

  it('leaves the track without an ele column at all on total failure (never fabricates zeros)', () => {
    const t = mk([0, 1, 2], [0, 0, 0])
    const heights: (number | undefined)[] = [undefined, undefined, undefined]
    const result = applySampledElevation(t, heights)
    expect(result.sampledCount).toBe(0)
    expect(result.failedCount).toBe(3)
    // Total failure returns the ORIGINAL track object, not a derived one --
    // no ele column fabricated, nothing to undo, no new id minted.
    expect(result.track).toBe(t)
    expect(result.track.points.ele).toBeUndefined()
  })

  it('throws when heights.length does not match the point count', () => {
    const t = mk([0, 1, 2], [0, 0, 0])
    expect(() => applySampledElevation(t, [1, 2])).toThrow()
    expect(() => applySampledElevation(t, [1, 2, 3, 4])).toThrow()
  })

  it('preserves an existing cumDist/time/hr untouched alongside the new ele', () => {
    const t = mk([0, 1, 2], [0, 0, 0])
    const beforeCum = Array.from(t.points.cumDist!)
    const result = applySampledElevation(t, [1, 2, 3])
    expect(Array.from(result.track.points.cumDist!)).toEqual(beforeCum)
  })
})
