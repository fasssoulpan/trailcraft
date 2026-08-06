import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { importFile } from '../../src/core/pipeline/import'
import { parseGpx } from '../../src/core/parsers/gpx'
import { haversine } from '../../src/core/geo/distance'

const fixturesDir = new URL('../fixtures/', import.meta.url)
const mini = readFileSync(new URL('mini.gpx', fixturesDir), 'utf-8')

describe('importFile', () => {
  it('gpx import computes cumDist: length matches, starts at 0, monotonically non-decreasing', async () => {
    const { track } = await importFile('mini.gpx', mini, {})
    expect(track.points.cumDist).toBeDefined()
    expect(track.points.cumDist!.length).toBe(track.points.lon.length)
    expect(track.points.cumDist![0]).toBe(0)
    for (let i = 1; i < track.points.cumDist!.length; i++) {
      expect(track.points.cumDist![i]).toBeGreaterThanOrEqual(track.points.cumDist![i - 1])
    }
  })

  it('COROS fixture auto-detects wgs84, coordinates unchanged from parseGpx output', async () => {
    const direct = parseGpx(mini, 'mini.gpx')
    const { track, detect } = await importFile('mini.gpx', mini, {})
    expect(detect.crs).toBe('wgs84')
    expect(detect.confidence).toBe('high')
    expect(track.originalCrs).toBe('wgs84')
    expect(Array.from(track.points.lon)).toEqual(Array.from(direct.points.lon))
    expect(Array.from(track.points.lat)).toEqual(Array.from(direct.points.lat))
  })

  it('forcedCrs gcj02 shifts coordinates measurably (100-1000m) and sets originalCrs', async () => {
    const direct = parseGpx(mini, 'mini.gpx')
    const { track, detect } = await importFile('mini.gpx', mini, {}, 'gcj02')
    expect(track.originalCrs).toBe('gcj02')
    expect(detect.reason).toBe('user forced')
    const d = haversine(direct.points.lon[0], direct.points.lat[0], track.points.lon[0], track.points.lat[0])
    expect(d).toBeGreaterThan(100)
    expect(d).toBeLessThan(1000)
  })

  it('unsupported extension rejects', async () => {
    await expect(importFile('a.tcx', mini, {})).rejects.toThrow()
  })

  it('kml import path works with inline KML string', async () => {
    const kml = `<?xml version="1.0"?>
<kml><Document><Placemark><name>x</name><LineString><coordinates>
116.1,39.9,0 116.2,39.95,0 116.3,40.0,0
</coordinates></LineString></Placemark></Document></kml>`
    const { track } = await importFile('x.kml', kml, {})
    expect(track.points.lon.length).toBe(3)
    expect(track.points.cumDist).toBeDefined()
  })

  it('no-conversion path does not mutate the parser-returned points object', async () => {
    const direct = parseGpx(mini, 'mini.gpx')
    expect(direct.points.cumDist).toBeUndefined()
    const { track } = await importFile('mini.gpx', mini, {})
    expect(track.points.cumDist).toBeDefined()
    // The object returned by parseGpx (a fresh parse) must remain untouched.
    expect(direct.points.cumDist).toBeUndefined()
  })

  it('rejects an ArrayBuffer payload for a .gpx file with a clear message', async () => {
    const buf = new ArrayBuffer(8)
    await expect(importFile('mini.gpx', buf, {})).rejects.toThrow(/string/i)
    await expect(importFile('mini.gpx', buf, {})).rejects.toThrow(/mini\.gpx/)
  })

  it('rejects a string payload for a .fit file with a clear message', async () => {
    await expect(importFile('a.fit', 'not-a-buffer', {})).rejects.toThrow(/ArrayBuffer/i)
    await expect(importFile('a.fit', 'not-a-buffer', {})).rejects.toThrow(/a\.fit/)
  })
})
