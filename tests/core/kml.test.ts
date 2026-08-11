import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseKml, parseKmlWaypoints } from '../../src/core/parsers/kml'
import { parseFit } from '../../src/core/parsers/fit'
import { checkpointsFromWaypoints } from '../../src/core/pipeline/checkpointImport'
import { computeCumDist } from '../../src/core/geo/distance'

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

// Mirrors the real 崇礼 KML's shape: everything wrapped in a <Folder>, one
// <Placemark><LineString> for the track, plus several sibling
// <Placemark><Point> checkpoints -- the exact structure that made the old
// document-global <coordinates> regex append stray jump-points onto the
// track polyline.
const folderWithPointsKml = `<?xml version="1.0"?>
<kml><Folder>
 <Placemark><name>Track</name><LineString><coordinates>
  116.00,39.90,1000 116.01,39.91,1010 116.02,39.92,1020
 </coordinates></LineString></Placemark>
 <Folder>
  <Placemark><name>CP1起点-0km</name><Point><coordinates>116.00,39.90,1000</coordinates></Point></Placemark>
  <Placemark><name>CP2中间-5km</name><Point><coordinates>50.00,10.00,1234</coordinates></Point></Placemark>
 </Folder>
 <Folder>
  <name>Laps</name>
  <Placemark><name>Start</name><Point><coordinates>116.00,39.90,1000</coordinates></Point></Placemark>
  <Placemark><name>End</name><Point><coordinates>116.02,39.92,1020</coordinates></Point></Placemark>
 </Folder>
</Folder></kml>`

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

  it('excludes <Point> placemark coordinates (Folder-wrapped, CP + Start/End siblings) from the track', () => {
    const r = parseKml(folderWithPointsKml, 'folder.kml')
    // Only the 3 LineString vertices -- none of the 4 sibling Point placemarks
    // (2 named CPs at wildly different coordinates + Start/End) leaked in.
    expect(r.points.lon.length).toBe(3)
    expect(Array.from(r.points.lon)).toEqual([116.00, 116.01, 116.02])
    expect(Array.from(r.points.lat)).toEqual([39.90, 39.91, 39.92])
    // If the CP2 point (lon 50) had leaked in, this would be ~4000km instead of ~2.8km.
    const totalDeg = Math.abs(r.points.lon[2] - r.points.lon[0]) + Math.abs(r.points.lat[2] - r.points.lat[0])
    expect(totalDeg).toBeLessThan(1)
  })
})

describe('parseKmlWaypoints', () => {
  it('extracts named Point placemarks with lon/lat/ele, excluding the LineString track placemark', () => {
    const wp = parseKmlWaypoints(folderWithPointsKml)
    expect(wp).toHaveLength(2)
    expect(wp[0]).toEqual({ name: 'CP1起点-0km', lon: 116.00, lat: 39.90, ele: 1000 })
    expect(wp[1]).toEqual({ name: 'CP2中间-5km', lon: 50.00, lat: 10.00, ele: 1234 })
  })

  it('excludes placemarks literally named Start/End', () => {
    const wp = parseKmlWaypoints(folderWithPointsKml)
    expect(wp.some((w) => w.name === 'Start')).toBe(false)
    expect(wp.some((w) => w.name === 'End')).toBe(false)
  })

  it('returns [] for a KML with only line geometry (no Point placemarks)', () => {
    expect(parseKmlWaypoints(lineKml)).toEqual([])
    expect(parseKmlWaypoints(twoLineStringsKml)).toEqual([])
  })

  it('leaves ele undefined for a 2-tuple Point coordinate', () => {
    const xml = `<?xml version="1.0"?><kml><Document>
      <Placemark><name>无海拔CP</name><Point><coordinates>116.5,40.1</coordinates></Point></Placemark>
    </Document></kml>`
    const wp = parseKmlWaypoints(xml)
    expect(wp).toEqual([{ name: '无海拔CP', lon: 116.5, lat: 40.1, ele: undefined }])
  })
})

const dataDir = process.env.TRAILCRAFT_TESTDATA ?? 'C:/Users/Administrator/Desktop/越野跑地图软件开发/测试'
const suppDir = join(dataDir, '补充测试轨迹数据')

describe.skipIf(!existsSync(suppDir))('parseKml real data (崇礼172.8km race KML)', () => {
  const chongliKml = readFileSync(join(suppDir, '路线-崇礼_172_8km-7944m20260706090026.kml'), 'utf-8')
  const siLingKml = readFileSync(join(suppDir, '路线-四灵反穿20260811095617.kml'), 'utf-8')

  it('parses ~38,509 track points, distance 172.7km ±1km (official 172.8km) with the stray CP points excluded', () => {
    const r = parseKml(chongliKml, '崇礼.kml')
    expect(r.points.lon.length).toBeGreaterThan(38000)
    expect(r.points.lon.length).toBeLessThan(39000)

    let distM = 0
    for (let i = 1; i < r.points.lon.length; i++) {
      const dLat = (r.points.lat[i] - r.points.lat[i - 1]) * (Math.PI / 180)
      const dLon = (r.points.lon[i] - r.points.lon[i - 1]) * (Math.PI / 180)
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(r.points.lat[i - 1] * (Math.PI / 180)) * Math.cos(r.points.lat[i] * (Math.PI / 180)) * Math.sin(dLon / 2) ** 2
      distM += 2 * 6371008.8 * Math.asin(Math.sqrt(a))
    }
    const distKm = distM / 1000
    expect(distKm).toBeGreaterThan(171.7)
    expect(distKm).toBeLessThan(173.7)
  })

  it('parses the 四灵反穿 KML (1 LineString, no checkpoints) without error', () => {
    const r = parseKml(siLingKml, '四灵.kml')
    expect(r.points.lon.length).toBeGreaterThan(0)
    expect(parseKmlWaypoints(siLingKml)).toEqual([])
  })

  it('yields 15 checkpoints whose anchored mileage matches the km figure embedded in their own name within 0.5km', () => {
    const track = parseKml(chongliKml, '崇礼.kml')
    track.points.cumDist = computeCumDist(track.points.lon, track.points.lat)
    const waypoints = parseKmlWaypoints(chongliKml)
    expect(waypoints).toHaveLength(15)

    const cps = checkpointsFromWaypoints(track, waypoints)
    expect(cps).toHaveLength(15)

    // "起终点-庆典广场" (start-&-finish, no stated km) is listed first in the
    // document but this is a closed loop where start and finish sit ~9m
    // apart -- it genuinely resolves a hair closer to the finish than the
    // start. Checked separately (near either end of the course) rather than
    // folded into the general monotonic-order assertion below, which is
    // about the 13 checkpoints that actually state an unambiguous km.
    const startFinish = cps.find((c) => c.name === '起终点-庆典广场')!
    const startFinishKm = track.points.cumDist![startFinish.anchorIndex] / 1000
    expect(startFinishKm < 5 || startFinishKm > 167.8).toBe(true)

    // Not every name puts a dash before the number (compare "CP1二道营-12.5km"
    // with "CP4桦林子50.0km"), so the km figure is matched without requiring
    // one -- this still correctly excludes "起终点-庆典广场" (no number at
    // all) and the malformed "CP10云顶滑雪公园-120.m" (ends in ".m", not "km").
    const stated = cps
      .map((cp) => ({ cp, m: /(\d+(?:\.\d+)?)km$/.exec(cp.name) }))
      .filter((x): x is { cp: (typeof cps)[number]; m: RegExpExecArray } => x.m !== null)
    expect(stated.length).toBe(13)

    // These 13+ checkpoints are genuinely in ascending course order (unlike
    // "起终点"), so their anchor indices must be non-decreasing too.
    for (let i = 1; i < stated.length; i++)
      expect(stated[i].cp.anchorIndex).toBeGreaterThanOrEqual(stated[i - 1].cp.anchorIndex)

    for (const { cp, m } of stated) {
      const officialKm = Number(m[1])
      const anchoredKm = track.points.cumDist![cp.anchorIndex] / 1000
      expect(Math.abs(anchoredKm - officialKm)).toBeLessThan(0.5)
    }
  })

  it('both new real COROS FIT recordings parse', async () => {
    const fit1 = readFileSync(join(suppDir, '张家口市_越野跑20260710080013.fit'))
    const fit2 = readFileSync(join(suppDir, '张家口市_越野跑20260725084217.fit'))
    const bufFrom = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    const t1 = await parseFit(bufFrom(fit1), 'a.fit')
    const t2 = await parseFit(bufFrom(fit2), 'b.fit')
    expect(t1.points.lon.length).toBeGreaterThan(0)
    expect(t2.points.lon.length).toBeGreaterThan(0)
  })
})
