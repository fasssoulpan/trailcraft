import { describe, expect, it, vi } from 'vitest'
import {
  ESRI_IMAGERY_URL,
  maptilerImageryUrl,
  maptilerTerrainUrl,
  selectImagery,
  selectTerrain,
} from '../../src/cesium/terrainSelection'

describe('selectTerrain', () => {
  it('goes straight to Esri when no MapTiler key is configured (the normal case)', async () => {
    const loadMapTiler = vi.fn().mockResolvedValue('maptiler-provider')
    const loadEsri = vi.fn().mockResolvedValue('esri-provider')
    const createEllipsoid = vi.fn().mockReturnValue('ellipsoid-provider')

    const result = await selectTerrain({ hasMapTilerKey: false, loadMapTiler, loadEsri, createEllipsoid })

    expect(result).toEqual({ provider: 'esri-provider', source: 'esri' })
    expect(loadMapTiler).not.toHaveBeenCalled()
    expect(createEllipsoid).not.toHaveBeenCalled()
  })

  it('prefers MapTiler when a key is configured and the fetch succeeds', async () => {
    const loadMapTiler = vi.fn().mockResolvedValue('maptiler-provider')
    const loadEsri = vi.fn().mockResolvedValue('esri-provider')
    const createEllipsoid = vi.fn().mockReturnValue('ellipsoid-provider')

    const result = await selectTerrain({ hasMapTilerKey: true, loadMapTiler, loadEsri, createEllipsoid })

    expect(result).toEqual({ provider: 'maptiler-provider', source: 'maptiler' })
    expect(loadEsri).not.toHaveBeenCalled()
    expect(createEllipsoid).not.toHaveBeenCalled()
  })

  it('falls back to Esri when the MapTiler fetch throws', async () => {
    const loadMapTiler = vi.fn().mockRejectedValue(new Error('bad key'))
    const loadEsri = vi.fn().mockResolvedValue('esri-provider')
    const createEllipsoid = vi.fn().mockReturnValue('ellipsoid-provider')

    const result = await selectTerrain({ hasMapTilerKey: true, loadMapTiler, loadEsri, createEllipsoid })

    expect(result).toEqual({ provider: 'esri-provider', source: 'esri' })
    expect(createEllipsoid).not.toHaveBeenCalled()
  })

  it('falls back to the flat ellipsoid when Esri also throws (no MapTiler key)', async () => {
    const loadMapTiler = vi.fn()
    const loadEsri = vi.fn().mockRejectedValue(new Error('network down'))
    const createEllipsoid = vi.fn().mockReturnValue('ellipsoid-provider')

    const result = await selectTerrain({ hasMapTilerKey: false, loadMapTiler, loadEsri, createEllipsoid })

    expect(result).toEqual({ provider: 'ellipsoid-provider', source: 'ellipsoid' })
    expect(loadMapTiler).not.toHaveBeenCalled()
  })

  it('falls all the way to the flat ellipsoid when both MapTiler and Esri throw', async () => {
    const loadMapTiler = vi.fn().mockRejectedValue(new Error('bad key'))
    const loadEsri = vi.fn().mockRejectedValue(new Error('network down'))
    const createEllipsoid = vi.fn().mockReturnValue('ellipsoid-provider')

    const result = await selectTerrain({ hasMapTilerKey: true, loadMapTiler, loadEsri, createEllipsoid })

    expect(result).toEqual({ provider: 'ellipsoid-provider', source: 'ellipsoid' })
  })
})

describe('selectImagery', () => {
  it('uses Esri World Imagery when no key is configured', () => {
    expect(selectImagery(undefined)).toEqual({
      url: ESRI_IMAGERY_URL,
      credit: 'Esri, Maxar, Earthstar Geographics',
      source: 'esri',
    })
  })

  it('uses MapTiler satellite when a key is configured', () => {
    expect(selectImagery('KEY123')).toEqual({
      url: maptilerImageryUrl('KEY123'),
      credit: 'MapTiler',
      source: 'maptiler',
    })
  })

  it("Esri's tile URL template uses {z}/{y}/{x} order, not the usual {z}/{x}/{y}", () => {
    expect(ESRI_IMAGERY_URL).toContain('/{z}/{y}/{x}')
  })

  it('MapTiler URL builders embed the key in the URL', () => {
    expect(maptilerTerrainUrl('abc')).toBe('https://api.maptiler.com/tiles/terrain-quantized-mesh-v2/?key=abc')
    expect(maptilerImageryUrl('abc')).toBe('https://api.maptiler.com/maps/satellite/{z}/{x}/{y}.jpg?key=abc')
  })
})
