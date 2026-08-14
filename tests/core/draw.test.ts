import { describe, it, expect } from 'vitest'
import { haversine } from '../../src/core/geo/distance'
import {
  DENSIFY_SPACING_M,
  densifyVertices,
  trackFromVertices,
  totalVertexDistance,
  insertVertexAt,
  appendVertex,
  moveVertex,
  deleteVertex,
  type Vertex,
} from '../../src/core/toolbox/draw'

const META = { name: '手绘', format: 'gpx' as const, fileName: 'drawn.gpx' }

// A ~1km-per-side square near (0, 0), corners far enough apart that each
// side gets densified (DENSIFY_SPACING_M is 30m).
const LAT0 = 0
const DEG_PER_KM = 1 / 111.32 // rough, fine for this scale
const SQUARE: Vertex[] = [
  [0, LAT0],
  [DEG_PER_KM, LAT0],
  [DEG_PER_KM, LAT0 + DEG_PER_KM],
  [0, LAT0 + DEG_PER_KM],
  [0, LAT0], // closed
]

describe('densifyVertices', () => {
  it('preserves every original vertex, in order', () => {
    const out = densifyVertices(SQUARE)
    // every original vertex must appear at its relative order in `out`
    let cursor = 0
    for (const v of SQUARE) {
      const idx = out.findIndex((o, i) => i >= cursor && o[0] === v[0] && o[1] === v[1])
      expect(idx).toBeGreaterThanOrEqual(cursor)
      cursor = idx + 1
    }
  })

  it('inserts intermediate points on long segments, none on short ones', () => {
    const out = densifyVertices(SQUARE)
    expect(out.length).toBeGreaterThan(SQUARE.length)
    const short: Vertex[] = [
      [0, 0],
      [0.0001, 0], // ~11m, well under the 30m spacing
    ]
    expect(densifyVertices(short)).toEqual(short)
  })

  it('returns input unchanged for 0 or 1 vertices', () => {
    expect(densifyVertices([])).toEqual([])
    expect(densifyVertices([[1, 2]])).toEqual([[1, 2]])
  })

  it('does not mutate the input array', () => {
    const input = [...SQUARE]
    const before = JSON.stringify(input)
    densifyVertices(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('trackFromVertices', () => {
  it("a drawn square's total distance matches the sum of its sides", () => {
    // Ground truth: sum of the 4 haversine side lengths on the raw vertices.
    let expected = 0
    for (let i = 1; i < SQUARE.length; i++) {
      expected += haversine(SQUARE[i - 1][0], SQUARE[i - 1][1], SQUARE[i][0], SQUARE[i][1])
    }
    const track = trackFromVertices(SQUARE, META)
    const total = track.points.cumDist![track.points.cumDist!.length - 1]
    // Densification interpolates linearly in lon/lat along each existing
    // straight segment, so it should not change total path length at all
    // beyond floating-point/haversine-vs-linear-chord rounding. 0.5%
    // generously covers that rounding while still catching any real bug
    // (e.g. accidentally summing densified-point-to-point great-circle
    // distances against a linear interpolation, which would drift much
    // more on a ~1km-per-side square).
    expect(total).toBeGreaterThan(0)
    expect(Math.abs(total - expected) / expected).toBeLessThan(0.005)
  })

  it('has no ele/time/hr columns at all (not NaN-filled)', () => {
    const track = trackFromVertices(SQUARE, META)
    expect(track.points.ele).toBeUndefined()
    expect(track.points.time).toBeUndefined()
    expect(track.points.hr).toBeUndefined()
  })

  it('densification keeps cumDist monotonic (non-decreasing)', () => {
    const track = trackFromVertices(SQUARE, META)
    const cum = track.points.cumDist!
    expect(cum[0]).toBe(0)
    for (let i = 1; i < cum.length; i++) expect(cum[i]).toBeGreaterThanOrEqual(cum[i - 1])
  })

  it('preserves the original vertices among the densified points', () => {
    const track = trackFromVertices(SQUARE, META)
    const { lon, lat } = track.points
    for (const v of SQUARE) {
      let found = false
      for (let i = 0; i < lon.length; i++) {
        if (lon[i] === v[0] && lat[i] === v[1]) { found = true; break }
      }
      expect(found).toBe(true)
    }
  })

  it('throws for zero vertices', () => {
    expect(() => trackFromVertices([], META)).toThrow()
  })

  it('does not throw for a single vertex; produces a 1-point track with cumDist [0]', () => {
    const track = trackFromVertices([[10, 20]], META)
    expect(track.points.lon.length).toBe(1)
    expect(Array.from(track.points.cumDist!)).toEqual([0])
  })

  it('does not throw for two identical vertices; produces a degenerate zero-length track', () => {
    const track = trackFromVertices([[10, 20], [10, 20]], META)
    expect(track.points.lon.length).toBe(2)
    expect(Array.from(track.points.cumDist!)).toEqual([0, 0])
  })

  it('throws for non-finite coordinates', () => {
    expect(() => trackFromVertices([[0, 0], [NaN, 1]], META)).toThrow()
    expect(() => trackFromVertices([[0, 0], [Infinity, 1]], META)).toThrow()
  })
})

describe('totalVertexDistance', () => {
  it('matches the sum of haversine segment lengths', () => {
    let expected = 0
    for (let i = 1; i < SQUARE.length; i++) {
      expected += haversine(SQUARE[i - 1][0], SQUARE[i - 1][1], SQUARE[i][0], SQUARE[i][1])
    }
    expect(totalVertexDistance(SQUARE)).toBeCloseTo(expected, 6)
  })

  it('is 0 for 0 or 1 vertices', () => {
    expect(totalVertexDistance([])).toBe(0)
    expect(totalVertexDistance([[0, 0]])).toBe(0)
  })
})

describe('vertex edit helpers', () => {
  const base: Vertex[] = [[0, 0], [1, 0], [2, 0]]

  it('insertVertexAt inserts without mutating input', () => {
    const before = [...base]
    const next = insertVertexAt(base, 1, [0.5, 0])
    expect(next).toEqual([[0, 0], [0.5, 0], [1, 0], [2, 0]])
    expect(base).toEqual(before)
  })

  it('insertVertexAt allows appending at index === length', () => {
    const next = insertVertexAt(base, base.length, [3, 0])
    expect(next[next.length - 1]).toEqual([3, 0])
  })

  it('insertVertexAt throws for out-of-range index', () => {
    expect(() => insertVertexAt(base, -1, [0, 0])).toThrow()
    expect(() => insertVertexAt(base, base.length + 1, [0, 0])).toThrow()
  })

  it('appendVertex appends without mutating input', () => {
    const before = [...base]
    const next = appendVertex(base, [3, 0])
    expect(next).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]])
    expect(base).toEqual(before)
  })

  it('moveVertex replaces one entry without mutating input', () => {
    const before = [...base]
    const next = moveVertex(base, 1, [1, 5])
    expect(next).toEqual([[0, 0], [1, 5], [2, 0]])
    expect(base).toEqual(before)
  })

  it('moveVertex throws for out-of-range index', () => {
    expect(() => moveVertex(base, -1, [0, 0])).toThrow()
    expect(() => moveVertex(base, base.length, [0, 0])).toThrow()
  })

  it('deleteVertex removes one entry without mutating input', () => {
    const before = [...base]
    const next = deleteVertex(base, 1)
    expect(next).toEqual([[0, 0], [2, 0]])
    expect(base).toEqual(before)
  })

  it('deleteVertex throws for out-of-range index', () => {
    expect(() => deleteVertex(base, -1)).toThrow()
    expect(() => deleteVertex(base, base.length)).toThrow()
  })
})

// Sanity check on the chosen spacing constant, so a future edit to it doesn't
// silently drift outside the documented "~DEM resolution" rationale without
// a test noticing.
describe('DENSIFY_SPACING_M', () => {
  it('is a positive, sane spacing in metres', () => {
    expect(DENSIFY_SPACING_M).toBeGreaterThan(0)
    expect(DENSIFY_SPACING_M).toBeLessThan(200)
  })
})
