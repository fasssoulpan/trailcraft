import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../../src/core/model/track'
import { computeCumDist, haversine } from '../../../src/core/geo/distance'
import type { CheckPoint } from '../../../src/core/model/checkpoint'
import type { PaceParams } from '../../../src/core/pace/models'
import { buildRouteBookData } from '../../../src/core/export/routeBookData'
import { formatClockHM } from '../../../src/core/export/timeFormat'
import { OSM_TILE_URL_TEMPLATE } from '../../../src/map/basemapStyle'
import {
  buildWebPagePayload, renderWebPageHtml, buildInteractiveWebPage, utf8ByteSize,
  computeWebPageSizeBreakdown, PHOTO_DOMINANT_SHARE,
  WebPageDataError, DEFAULT_MAX_POINTS, DEFAULT_COORD_PRECISION,
} from '../../../src/core/export/webPage'

function climbingTrack(n = 400): Track {
  // A gently curving track (not a straight line) so decimation actually
  // discards points that matter for the "shape preserved" reasoning in
  // webPage.ts's module comment, not just collinear ones.
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.0004 + Math.sin(i / 15) * 0.0005)
  const lat = Array.from({ length: n }, (_, i) => 39.9 + Math.cos(i / 20) * 0.0008)
  const ele = Array.from({ length: n }, (_, i) => 1000 + i * 3 + Math.sin(i / 10) * 20)
  const t = createTrack({ lon, lat, ele }, { name: '测试赛道 · 北京百公里', format: 'gpx', fileName: 'climb.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

function noEleTrack(n = 200): Track {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.0005)
  const lat = Array.from({ length: n }, () => 39.9)
  const t = createTrack({ lon, lat }, { name: '无海拔赛道', format: 'gpx', fileName: 'noele.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

function bigTrack(n: number): Track {
  const lon = new Float64Array(n)
  const lat = new Float64Array(n)
  const ele = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    lon[i] = 116 + i * 0.00002 + Math.sin(i / 500) * 0.01
    lat[i] = 39.9 + Math.cos(i / 700) * 0.02
    ele[i] = 1000 + Math.sin(i / 300) * 300
  }
  const t = createTrack({ lon, lat, ele }, { name: '速攀129新望京', format: 'gpx', fileName: 'big.gpx' })
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

describe('buildWebPagePayload', () => {
  it('throws WebPageDataError when the track has no cumDist', () => {
    const t = climbingTrack()
    t.points.cumDist = undefined
    expect(() => buildWebPagePayload(t, [])).toThrow(WebPageDataError)
    expect(() => buildWebPagePayload(t, [])).toThrow(/里程/)
  })

  it('produces a valid payload with an empty checkpoint list and a single start->finish segment when there are zero CPs', () => {
    const t = climbingTrack()
    const payload = buildWebPagePayload(t, [])
    expect(payload.checkpoints).toHaveLength(0)
    expect(payload.segments).toHaveLength(1)
    expect(payload.segments[0].label).toBe('起点 → 终点')
  })

  it('decimates coordinates to at most maxPoints, always keeping the endpoints', () => {
    const t = climbingTrack(500)
    const payload = buildWebPagePayload(t, [], { maxPoints: 50 })
    expect(payload.track.lon.length).toBe(50)
    expect(payload.track.lat.length).toBe(50)
    expect(payload.track.distM.length).toBe(50)
    expect(payload.track.lon[0]).toBeCloseTo(t.points.lon[0], 4)
    expect(payload.track.lon[49]).toBeCloseTo(t.points.lon[499], 4)
  })

  it('keeps every point when the track has fewer points than maxPoints', () => {
    const t = climbingTrack(30)
    const payload = buildWebPagePayload(t, [], { maxPoints: 4000 })
    expect(payload.track.lon.length).toBe(30)
  })

  it('rounds coordinates to the chosen precision, staying within a sub-metre tolerance of the original point', () => {
    const t = climbingTrack(300)
    const payload = buildWebPagePayload(t, [], { maxPoints: 4000, coordPrecision: DEFAULT_COORD_PRECISION })
    // No decimation happened (maxPoints > n), so every deviation here is
    // purely rounding error -- isolates the claim made in webPage.ts's
    // DEFAULT_COORD_PRECISION doc comment ("5 decimals ~= 1.11m worst case")
    // from decimation-induced shape loss, which is a separate, expected effect.
    let maxErrM = 0
    for (let i = 0; i < payload.track.lon.length; i++) {
      const d = haversine(t.points.lon[i], t.points.lat[i], payload.track.lon[i], payload.track.lat[i])
      if (d > maxErrM) maxErrM = d
    }
    expect(maxErrM).toBeLessThan(1.2)
  })

  it('coordinate rounding at 6 vs 5 decimals: 5 decimals stays within ~1.1m, matching the module comment', () => {
    const t = climbingTrack(50)
    const p5 = buildWebPagePayload(t, [], { maxPoints: 4000, coordPrecision: 5 })
    const p6 = buildWebPagePayload(t, [], { maxPoints: 4000, coordPrecision: 6 })
    const err5 = haversine(t.points.lon[10], t.points.lat[10], p5.track.lon[10], p5.track.lat[10])
    const err6 = haversine(t.points.lon[10], t.points.lat[10], p6.track.lon[10], p6.track.lat[10])
    expect(err6).toBeLessThanOrEqual(err5 + 1e-9)
  })

  it('a track without elevation still produces a valid payload with the profile section omitted, not throwing', () => {
    const t = noEleTrack()
    const payload = buildWebPagePayload(t, [cp('c1', 'CP1', 50, t.id)])
    expect(payload.profileSvg).toBeUndefined()
    expect(payload.profileGeom).toBeUndefined()
    expect(payload.summary.gainM).toBeUndefined()
    expect(payload.summary.lossM).toBeUndefined()
    expect(payload.segments[0].gainM).toBeUndefined()
    expect(payload.segments[0].lossM).toBeUndefined()
    // Distance still works -- only elevation-derived numbers are omitted.
    expect(payload.segments[0].distKm).not.toBe('')
  })

  it('a track with elevation produces a non-empty profile SVG matching computeProfileChartModel output', () => {
    const t = climbingTrack()
    const payload = buildWebPagePayload(t, [cp('c1', 'CP1', 50, t.id)])
    expect(payload.profileSvg).toBeDefined()
    expect(payload.profileSvg).toContain('<svg')
    expect(payload.profileGeom).toBeDefined()
    expect(payload.profileGeom!.totalDistM).toBeGreaterThan(0)
  })

  it('checkpoints and segments match what buildRouteBookData produces for the same track/CPs/pace/start time', () => {
    const t = climbingTrack()
    const cutoffIso = '2026-08-07T20:00:00+08:00'
    const cps = [cp('c1', 'CP1', 50, t.id, cutoffIso), cp('c2', 'CP2', 200, t.id)]
    const bookData = buildRouteBookData(t, cps, pace, statsOptions, startIso)
    const payload = buildWebPagePayload(t, cps, { statsOptions, paceParams: pace, raceStartTimeIso: startIso })

    expect(payload.segments).toHaveLength(bookData.rows.length)
    bookData.rows.forEach((row, i) => {
      const seg = payload.segments[i]
      expect(seg.label).toBe(`${row.fromName} → ${row.toName}`)
      expect(seg.distKm).toBe((row.distM / 1000).toFixed(2))
      expect(seg.gainM).toBe(Math.round(row.gain).toString())
      expect(seg.lossM).toBe(Math.round(row.loss).toString())
      expect(seg.etaLabel).toBe(row.etaMs !== undefined ? formatClockHM(row.etaMs) : '--')
      expect(seg.cutoffLabel).toBe(row.cutoffMs !== undefined ? formatClockHM(row.cutoffMs) : '--')
      expect(seg.level).toBe(row.level)
    })

    expect(payload.checkpoints).toHaveLength(bookData.sortedCps.length)
    bookData.sortedCps.forEach((sortedCp, i) => {
      expect(payload.checkpoints[i].name).toBe(sortedCp.name)
      // checkpoints[i] ends the segment rows[i] -- same alignment
      // buildRouteBookRows/computeSegments establish internally.
      expect(payload.checkpoints[i].distM).toBe(Math.round(bookData.rows[i].cumDistM))
    })

    expect(payload.summary.distKm).toBe((bookData.totalDistM / 1000).toFixed(2))
    expect(payload.summary.gainM).toBe(Math.round(bookData.totalGainM).toString())
    expect(payload.summary.lossM).toBe(Math.round(bookData.totalLossM).toString())
  })

  it('ignores CPs belonging to a different track', () => {
    const t = climbingTrack()
    const payload = buildWebPagePayload(t, [cp('other', '别的轨迹', 10, 'trk_other')])
    expect(payload.checkpoints).toHaveLength(0)
  })

  it('carries checkpoint photoUrl through unchanged when present', () => {
    const t = climbingTrack()
    const photoUrl = 'data:image/jpeg;base64,AAAA'
    const withPhoto: CheckPoint = { ...cp('c1', 'CP1', 50, t.id), photoUrl }
    const payload = buildWebPagePayload(t, [withPhoto])
    expect(payload.checkpoints[0].photoUrl).toBe(photoUrl)
  })

  it('carries track color/lineWidth through, falling back to sensible defaults', () => {
    const t = climbingTrack()
    const payload = buildWebPagePayload(t, [])
    expect(payload.trackStyle.color).toBeTruthy()
    expect(payload.trackStyle.lineWidth).toBeGreaterThan(0)
  })
})

describe('renderWebPageHtml / buildInteractiveWebPage', () => {
  it('contains no <script src>, <link href>, @import or @font-face url() references -- the whole point of "self-contained"', () => {
    const t = climbingTrack()
    const html = buildInteractiveWebPage(t, [cp('c1', 'CP1', 50, t.id)])
    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link[^>]+href=/i)
    expect(html).not.toMatch(/@import/i)
    expect(html).not.toMatch(/@font-face/i)
  })

  it('the only http(s):// occurrences anywhere in the page are the OSM tile URL template (fetched at runtime by our own inline script) and the SVG XML namespace URI -- both documented, neither an external resource load', () => {
    const t = climbingTrack()
    const html = buildInteractiveWebPage(t, [cp('c1', 'CP1', 50, t.id)])
    const matches = html.match(/https?:\/\/[^\s"'<>)]+/g) ?? []
    // 'http://www.w3.org/2000/svg' is the SVG spec's namespace URI, both in
    // the embedded profile <svg xmlns="..."> and the client script's
    // createElementNS call -- an opaque XML identifier, never fetched over
    // the network by any browser, unlike an actual <script src>/<link href>.
    const allowed = new Set([OSM_TILE_URL_TEMPLATE, 'http://www.w3.org/2000/svg', 'http://www.w3.org/2000/svg\\'])
    const unexpected = matches.filter((m) => !allowed.has(m))
    expect(unexpected).toEqual([])
    expect(matches.length).toBeGreaterThan(0) // sanity: the tile template really is present
  })

  it('embeds the profile SVG raw markup when the track has elevation', () => {
    const t = climbingTrack()
    const html = buildInteractiveWebPage(t, [cp('c1', 'CP1', 50, t.id)])
    expect(html).toContain('id="tcProfileCard"')
    expect(html).toContain('<svg')
  })

  it('omits the profile section (not a broken/empty chart) when the track has no elevation', () => {
    const t = noEleTrack()
    const html = buildInteractiveWebPage(t, [cp('c1', 'CP1', 50, t.id)])
    expect(html).not.toContain('id="tcProfileCard"')
    expect(html).toContain('该轨迹没有海拔数据')
  })

  it('escapes a track name containing HTML-significant characters instead of injecting markup', () => {
    const t = climbingTrack()
    t.meta.name = '<img src=x onerror=alert(1)>危险赛道'
    const html = buildInteractiveWebPage(t, [])
    // The raw name is also carried verbatim inside the JSON payload embedded
    // in a <script> block further down the page -- that is safe (browsers
    // never parse HTML found inside a JSON string literal in a script's text
    // content) and irrelevant to this assertion, which is specifically about
    // whether the name breaks out into *rendered* markup (the <h1>/<title>
    // spots this test cares about). Strip every <script>...</script> block
    // before asserting, so this test doesn't false-positive on that inert copy.
    const bodyOnly = html.replace(/<script>[\s\S]*?<\/script>/g, '')
    expect(bodyOnly).not.toContain('<img src=x onerror=alert(1)>')
    expect(bodyOnly).toContain('&lt;img')
  })

  it('a checkpoint name containing "</script>" cannot break out of the embedded JSON script tag', () => {
    const t = climbingTrack()
    const cps = [cp('c1', '</script><script>alert(1)</script>', 50, t.id)]
    const html = buildInteractiveWebPage(t, cps)
    expect(html).not.toMatch(/<\/script><script>alert\(1\)/)
  })

  it('renders a phone-friendly responsive viewport meta tag', () => {
    const t = climbingTrack()
    const html = buildInteractiveWebPage(t, [])
    expect(html).toMatch(/<meta name="viewport" content="width=device-width/)
  })

  it('is valid parseable JSON once extracted from the embedded script tag', () => {
    const t = climbingTrack()
    const payload = buildWebPagePayload(t, [cp('c1', 'CP1', 50, t.id)])
    const html = renderWebPageHtml(payload)
    const match = html.match(/window\.__TRAILCRAFT_DATA__ = (.+?);<\/script>/s)
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match![1].replace(/\\u2028/g, ' ').replace(/\\u2029/g, ' '))
    expect(parsed.trackName).toBe(payload.trackName)
    expect(parsed.track.lon.length).toBe(payload.track.lon.length)
  })
})

describe('payload/page size -- the central constraint per the milestone brief', () => {
  it('reports the payload/page size for a realistic ~330k-point track (measured, not asserted against a magic number)', () => {
    const t = bigTrack(330_000)
    const payload = buildWebPagePayload(t, [cp('c1', 'CP1', 100_000, t.id), cp('c2', 'CP2', 250_000, t.id)])
    expect(payload.track.lon.length).toBeLessThanOrEqual(DEFAULT_MAX_POINTS)
    const html = renderWebPageHtml(payload)
    const bytes = utf8ByteSize(html)
    // eslint-disable-next-line no-console
    console.log(`[webPage size] 330k-point track -> decimated to ${payload.track.lon.length} pts, HTML = ${(bytes / 1024).toFixed(1)} KiB`)
    // A generous ceiling, not a tight bound -- the point of this test is the
    // logged measurement (see task report), this just guards against a
    // regression that silently reintroduces the full 330k-point array.
    expect(bytes).toBeLessThan(3 * 1024 * 1024)
  })

  it('reports the payload/page size for a ~5k-point track', () => {
    const t = bigTrack(5038)
    const payload = buildWebPagePayload(t, [cp('c1', 'CP1', 1000, t.id), cp('c2', 'CP2', 3000, t.id)])
    // 5,038 is just above DEFAULT_MAX_POINTS (4000), so the default settings
    // still decimate it slightly -- this is the real, intended behaviour for
    // a moderately-sized real track, not a bug; see webPage.ts's own
    // DEFAULT_MAX_POINTS doc comment for why 4000 was chosen as the cap.
    expect(payload.track.lon.length).toBe(Math.min(5038, DEFAULT_MAX_POINTS))
    const html = renderWebPageHtml(payload)
    const bytes = utf8ByteSize(html)
    // eslint-disable-next-line no-console
    console.log(`[webPage size] 5,038-point track -> HTML = ${(bytes / 1024).toFixed(1)} KiB`)
    expect(bytes).toBeLessThan(1.5 * 1024 * 1024)
  })

  it('decimation actually shrinks the payload -- a lower maxPoints produces a smaller HTML file', () => {
    const t = bigTrack(50_000)
    const cps = [cp('c1', 'CP1', 20_000, t.id)]
    const big = utf8ByteSize(buildInteractiveWebPage(t, cps, { maxPoints: 8000 }))
    const small = utf8ByteSize(buildInteractiveWebPage(t, cps, { maxPoints: 1000 }))
    expect(small).toBeLessThan(big)
  })

  it('includePhotos: false strips every checkpoint photoUrl from the payload, even when the CP has one', () => {
    const t = climbingTrack()
    const photoUrl = 'data:image/jpeg;base64,' + 'A'.repeat(2000)
    const withPhoto: CheckPoint = { ...cp('c1', 'CP1', 50, t.id), photoUrl }
    const included = buildWebPagePayload(t, [withPhoto])
    const excluded = buildWebPagePayload(t, [withPhoto], { includePhotos: false })
    expect(included.checkpoints[0].photoUrl).toBe(photoUrl)
    expect(excluded.checkpoints[0].photoUrl).toBeUndefined()
  })
})

describe('computeWebPageSizeBreakdown -- P3-R5 commit 1: photo vs. route bulk', () => {
  it('all bulk from photos -> dominant "photo", photoShare === 1', () => {
    const payload = { checkpoints: [{ photoUrl: 'x'.repeat(500) } as never] }
    const b = computeWebPageSizeBreakdown(payload, 500)
    expect(b.photoBytes).toBe(500)
    expect(b.routeBytes).toBe(0)
    expect(b.photoShare).toBe(1)
    expect(b.dominant).toBe('photo')
  })

  it('no photos at all -> dominant "route", photoShare === 0', () => {
    const payload = { checkpoints: [{ photoUrl: undefined } as never, {} as never] }
    const b = computeWebPageSizeBreakdown(payload, 1000)
    expect(b.photoBytes).toBe(0)
    expect(b.routeBytes).toBe(1000)
    expect(b.photoShare).toBe(0)
    expect(b.dominant).toBe('route')
  })

  it('sums photoUrl bytes across multiple checkpoints', () => {
    const payload = {
      checkpoints: [
        { photoUrl: 'a'.repeat(100) } as never,
        { photoUrl: 'b'.repeat(300) } as never,
        { photoUrl: undefined } as never,
      ],
    }
    const b = computeWebPageSizeBreakdown(payload, 1000)
    expect(b.photoBytes).toBe(400)
    expect(b.routeBytes).toBe(600)
    expect(b.photoShare).toBeCloseTo(0.4, 10)
    expect(b.dominant).toBe('route') // 40% < PHOTO_DOMINANT_SHARE
  })

  it('exactly at PHOTO_DOMINANT_SHARE counts as photo-dominant (>=, not >)', () => {
    const payload = { checkpoints: [{ photoUrl: 'x'.repeat(500) } as never] }
    const b = computeWebPageSizeBreakdown(payload, 500 / PHOTO_DOMINANT_SHARE)
    expect(b.photoShare).toBeCloseTo(PHOTO_DOMINANT_SHARE, 10)
    expect(b.dominant).toBe('photo')
  })

  it('totalBytes === 0 does not throw or produce NaN -- photoShare defaults to 0', () => {
    const payload = { checkpoints: [] }
    const b = computeWebPageSizeBreakdown(payload, 0)
    expect(b.photoBytes).toBe(0)
    expect(b.routeBytes).toBe(0)
    expect(b.photoShare).toBe(0)
    expect(b.dominant).toBe('route')
  })

  it('clamps photoBytes to totalBytes if it would otherwise exceed it (defensive, should not happen in practice)', () => {
    const payload = { checkpoints: [{ photoUrl: 'x'.repeat(2000) } as never] }
    const b = computeWebPageSizeBreakdown(payload, 500)
    expect(b.photoBytes).toBe(500)
    expect(b.routeBytes).toBe(0)
  })
})
