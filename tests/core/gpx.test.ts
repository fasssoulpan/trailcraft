import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseGpx } from '../../src/core/parsers/gpx'

const fixturesDir = new URL('../fixtures/', import.meta.url)
const mini = readFileSync(new URL('mini.gpx', fixturesDir), 'utf-8')

describe('parseGpx', () => {
  it('parses points, ele, time, creator, name', () => {
    const r = parseGpx(mini, 'mini.gpx')
    expect(r.points.lon.length).toBe(3)
    expect(r.points.lat[0]).toBeCloseTo(39.9930067)
    expect(r.points.ele![0]).toBe(116)
    expect(r.meta.creator).toBe('COROS Wearables')
    expect(r.meta.name).toBe('北京市 越野跑')
    expect(Number.isFinite(r.points.time![0])).toBe(true)
  })

  it('concatenates points across multiple <trkseg> blocks', () => {
    const xml = `<?xml version="1.0"?>
<gpx creator="Test" version="1.1">
 <trk>
  <name>two segs</name>
  <trkseg>
   <trkpt lat="1.0" lon="2.0"><ele>10</ele></trkpt>
   <trkpt lat="1.1" lon="2.1"><ele>11</ele></trkpt>
  </trkseg>
  <trkseg>
   <trkpt lat="1.2" lon="2.2"><ele>12</ele></trkpt>
   <trkpt lat="1.3" lon="2.3"><ele>13</ele></trkpt>
  </trkseg>
 </trk>
</gpx>`
    const r = parseGpx(xml, 'two.gpx')
    expect(r.points.lon.length).toBe(4)
    expect(r.points.lat[3]).toBeCloseTo(1.3)
  })

  it('leaves ele undefined when no <ele> anywhere', () => {
    const xml = `<?xml version="1.0"?>
<gpx creator="Test" version="1.1">
 <trk>
  <name>no ele</name>
  <trkseg>
   <trkpt lat="1.0" lon="2.0"></trkpt>
   <trkpt lat="1.1" lon="2.1"></trkpt>
  </trkseg>
 </trk>
</gpx>`
    const r = parseGpx(xml, 'noele.gpx')
    expect(r.points.ele).toBeUndefined()
  })

  it('throws on zero trkpt', () => {
    const xml = `<?xml version="1.0"?>
<gpx creator="Test" version="1.1">
 <trk>
  <name>empty</name>
  <trkseg>
  </trkseg>
 </trk>
</gpx>`
    expect(() => parseGpx(xml, 'empty.gpx')).toThrow()
  })

  it('reads hr extension when present, undefined when absent', () => {
    const withHr = `<?xml version="1.0"?>
<gpx xmlns:gpxdata="http://www.cluetrust.com/XML/GPXDATA/1/0" creator="Test" version="1.1">
 <trk>
  <name>hr</name>
  <trkseg>
   <trkpt lat="1.0" lon="2.0">
    <extensions><gpxdata:hr>91</gpxdata:hr></extensions>
   </trkpt>
  </trkseg>
 </trk>
</gpx>`
    const r1 = parseGpx(withHr, 'hr.gpx')
    expect(r1.points.hr).toBeDefined()
    expect(r1.points.hr![0]).toBe(91)

    const withoutHr = `<?xml version="1.0"?>
<gpx creator="Test" version="1.1">
 <trk>
  <name>nohr</name>
  <trkseg>
   <trkpt lat="1.0" lon="2.0"></trkpt>
  </trkseg>
 </trk>
</gpx>`
    const r2 = parseGpx(withoutHr, 'nohr.gpx')
    expect(r2.points.hr).toBeUndefined()
  })

  it('parses scientific-notation elevation instead of losing it to NaN', () => {
    const xml = `<?xml version="1.0"?>
<gpx creator="Test" version="1.1">
 <trk>
  <name>sci ele</name>
  <trkseg>
   <trkpt lat="1.0" lon="2.0"><ele>1.5e3</ele></trkpt>
   <trkpt lat="1.1" lon="2.1"><ele>-2.5E-1</ele></trkpt>
  </trkseg>
 </trk>
</gpx>`
    const r = parseGpx(xml, 'sciele.gpx')
    expect(r.points.ele![0]).toBe(1500)
    expect(r.points.ele![1]).toBeCloseTo(-0.25)
  })

  it('parses self-closing <trkpt/> tags with ele/time absent', () => {
    const xml = `<?xml version="1.0"?>
<gpx creator="Test" version="1.1">
 <trk>
  <name>self-closing</name>
  <trkseg>
   <trkpt lat="1.0" lon="2.0"/>
   <trkpt lat="1.1" lon="2.1"/>
  </trkseg>
 </trk>
</gpx>`
    const r = parseGpx(xml, 'selfclosing.gpx')
    expect(r.points.lon.length).toBe(2)
    expect(Array.from(r.points.lon)).toEqual([2.0, 2.1])
    expect(Array.from(r.points.lat)).toEqual([1.0, 1.1])
    expect(r.points.ele).toBeUndefined()
    expect(r.points.time).toBeUndefined()
  })
})

const dataDir = process.env.TRAILCRAFT_TESTDATA ?? 'C:/Users/Administrator/Desktop/越野跑地图软件开发/测试'
describe.skipIf(!existsSync(dataDir))('parseGpx real data', () => {
  it('5k-point file parses < 2s', () => {
    const xml = readFileSync(join(dataDir, '速攀129新望京20240912160539.gpx'), 'utf-8')
    const t0 = performance.now()
    const r = parseGpx(xml, 'real.gpx')
    expect(performance.now() - t0).toBeLessThan(2000)
    expect(r.points.lon.length).toBe(5038)
  })
  it('330k-point file parses correctly', () => {
    const xml = readFileSync(join(dataDir, '越野跑20250912200059.gpx'), 'utf-8')
    const r = parseGpx(xml, 'big.gpx')
    expect(r.points.lon.length).toBe(330062)
  })
})
