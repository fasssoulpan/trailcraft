import { describe, expect, it } from 'vitest'
import { terrainProviderForStyle } from '../../src/cesium/basemap'

describe('terrainProviderForStyle', () => {
  const providers = { threeD: 'three-d-provider', flat: 'flat-provider' }

  it('picks the flat provider for the plan style', () => {
    expect(terrainProviderForStyle('plan', providers)).toBe('flat-provider')
  })

  it('picks the 3D provider for the satellite style', () => {
    expect(terrainProviderForStyle('satellite', providers)).toBe('three-d-provider')
  })
})
