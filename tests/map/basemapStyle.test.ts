import { describe, it, expect } from 'vitest'
import {
  OSM_STYLE,
  OSM_SOURCE_ID,
  ESRI_SATELLITE_STYLE,
  ESRI_SATELLITE_SOURCE_ID,
  ALL_RASTER_SOURCE_IDS,
  styleSpecForBasemap,
} from '../../src/map/basemapStyle'

describe('styleSpecForBasemap', () => {
  it('returns OSM_STYLE for plan', () => {
    expect(styleSpecForBasemap('plan')).toBe(OSM_STYLE)
  })

  it('returns ESRI_SATELLITE_STYLE for satellite', () => {
    expect(styleSpecForBasemap('satellite')).toBe(ESRI_SATELLITE_STYLE)
  })
})

describe('ESRI_SATELLITE_STYLE', () => {
  it('uses the {z}/{y}/{x} tile template, not {z}/{x}/{y}', () => {
    const source = ESRI_SATELLITE_STYLE.sources[ESRI_SATELLITE_SOURCE_ID] as { tiles?: string[] }
    expect(source.tiles?.[0]).toContain('/{z}/{y}/{x}')
  })

  it('carries an attribution string so MapLibre\'s default AttributionControl can display it', () => {
    const source = ESRI_SATELLITE_STYLE.sources[ESRI_SATELLITE_SOURCE_ID] as { attribution?: string }
    expect(source.attribution).toMatch(/Esri/)
  })

  it('has its own layer/source id, distinct from the OSM style', () => {
    expect(ESRI_SATELLITE_SOURCE_ID).not.toBe(OSM_SOURCE_ID)
    expect(Object.keys(ESRI_SATELLITE_STYLE.sources)).toEqual([ESRI_SATELLITE_SOURCE_ID])
    expect(Object.keys(OSM_STYLE.sources)).toEqual([OSM_SOURCE_ID])
  })
})

describe('ALL_RASTER_SOURCE_IDS', () => {
  it('lists both basemap source ids', () => {
    expect(ALL_RASTER_SOURCE_IDS).toContain(OSM_SOURCE_ID)
    expect(ALL_RASTER_SOURCE_IDS).toContain(ESRI_SATELLITE_SOURCE_ID)
    expect(ALL_RASTER_SOURCE_IDS.length).toBe(2)
  })
})
