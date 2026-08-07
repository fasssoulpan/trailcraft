import { describe, it, expect } from 'vitest'
import { createTrack } from '../../src/core/model/track'
import type { CheckPoint } from '../../src/core/model/checkpoint'
import { trackToGpx } from '../../src/core/export/gpxExport'
import { parseGpx } from '../../src/core/parsers/gpx'

// Beijing-area coordinates: inside the "in China" bounding rectangle used by
// core/crs/transform.ts, so GCJ-02 conversion actually shifts them.
function beijingTrack() {
  return createTrack(
    {
      lon: [116.198285, 116.19832, 116.198355],
      lat: [39.9930067, 39.99305, 39.9930933],
      ele: [116, 117, 118],
      time: [1726128340000, 1726128341000, 1726128342000],
    },
    { name: '北京市 越野跑', format: 'gpx', fileName: 'a.gpx' },
  )
}

describe('trackToGpx', () => {
  it('WGS-84 output re-parsed by parseGpx yields the same point count and coordinates', () => {
    const t = beijingTrack()
    const gpx = trackToGpx(t, [], 'wgs84')
    const reparsed = parseGpx(gpx, 'roundtrip.gpx')
    expect(reparsed.points.lon.length).toBe(t.points.lon.length)
    for (let i = 0; i < t.points.lon.length; i++) {
      expect(reparsed.points.lon[i]).toBeCloseTo(t.points.lon[i], 6)
      expect(reparsed.points.lat[i]).toBeCloseTo(t.points.lat[i], 6)
    }
  })

  it('exporting as gcj02 measurably shifts coordinates from the WGS-84 original', () => {
    const t = beijingTrack()
    const gpxWgs = trackToGpx(t, [], 'wgs84')
    const gpxGcj = trackToGpx(t, [], 'gcj02')
    const reWgs = parseGpx(gpxWgs, 'wgs.gpx')
    const reGcj = parseGpx(gpxGcj, 'gcj.gpx')
    const dLon = Math.abs(reWgs.points.lon[0] - reGcj.points.lon[0])
    const dLat = Math.abs(reWgs.points.lat[0] - reGcj.points.lat[0])
    // GCJ-02 shift in this region is on the order of ~0.001-0.006 degrees
    // (hundreds of metres); anything clearly above float noise confirms a
    // real conversion happened, not a no-op.
    expect(dLon + dLat).toBeGreaterThan(0.0005)
  })

  it('CP waypoints appear in the output', () => {
    const t = beijingTrack()
    const cps: CheckPoint[] = [
      { id: 'cp1', name: '补给站1', kind: 'aid', anchorIndex: 1, clickLngLat: [116.1983, 39.9931] },
    ]
    const gpx = trackToGpx(t, cps, 'wgs84')
    expect(gpx).toContain('<wpt')
    expect(gpx).toContain('<name>补给站1</name>')
  })

  it('a name containing & and < is escaped and survives an unescape round-trip', () => {
    const t = beijingTrack()
    const cps: CheckPoint[] = [
      { id: 'cp1', name: 'A & B <danger>', kind: 'danger', anchorIndex: 0, clickLngLat: [116.1983, 39.9931] },
    ]
    const gpx = trackToGpx(t, cps, 'wgs84')
    // must not contain raw unescaped special chars inside the name
    expect(gpx).not.toContain('<name>A & B <danger></name>')
    expect(gpx).toContain('&amp;')
    expect(gpx).toContain('&lt;danger&gt;')

    const m = /<wpt[^>]*><name>([^]*?)<\/name><\/wpt>/.exec(gpx)
    expect(m).not.toBeNull()
    const unescaped = m![1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
    expect(unescaped).toBe('A & B <danger>')
  })

  it('emits ele and time on trkpt when present', () => {
    const t = beijingTrack()
    const gpx = trackToGpx(t, [], 'wgs84')
    expect(gpx).toContain('<ele>116</ele>')
    expect(gpx).toMatch(/<time>2024-09-12T08:05:40/)
  })

  it('omits ele/time on trkpt when absent from the track', () => {
    const t = createTrack({ lon: [1, 2], lat: [1, 2] }, { name: 'no meta', format: 'gpx', fileName: 'x.gpx' })
    const gpx = trackToGpx(t, [], 'wgs84')
    expect(gpx).not.toContain('<ele>')
    expect(gpx).not.toContain('<time>')
  })
})
