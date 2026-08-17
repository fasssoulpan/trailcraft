import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../../src/core/model/track'
import { computeCumDist } from '../../../src/core/geo/distance'
import type { CheckPoint } from '../../../src/core/model/checkpoint'
import type { PaceParams } from '../../../src/core/pace/models'
import { buildRouteBookData } from '../../../src/core/export/routeBookData'
import { buildWorkbookModel, generateRouteBookWorkbook } from '../../../src/core/export/excelRouteBook'

function climbingTrack(n = 200): Track {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.0005)
  const lat = Array.from({ length: n }, () => 39.9)
  const ele = Array.from({ length: n }, (_, i) => 1000 + i * 5)
  const t = createTrack({ lon, lat, ele }, { name: '崇礼168', format: 'gpx', fileName: 'climb.gpx' })
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

function sampleData(cutoffIso?: string) {
  const t = climbingTrack()
  const cps = [cp('c1', 'CP1', 50, t.id, cutoffIso), cp('c2', 'CP2', 120, t.id)]
  return buildRouteBookData(t, cps, pace, statsOptions, startIso)
}

describe('buildWorkbookModel', () => {
  it('overview sheet includes track name, distance, ascent/descent and pace params -- no ExcelJS involved', () => {
    const data = sampleData()
    const model = buildWorkbookModel(data)
    expect(model.overview.sheetName).toBe('全程概述')
    const labels = model.overview.rows.map((r) => r.label)
    expect(labels).toContain('轨迹名称')
    expect(labels).toContain('全程距离')
    expect(labels).toContain('总爬升')
    expect(labels).toContain('总下降')
    expect(labels).toContain('配速模型')
    const trackNameRow = model.overview.rows.find((r) => r.label === '轨迹名称')
    expect(trackNameRow?.value).toBe('崇礼168')
  })

  it('node detail sheet has one row per RouteBookData row with matching formatted numbers', () => {
    const data = sampleData()
    const model = buildWorkbookModel(data)
    expect(model.nodeDetail.rows).toHaveLength(data.rows.length)
    model.nodeDetail.rows.forEach((row, i) => {
      expect(row.distKm).toBe((data.rows[i].distM / 1000).toFixed(2))
      expect(row.gainM).toBe(data.rows[i].gain.toFixed(0))
    })
  })

  it('status colour level comes straight from RouteBookData -- never re-derives a threshold', () => {
    const data = sampleData('2026-08-07T20:00:00+08:00') // generous cutoff -> green
    const model = buildWorkbookModel(data)
    expect(model.nodeDetail.rows[0].statusLevel).toBe(data.rows[0].level)
    expect(model.nodeDetail.rows[0].statusLevel).toBe('green')
    expect(model.nodeDetail.rows[0].statusLabel).toBe('安全')
  })

  it('an impossible cutoff produces a red row with a negative margin label', () => {
    const data = sampleData('2026-08-07T06:05:00+08:00') // 5 minutes after start, unreachable
    const model = buildWorkbookModel(data)
    expect(model.nodeDetail.rows[0].statusLevel).toBe('red')
    expect(model.nodeDetail.rows[0].margin.startsWith('-')).toBe(true)
  })

  it('a segment with no cutoff time shows placeholders, not a fabricated status colour', () => {
    const data = sampleData() // no cutoffIso on CP1
    const model = buildWorkbookModel(data)
    expect(model.nodeDetail.rows[0].cutoff).toBe('--')
    expect(model.nodeDetail.rows[0].margin).toBe('--')
    // still green (no cutoff means "cannot miss it"), matching estimateArrivals' own rule
    expect(model.nodeDetail.rows[0].statusLevel).toBe('green')
  })

  it('headers describe every column actually populated in the rows', () => {
    const data = sampleData()
    const model = buildWorkbookModel(data)
    expect(model.nodeDetail.headers).toHaveLength(11)
    expect(model.nodeDetail.headers[0]).toBe('起点')
    expect(model.nodeDetail.headers[model.nodeDetail.headers.length - 1]).toBe('状态')
  })
})

// ExcelJS's dynamic import() (cold module graph) plus a real xlsx
// write+parse round-trip is measurably slower than the rest of this
// project's tests -- 20s headroom avoids flaking on a loaded CI box while
// still catching a genuine hang.
describe('generateRouteBookWorkbook (real ExcelJS round-trip)', () => {
  it('produces a non-empty xlsx Blob with the expected sheet names and header row, re-readable by ExcelJS', async () => {
    const data = sampleData('2026-08-07T20:00:00+08:00')
    const model = buildWorkbookModel(data)
    const blob = await generateRouteBookWorkbook(model)
    expect(blob.size).toBeGreaterThan(0)

    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await blob.arrayBuffer())
    const sheetNames = wb.worksheets.map((ws) => ws.name)
    expect(sheetNames).toEqual(['全程概述', '节点明细'])

    const ws2 = wb.getWorksheet('节点明细')!
    const headerRow = ws2.getRow(1).values as unknown[]
    // ExcelJS row.values is 1-indexed with a leading empty slot
    expect(headerRow[1]).toBe('起点')
    expect(ws2.rowCount).toBe(model.nodeDetail.rows.length + 1) // + header row
  }, 20000)

  it('embeds the elevation profile image into 全程概述 when a PNG buffer is provided', async () => {
    const data = sampleData()
    const model = buildWorkbookModel(data)
    const fakePng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer // PNG magic bytes, minimal stub
    const blob = await generateRouteBookWorkbook(model, fakePng)

    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await blob.arrayBuffer())
    const ws1 = wb.getWorksheet('全程概述')!
    expect(ws1.getImages().length).toBe(1)
  }, 20000)
})
