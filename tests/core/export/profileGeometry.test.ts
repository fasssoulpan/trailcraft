import { describe, it, expect } from 'vitest'
import type { ProfileData } from '../../../src/profile/profileRender'
import {
  computeProfileGeometry, computeProfilePoints, niceTicks, selectDistanceTicksKm, selectElevationTicks, placeCpLabels,
} from '../../../src/core/export/profileGeometry'

function profile(distKm: number[], ele: number[]): ProfileData {
  const dist = Float64Array.from(distKm.map((k) => k * 1000))
  const eleArr = Float32Array.from(ele)
  const idx = Uint32Array.from(distKm.map((_, i) => i))
  const finite = ele.filter((e) => Number.isFinite(e))
  return {
    dist,
    ele: eleArr,
    idx,
    totalDist: dist[dist.length - 1] ?? 0,
    minEle: finite.length > 0 ? Math.min(...finite) : 0,
    maxEle: finite.length > 0 ? Math.max(...finite) : 0,
  }
}

describe('computeProfileGeometry', () => {
  it('maps distance 0 to the left plot edge and totalDist to the right plot edge', () => {
    const p = profile([0, 5, 10], [1000, 1200, 1100])
    const g = computeProfileGeometry(p, 1000, 400)
    expect(g.toX(0)).toBeCloseTo(g.plot.x0, 5)
    expect(g.toX(p.totalDist)).toBeCloseTo(g.plot.x1, 5)
  })

  it('maps the padded max elevation near the top and min elevation near the bottom (y grows downward)', () => {
    const p = profile([0, 5, 10], [1000, 1200, 1100])
    const g = computeProfileGeometry(p, 1000, 400)
    expect(g.toY(g.maxEle)).toBeCloseTo(g.plot.y0, 5)
    expect(g.toY(g.minEle)).toBeCloseTo(g.plot.y1, 5)
    // higher elevation -> smaller y (nearer the top)
    expect(g.toY(1200)).toBeLessThan(g.toY(1000))
  })

  it('a flat track (min === max elevation) does not divide by zero', () => {
    const p = profile([0, 5, 10], [1000, 1000, 1000])
    const g = computeProfileGeometry(p, 1000, 400)
    expect(Number.isFinite(g.toY(1000))).toBe(true)
    expect(g.minEle).toBeLessThan(g.maxEle) // padding still applied
  })

  it('a zero-distance track does not divide by zero and clamps x to the left edge', () => {
    const p = profile([0], [1000])
    const g = computeProfileGeometry(p, 1000, 400)
    expect(g.toX(0)).toBeCloseTo(g.plot.x0, 5)
    expect(Number.isFinite(g.toX(0))).toBe(true)
  })

  it('respects custom margins for the plot rectangle', () => {
    const p = profile([0, 10], [1000, 1100])
    const g = computeProfileGeometry(p, 1000, 400, { top: 10, right: 10, bottom: 10, left: 100 })
    expect(g.plot.x0).toBe(100)
    expect(g.plot.x1).toBe(990)
  })
})

describe('computeProfilePoints', () => {
  it('marks NaN elevation samples as non-finite but still produces an x/y pair', () => {
    const p = profile([0, 5, 10], [1000, NaN, 1100])
    const g = computeProfileGeometry(p, 1000, 400)
    const pts = computeProfilePoints(p, g)
    expect(pts).toHaveLength(3)
    expect(pts[0].finite).toBe(true)
    expect(pts[1].finite).toBe(false)
    expect(pts[2].finite).toBe(true)
    expect(Number.isFinite(pts[1].y)).toBe(true)
  })
})

describe('niceTicks', () => {
  it('returns a single value for a degenerate [min, min] range', () => {
    expect(niceTicks(5, 5, 6)).toEqual([5])
  })

  it('covers the requested range at small scale (0-10)', () => {
    const ticks = niceTicks(0, 10, 6)
    expect(ticks[0]).toBeLessThanOrEqual(0)
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(10)
    expect(ticks.length).toBeGreaterThanOrEqual(3)
  })

  it('covers the requested range at large scale (0-42195, marathon distance in metres)', () => {
    const ticks = niceTicks(0, 42195, 6)
    expect(ticks[0]).toBeLessThanOrEqual(0)
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(42195)
  })

  it('ticks are strictly ascending', () => {
    const ticks = niceTicks(500, 1500, 5)
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1])
  })
})

describe('selectDistanceTicksKm', () => {
  it('a zero-distance track yields just [0]', () => {
    expect(selectDistanceTicksKm(0)).toEqual([0])
  })

  it('ticks stay within [0, totalKm]', () => {
    const totalDistM = 100_000 // 100km race
    const ticks = selectDistanceTicksKm(totalDistM, 6)
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(0)
      expect(t).toBeLessThanOrEqual(100)
    }
    expect(ticks.length).toBeGreaterThan(1)
  })
})

describe('selectElevationTicks', () => {
  it('a flat range yields a single tick', () => {
    expect(selectElevationTicks(1000, 1000)).toEqual([1000])
  })

  it('a wide range (0m to 5000m, e.g. a big alpine race) yields multiple ascending ticks', () => {
    const ticks = selectElevationTicks(0, 5000, 5)
    expect(ticks.length).toBeGreaterThan(2)
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1])
  })
})

describe('placeCpLabels', () => {
  const geom = { toX: (distM: number) => distM / 100 } // 1px per 100m, for easy arithmetic

  it('CPs far apart all land on row 0', () => {
    const cps = [
      { id: 'a', name: 'CP1', distM: 0 },
      { id: 'b', name: 'CP2', distM: 10000 },
      { id: 'c', name: 'CP3', distM: 20000 },
    ]
    const placed = placeCpLabels(cps, geom, 44)
    expect(placed.every((p) => p.row === 0)).toBe(true)
  })

  it('two CPs close together (within minGapPx) are staggered onto different rows', () => {
    const cps = [
      { id: 'a', name: 'CP1', distM: 1000 }, // x = 10
      { id: 'b', name: 'CP2', distM: 1200 }, // x = 12, only 2px away
    ]
    const placed = placeCpLabels(cps, geom, 44)
    const rowA = placed.find((p) => p.id === 'a')!.row
    const rowB = placed.find((p) => p.id === 'b')!.row
    expect(rowA).not.toBe(rowB)
  })

  it('a third CP close to both of the first two goes to a third row', () => {
    const cps = [
      { id: 'a', name: 'CP1', distM: 1000 },
      { id: 'b', name: 'CP2', distM: 1200 },
      { id: 'c', name: 'CP3', distM: 1300 },
    ]
    const placed = placeCpLabels(cps, geom, 44)
    const rows = new Set(placed.map((p) => p.row))
    expect(rows.size).toBe(3)
  })

  it('placement is independent of input order (always sorted by distance first)', () => {
    const cps = [
      { id: 'b', name: 'CP2', distM: 10000 },
      { id: 'a', name: 'CP1', distM: 0 },
    ]
    const placed = placeCpLabels(cps, geom, 44)
    expect(placed.map((p) => p.id)).toEqual(['a', 'b'])
  })
})
