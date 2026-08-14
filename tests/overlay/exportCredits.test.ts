import { describe, it, expect } from 'vitest'
import { composeExportCredits } from '../../src/overlay/exportCredits'
import { ESRI_IMAGERY_CREDIT, ESRI_STREET_CREDIT } from '../../src/cesium/terrainSelection'

describe('composeExportCredits', () => {
  it('credits both Esri imagery and Esri terrain for the satellite style on the free/keyless chain', () => {
    const credits = composeExportCredits({ terrain: 'esri', imagery: 'esri', basemapStyle: 'satellite' })
    expect(credits.dataCredits).toEqual([`影像数据来自 ${ESRI_IMAGERY_CREDIT}`, '地形数据来自 Esri World Elevation 3D'])
    expect(credits.terrainFallbackNote).toBeUndefined()
  })

  it('credits MapTiler for both imagery and terrain when a MapTiler key is configured', () => {
    const credits = composeExportCredits({ terrain: 'maptiler', imagery: 'maptiler', basemapStyle: 'satellite' })
    expect(credits.dataCredits).toEqual(['影像数据 © MapTiler', '地形数据 © MapTiler'])
  })

  it('credits imagery only, plus an honest fallback note, when terrain degraded to the flat ellipsoid', () => {
    const credits = composeExportCredits({ terrain: 'ellipsoid', imagery: 'esri', basemapStyle: 'satellite' })
    expect(credits.dataCredits).toEqual([`影像数据来自 ${ESRI_IMAGERY_CREDIT}`])
    expect(credits.terrainFallbackNote).toBe('地形：平面（三维地形服务不可达，本次导出未使用外部地形数据）')
  })

  it('mixed sources: MapTiler imagery with Esri terrain fallback (or vice versa) each credit independently', () => {
    const a = composeExportCredits({ terrain: 'esri', imagery: 'maptiler', basemapStyle: 'satellite' })
    expect(a.dataCredits).toEqual(['影像数据 © MapTiler', '地形数据来自 Esri World Elevation 3D'])

    const b = composeExportCredits({ terrain: 'maptiler', imagery: 'esri', basemapStyle: 'satellite' })
    expect(b.dataCredits).toEqual([`影像数据来自 ${ESRI_IMAGERY_CREDIT}`, '地形数据 © MapTiler'])
  })

  it("credits the Esri street layer for the 'plan' style regardless of the satellite style's own provider report", () => {
    // Even if `providers` says MapTiler was selected for the SATELLITE
    // style, an export recorded while '二维平面图' was active must credit
    // what was actually on screen: the Esri street layer over a flat
    // ellipsoid (cesium/viewer.ts's basemapCredit/terrainProviderForStyle),
    // never OSM (which this 3D view never uses at all) and never MapTiler.
    const credits = composeExportCredits({ terrain: 'maptiler', imagery: 'maptiler', basemapStyle: 'plan' })
    expect(credits.dataCredits).toEqual([`影像数据来自 ${ESRI_STREET_CREDIT}`])
    expect(credits.terrainFallbackNote).toBe('地形：平面（该样式不使用三维地形数据）')
  })

  it('never fabricates an OSM or Copernicus credit -- this app never actually selects either for a 3D export', () => {
    for (const terrain of ['maptiler', 'esri', 'ellipsoid'] as const) {
      for (const imagery of ['maptiler', 'esri'] as const) {
        for (const basemapStyle of ['satellite', 'plan'] as const) {
          const credits = composeExportCredits({ terrain, imagery, basemapStyle })
          const all = [...credits.dataCredits, credits.terrainFallbackNote ?? ''].join(' ')
          expect(all).not.toMatch(/OpenStreetMap|OSM|Copernicus/i)
        }
      }
    }
  })

  it('always includes the honest "no bundled music" note, regardless of provider combination', () => {
    const credits = composeExportCredits({ terrain: 'esri', imagery: 'esri', basemapStyle: 'satellite' })
    expect(credits.musicNote).toMatch(/音乐/)
    expect(credits.musicNote).toMatch(/未内置|自行/)
  })

  it('always produces at least one data credit line', () => {
    for (const terrain of ['maptiler', 'esri', 'ellipsoid'] as const) {
      for (const imagery of ['maptiler', 'esri'] as const) {
        for (const basemapStyle of ['satellite', 'plan'] as const) {
          const credits = composeExportCredits({ terrain, imagery, basemapStyle })
          expect(credits.dataCredits.length).toBeGreaterThan(0)
        }
      }
    }
  })
})
