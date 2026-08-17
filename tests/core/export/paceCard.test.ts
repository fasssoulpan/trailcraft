import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../../src/core/model/track'
import { computeCumDist } from '../../../src/core/geo/distance'
import type { CheckPoint } from '../../../src/core/model/checkpoint'
import type { PaceParams } from '../../../src/core/pace/models'
import { buildRouteBookData } from '../../../src/core/export/routeBookData'
import {
  rowsPerCard, paginatePaceCardRows, selectPaceCardColumns, buildPaceCardRows, buildPaceCardSvgPages,
  DEFAULT_CARD_DIMENSIONS_MM, DEFAULT_PACE_CARD_COLUMNS, PACE_CARD_COLUMN_ORDER,
  HEADER_HEIGHT_MM, ROW_HEIGHT_MM, FOOTER_HEIGHT_MM,
  type PaceCardRow, type PaceCardDimensionsMm,
} from '../../../src/core/export/paceCard'

function climbingTrack(n = 400): Track {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.0005)
  const lat = Array.from({ length: n }, () => 39.9)
  const ele = Array.from({ length: n }, (_, i) => 1000 + i * 5)
  const t = createTrack({ lon, lat, ele }, { name: '百公里越野赛', format: 'gpx', fileName: 'race.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

function cp(id: string, name: string, anchorIndex: number, trackId: string, cutoffTime?: string): CheckPoint {
  return { id, trackId, name, kind: 'cp', anchorIndex, cutoffTime }
}

const pace: PaceParams = {
  model: 'practical', flatPaceSecPerKm: 360, vamMPerH: 600, descentFactor: 0.25, fatiguePctPerHour: 3,
}
const statsOptions = { threshold: 5, smoothWindow: 5 }
const startIso = '2026-08-07T06:00:00+08:00'

function manyCpsData(count: number) {
  const t = climbingTrack()
  const step = Math.floor(390 / (count + 1))
  const cps = Array.from({ length: count }, (_, i) => cp(`c${i}`, `CP${i + 1}`, (i + 1) * step, t.id))
  return buildRouteBookData(t, cps, pace, statsOptions, startIso)
}

describe('rowsPerCard', () => {
  it('the default 180x60mm card fits a positive, small number of rows', () => {
    const n = rowsPerCard(DEFAULT_CARD_DIMENSIONS_MM)
    expect(n).toBeGreaterThan(0)
    // sanity check against the formula this function implements
    const expected = Math.floor((DEFAULT_CARD_DIMENSIONS_MM.heightMm - HEADER_HEIGHT_MM - FOOTER_HEIGHT_MM) / ROW_HEIGHT_MM)
    expect(n).toBe(expected)
  })

  it('a taller card fits more rows', () => {
    const small: PaceCardDimensionsMm = { widthMm: 180, heightMm: 60 }
    const tall: PaceCardDimensionsMm = { widthMm: 180, heightMm: 120 }
    expect(rowsPerCard(tall)).toBeGreaterThan(rowsPerCard(small))
  })

  it('a card too short for even header+footer still returns at least 1 row (never 0 or negative)', () => {
    const tiny: PaceCardDimensionsMm = { widthMm: 180, heightMm: 5 }
    expect(rowsPerCard(tiny)).toBe(1)
  })
})

describe('paginatePaceCardRows', () => {
  const fakeRows: PaceCardRow[] = Array.from({ length: 25 }, (_, i) => ({
    name: `CP${i}`, mileageKm: '1.0', ascentM: '10', eta: '10:00', cutoff: '11:00', margin: '+1:00', level: 'green',
  }))

  it('splits rows across multiple pages when they exceed one card', () => {
    const perPage = rowsPerCard(DEFAULT_CARD_DIMENSIONS_MM)
    const pages = paginatePaceCardRows(fakeRows, DEFAULT_CARD_DIMENSIONS_MM)
    expect(pages.length).toBe(Math.ceil(fakeRows.length / perPage))
    for (const page of pages) {
      expect(page.rows.length).toBeLessThanOrEqual(perPage)
      expect(page.rows.length).toBeGreaterThan(0)
    }
  })

  it('every row appears exactly once, in original order, across all pages', () => {
    const pages = paginatePaceCardRows(fakeRows, DEFAULT_CARD_DIMENSIONS_MM)
    const flattened = pages.flatMap((p) => p.rows)
    expect(flattened.map((r) => r.name)).toEqual(fakeRows.map((r) => r.name))
  })

  it('every page reports the same total pageCount and a correct 0-based pageIndex', () => {
    const pages = paginatePaceCardRows(fakeRows, DEFAULT_CARD_DIMENSIONS_MM)
    pages.forEach((page, i) => {
      expect(page.pageIndex).toBe(i)
      expect(page.pageCount).toBe(pages.length)
    })
  })

  it('rows that fit on a single page produce exactly one page', () => {
    const few = fakeRows.slice(0, 2)
    const pages = paginatePaceCardRows(few, DEFAULT_CARD_DIMENSIONS_MM)
    expect(pages).toHaveLength(1)
    expect(pages[0].rows).toHaveLength(2)
  })

  it('zero rows still produces one (empty) page rather than an empty page array', () => {
    const pages = paginatePaceCardRows([], DEFAULT_CARD_DIMENSIONS_MM)
    expect(pages).toHaveLength(1)
    expect(pages[0].rows).toHaveLength(0)
  })
})

describe('selectPaceCardColumns', () => {
  it('keeps only the requested columns, in the canonical column order', () => {
    const selected = selectPaceCardColumns(['cutoff', 'mileage'])
    expect(selected).toEqual(['mileage', 'cutoff'])
  })

  it('deduplicates repeated column keys', () => {
    const selected = selectPaceCardColumns(['mileage', 'mileage', 'ascent'])
    expect(selected).toEqual(['mileage', 'ascent'])
  })

  it('drops unknown/invalid keys silently rather than erroring', () => {
    const selected = selectPaceCardColumns(['mileage', 'not-a-real-column' as never])
    expect(selected).toEqual(['mileage'])
  })

  it('falls back to the default four columns when the user selects nothing', () => {
    expect(selectPaceCardColumns([])).toEqual(DEFAULT_PACE_CARD_COLUMNS)
  })

  it('can select every available column', () => {
    expect(selectPaceCardColumns(PACE_CARD_COLUMN_ORDER)).toEqual(PACE_CARD_COLUMN_ORDER)
  })
})

describe('buildPaceCardRows', () => {
  it('one row per RouteBookData row, with cumulative (not per-segment) mileage/ascent', () => {
    const data = manyCpsData(3)
    const rows = buildPaceCardRows(data)
    expect(rows).toHaveLength(data.rows.length)
    expect(rows[rows.length - 1].mileageKm).toBe((data.totalDistM / 1000).toFixed(1))
    expect(rows[rows.length - 1].name).toBe('终点')
  })

  it('a CP with no cutoff shows placeholders, not fabricated numbers', () => {
    const data = manyCpsData(1)
    const rows = buildPaceCardRows(data)
    expect(rows[0].cutoff).toBe('--')
    expect(rows[0].margin).toBe('--')
  })
})

describe('svg output (buildPaceCardSvgPages)', () => {
  it('renders the configured physical size in both the width/height attributes and the CP name', () => {
    const data = manyCpsData(2)
    const pages = buildPaceCardSvgPages(data, DEFAULT_PACE_CARD_COLUMNS, DEFAULT_CARD_DIMENSIONS_MM)
    expect(pages).toHaveLength(1)
    const svg = pages[0]
    expect(svg).toContain(`width="${DEFAULT_CARD_DIMENSIONS_MM.widthMm}mm"`)
    expect(svg).toContain(`height="${DEFAULT_CARD_DIMENSIONS_MM.heightMm}mm"`)
    expect(svg).toContain('CP1')
    expect(svg).toContain('CP2')
    expect(svg).toContain('终点')
  })

  it('is monochrome-safe: never emits a colour other than black/white fills or strokes', () => {
    const data = manyCpsData(2)
    const [svg] = buildPaceCardSvgPages(data)
    const colourMatches = svg.match(/(?:fill|stroke)="(#[0-9a-fA-F]{3,6})"/g) ?? []
    for (const m of colourMatches) {
      expect(m === 'fill="#000"' || m === 'stroke="#000"' || m === 'fill="#fff"').toBe(true)
    }
  })

  it('produces multiple numbered pages when there are more CPs than fit on one card', () => {
    const perPage = rowsPerCard(DEFAULT_CARD_DIMENSIONS_MM)
    const data = manyCpsData(perPage + 5) // guaranteed overflow
    const pages = buildPaceCardSvgPages(data)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0]).toContain(`1/${pages.length}`)
    expect(pages[1]).toContain(`2/${pages.length}`)
  })

  it('only includes the user-selected columns', () => {
    const data = manyCpsData(1)
    const withMargin = buildPaceCardSvgPages(data, ['mileage', 'margin'])[0]
    expect(withMargin).toContain('里程(km)')
    expect(withMargin).toContain('关门余量')
    expect(withMargin).not.toContain('预计到达')
  })

  it('a red (missed-cutoff) row gets the monochrome status glyph', () => {
    const t = climbingTrack()
    const cps = [cp('c1', 'CP1', 50, t.id, '2026-08-07T06:05:00+08:00')] // unreachable cutoff
    const data = buildRouteBookData(t, cps, pace, statsOptions, startIso)
    const [svg] = buildPaceCardSvgPages(data)
    expect(svg).toContain('✕')
  })
})
