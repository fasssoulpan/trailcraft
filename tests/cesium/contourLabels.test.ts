import { describe, expect, it } from 'vitest'
import {
  contourLabelPlacements,
  CONTOUR_INDEX_EVERY,
  type ContourHeightGrid,
} from '../../src/cesium/contourLabels'

/** A grid whose height depends only on the row (a perfect east-west slope). */
function slopeNorth(rows: number, cols: number, baseM: number, perRowM: number): ContourHeightGrid {
  const heights = new Float64Array(rows * cols)
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = baseM + r * perRowM
  return { heights, rows, cols, west: 100, south: 30, east: 100.1, north: 30.1 }
}

describe('contourLabelPlacements', () => {
  it('puts labels exactly on contour levels', () => {
    // 0m at the south edge rising 10m per row: levels 100, 200, ... are all
    // crossed somewhere inside.
    const labels = contourLabelPlacements(slopeNorth(21, 21, 0, 10), 100)
    expect(labels.length).toBeGreaterThan(0)
    for (const l of labels) expect(l.elevationM % 100).toBe(0)
  })

  it('finds contours running east-west, which a row-only scan would miss', () => {
    // Height varies only with latitude, so every contour runs east-west and
    // no east-west edge ever crosses one. Only the north-south scan finds
    // these; a regression to single-axis scanning returns [].
    const labels = contourLabelPlacements(slopeNorth(21, 21, 0, 10), 50)
    expect(labels.length).toBeGreaterThan(0)
  })

  it('finds contours running north-south too', () => {
    const rows = 21
    const cols = 21
    const heights = new Float64Array(rows * cols)
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) heights[r * cols + c] = c * 10
    const labels = contourLabelPlacements(
      { heights, rows, cols, west: 100, south: 30, east: 100.1, north: 30.1 },
      50,
    )
    expect(labels.length).toBeGreaterThan(0)
  })

  it('interpolates the crossing position rather than snapping to a sample', () => {
    // One usable edge spanning 0m..100m, with spacing 60 so exactly one
    // level (60m) falls strictly inside it. The crossing is 60% of the way
    // across, not at either sample.
    const heights = new Float64Array([0, 100, NaN, NaN])
    const labels = contourLabelPlacements(
      { heights, rows: 2, cols: 2, west: 0, south: 0, east: 1, north: 1 },
      60,
    )
    expect(labels).toHaveLength(1)
    expect(labels[0].elevationM).toBe(60)
    expect(labels[0].lon).toBeCloseTo(0.6, 10)
  })

  it('marks every Nth level as an index contour', () => {
    const labels = contourLabelPlacements(slopeNorth(41, 41, 0, 10), 10, { maxLabels: 500 })
    expect(labels.length).toBeGreaterThan(0)
    for (const l of labels) {
      const level = Math.round(l.elevationM / 10)
      expect(l.index).toBe(level % CONTOUR_INDEX_EVERY === 0)
    }
  })

  it('prefers index contours when it has to drop labels', () => {
    // Far more crossings than the cap: what survives should be index levels.
    const labels = contourLabelPlacements(slopeNorth(101, 101, 0, 5), 10, { maxLabels: 5 })
    expect(labels).toHaveLength(5)
    expect(labels.every((l) => l.index)).toBe(true)
  })

  it('never exceeds the label cap', () => {
    const labels = contourLabelPlacements(slopeNorth(101, 101, 0, 5), 10, { maxLabels: 7 })
    expect(labels.length).toBeLessThanOrEqual(7)
  })

  it('keeps labels apart', () => {
    const grid = slopeNorth(101, 101, 0, 5)
    const labels = contourLabelPlacements(grid, 10, { maxLabels: 200 })
    const minSep = Math.max(grid.east - grid.west, grid.north - grid.south) * 0.11
    const lonScale = Math.cos(((grid.north + grid.south) / 2) * (Math.PI / 180))
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const d = Math.hypot((labels[i].lon - labels[j].lon) * lonScale, labels[i].lat - labels[j].lat)
        expect(d).toBeGreaterThanOrEqual(minSep - 1e-12)
      }
    }
  })

  it('is deterministic for the same view', () => {
    const a = contourLabelPlacements(slopeNorth(51, 51, 0, 7), 25)
    const b = contourLabelPlacements(slopeNorth(51, 51, 0, 7), 25)
    expect(a).toEqual(b)
  })

  it('skips samples with no resident terrain tile instead of inventing heights', () => {
    // Only the southern edge has two real samples; the northern row is
    // entirely unresolved. Every label must come from that one edge (0..100m
    // crosses 50 and 100) with finite coordinates -- a NaN must never leak
    // into a position, and must not suppress its usable neighbour either.
    const heights = new Float64Array([0, 100, NaN, NaN])
    const labels = contourLabelPlacements(
      { heights, rows: 2, cols: 2, west: 0, south: 0, east: 1, north: 1 },
      50,
    )
    expect(labels.map((l) => l.elevationM).sort((a, b) => a - b)).toEqual([50, 100])
    expect(labels.every((l) => Number.isFinite(l.lon) && Number.isFinite(l.lat))).toBe(true)
    expect(labels.every((l) => l.lat === 0)).toBe(true)
  })

  it('emits a level sitting exactly on a sample only once', () => {
    // Columns 0/50/100 with spacing 50: the middle sample IS the 50m level
    // and is shared by the two edges either side of it. Emitting from both
    // would stack two identical labels on the same point -- visible as a
    // bolder, slightly fuzzy number. Two rows, so two legitimate 50m labels
    // (one per row) and no more.
    const heights = new Float64Array([0, 50, 100, 0, 50, 100])
    const labels = contourLabelPlacements(
      { heights, rows: 2, cols: 3, west: 0, south: 0, east: 1, north: 1 },
      50,
      { maxLabels: 100 },
    )
    expect(labels.filter((l) => l.elevationM === 50)).toHaveLength(2)
    expect(labels.filter((l) => l.elevationM === 100)).toHaveLength(2)
  })

  it('rejects degenerate input', () => {
    const g = slopeNorth(5, 5, 0, 10)
    expect(contourLabelPlacements(g, 0)).toEqual([])
    expect(contourLabelPlacements(g, -10)).toEqual([])
    expect(contourLabelPlacements({ ...g, rows: 1 }, 10)).toEqual([])
    expect(contourLabelPlacements({ ...g, east: g.west }, 10)).toEqual([])
    expect(contourLabelPlacements(g, 10, { maxLabels: 0 })).toEqual([])
  })

  it('returns nothing for flat terrain', () => {
    const rows = 10
    const cols = 10
    const heights = new Float64Array(rows * cols).fill(1234)
    expect(
      contourLabelPlacements({ heights, rows, cols, west: 0, south: 0, east: 1, north: 1 }, 50),
    ).toEqual([])
  })
})
