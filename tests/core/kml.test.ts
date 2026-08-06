import { describe, it, expect } from 'vitest'
import { parseKml } from '../../src/core/parsers/kml'

const lineKml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>线路</name><LineString><coordinates>
 116.19,39.99,116
 116.20,39.995,120
</coordinates></LineString></Placemark></Document></kml>`

const gxTrackKml = `<?xml version="1.0"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document><Placemark><name>gx轨迹</name><gx:Track>
<when>2024-09-12T08:05:40Z</when>
<when>2024-09-12T08:05:41Z</when>
<gx:coord>116.19 39.99 116</gx:coord>
<gx:coord>116.20 39.995 120</gx:coord>
</gx:Track></Placemark></Document></kml>`

const noEleKml = `<?xml version="1.0"?><kml><Document><Placemark><name>无海拔</name><LineString><coordinates>
116.19,39.99
116.20,39.995
</coordinates></LineString></Placemark></Document></kml>`

const twoLineStringsKml = `<?xml version="1.0"?><kml><Document><Placemark><name>两段</name>
<LineString><coordinates>116.19,39.99,116 116.20,39.995,120</coordinates></LineString>
<LineString><coordinates>116.21,40.00,125 116.22,40.005,130</coordinates></LineString>
</Placemark></Document></kml>`

const emptyKml = `<?xml version="1.0"?><kml><Document><Placemark><name>空</name><LineString><coordinates>
</coordinates></LineString></Placemark></Document></kml>`

describe('parseKml', () => {
  it('parses LineString coordinates lon,lat,ele', () => {
    const r = parseKml(lineKml, 'a.kml')
    expect(r.points.lon.length).toBe(2)
    expect(r.points.lon[0]).toBeCloseTo(116.19)
    expect(r.points.ele![1]).toBe(120)
    expect(r.meta.name).toBe('线路')
  })

  it('parses gx:Track with when + gx:coord', () => {
    const r = parseKml(gxTrackKml, 'b.kml')
    expect(r.points.lon.length).toBe(2)
    expect(r.points.lon[0]).toBeCloseTo(116.19)
    expect(r.points.lat[1]).toBeCloseTo(39.995)
    expect(r.points.ele![1]).toBe(120)
    expect(Number.isFinite(r.points.time![0])).toBe(true)
    expect(r.points.time![1]).toBeGreaterThan(r.points.time![0])
    expect(r.meta.name).toBe('gx轨迹')
  })

  it('leaves ele undefined for 2-tuple coordinates with no ele', () => {
    const r = parseKml(noEleKml, 'c.kml')
    expect(r.points.lon.length).toBe(2)
    expect(r.points.ele).toBeUndefined()
  })

  it('concatenates points across multiple LineString blocks in document order', () => {
    const r = parseKml(twoLineStringsKml, 'd.kml')
    expect(r.points.lon.length).toBe(4)
    expect(r.points.lon[0]).toBeCloseTo(116.19)
    expect(r.points.lon[3]).toBeCloseTo(116.22)
    expect(r.points.ele![3]).toBe(130)
  })

  it('throws on zero coordinates', () => {
    expect(() => parseKml(emptyKml, 'empty.kml')).toThrow()
  })
})
