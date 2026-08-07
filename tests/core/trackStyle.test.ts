import { describe, it, expect } from 'vitest'
import { createTrack } from '../../src/core/model/track'
import { TRACK_PALETTE, DEFAULT_LINE_WIDTH, nextTrackColor, backfillTrackStyles } from '../../src/core/model/trackStyle'

function mk(fileName: string, color?: string, lineWidth?: number) {
  return createTrack(
    { lon: [0, 1], lat: [0, 0] },
    { name: fileName, format: 'gpx', fileName, color, lineWidth },
  )
}

describe('TRACK_PALETTE', () => {
  it('does not include the hover-marker / CP-marker blue (#1d4ed8)', () => {
    // src/map/trackLayer.ts uses #1d4ed8 for both the hover marker and the
    // 'cp' kind checkpoint marker -- a track auto-assigned that exact blue
    // would be indistinguishable from either on the map.
    expect(TRACK_PALETTE).not.toContain('#1d4ed8')
  })

  it('has no duplicate entries', () => {
    expect(new Set(TRACK_PALETTE).size).toBe(TRACK_PALETTE.length)
  })
})

describe('nextTrackColor', () => {
  it('returns the first palette colour when nothing is assigned yet', () => {
    expect(nextTrackColor([])).toBe(TRACK_PALETTE[0])
  })

  it('cycles through the palette in order for consecutive tracks', () => {
    const colors: string[] = []
    for (let i = 0; i < TRACK_PALETTE.length; i++) {
      const c = nextTrackColor(colors)
      colors.push(c)
    }
    expect(colors).toEqual([...TRACK_PALETTE])
  })

  it('wraps back to the start once the palette is exhausted', () => {
    const colors = [...TRACK_PALETTE] // one full cycle already assigned
    const next = nextTrackColor(colors)
    expect(next).toBe(TRACK_PALETTE[0])
  })

  it('never returns the same colour as the immediately preceding track, even across a palette wraparound', () => {
    const colors = [...TRACK_PALETTE] // last assigned = TRACK_PALETTE[last]
    const next = nextTrackColor(colors)
    expect(next).not.toBe(colors[colors.length - 1])
  })

  it('skips ahead when the naive next slot would collide with a manually-overridden previous colour', () => {
    // Simulate: two tracks assigned normally, then the user manually
    // recolours the 2nd one to exactly what the 3rd would naively get.
    const colors = [TRACK_PALETTE[0], TRACK_PALETTE[2]] // user overrode index 1's colour to palette[2]
    const next = nextTrackColor(colors)
    expect(next).not.toBe(TRACK_PALETTE[2])
  })
})

describe('backfillTrackStyles', () => {
  it('assigns distinct cycling colours and the default width to tracks with no style yet', () => {
    const tracks = [mk('a.gpx'), mk('b.gpx'), mk('c.gpx')]
    const styled = backfillTrackStyles(tracks)
    expect(styled.map((t) => t.meta.color)).toEqual([TRACK_PALETTE[0], TRACK_PALETTE[1], TRACK_PALETTE[2]])
    expect(styled.every((t) => t.meta.lineWidth === DEFAULT_LINE_WIDTH)).toBe(true)
  })

  it('leaves an already-styled track completely untouched (same object reference)', () => {
    const styledAlready = mk('a.gpx', '#abcdef', 5)
    const [result] = backfillTrackStyles([styledAlready])
    expect(result).toBe(styledAlready)
    expect(result.meta.color).toBe('#abcdef')
    expect(result.meta.lineWidth).toBe(5)
  })

  it('fills gaps in a mixed list (some pre-styled, some not) without disturbing the pre-styled ones', () => {
    const already = mk('a.gpx', '#abcdef', 5)
    const blank = mk('b.gpx')
    const styled = backfillTrackStyles([already, blank])
    expect(styled[0]).toBe(already) // untouched
    expect(styled[1].meta.color).toBeDefined()
    expect(styled[1].meta.color).not.toBe('#abcdef') // distinct from its predecessor
    expect(styled[1].meta.lineWidth).toBe(DEFAULT_LINE_WIDTH)
  })
})
