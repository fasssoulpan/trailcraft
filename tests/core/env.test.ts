import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import { computeEnvCompensation } from '../../src/core/perf/env'

function track(opts: { n: number; ele?: number[]; step?: number }): Track {
  const step = opts.step ?? 0.001
  const lon = Array.from({ length: opts.n }, (_, i) => 116 + i * step)
  const lat = Array.from({ length: opts.n }, () => 39)
  const t = createTrack({ lon, lat, ele: opts.ele }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

describe('computeEnvCompensation', () => {
  it('is fully neutral (1.0/1.0/1.0) at sea level with no temperature/humidity profile', () => {
    const t = track({ n: 20, ele: Array.from({ length: 20 }, () => 50) })
    const r = computeEnvCompensation(t)
    expect(r.heatFactor).toBe(1.0)
    expect(r.altFactor).toBe(1.0)
    expect(r.totalFactor).toBe(1.0)
  })

  it('altFactor is neutral below the 300m compensation threshold', () => {
    const t = track({ n: 20, ele: Array.from({ length: 20 }, () => 250) })
    const r = computeEnvCompensation(t)
    expect(r.altFactor).toBe(1.0)
  })

  it('altFactor is > 1.0 (penalty) at high mean altitude', () => {
    const t = track({ n: 20, ele: Array.from({ length: 20 }, () => 3500) })
    const r = computeEnvCompensation(t)
    expect(r.altFactor).toBeGreaterThan(1.0)
  })

  it('altFactor stays neutral when the track has no elevation column', () => {
    const t = track({ n: 20 })
    const r = computeEnvCompensation(t)
    expect(r.altFactor).toBe(1.0)
  })

  it('heatFactor is neutral at or below 16 degrees', () => {
    const t = track({ n: 10, ele: Array.from({ length: 10 }, () => 50) })
    expect(computeEnvCompensation(t, { temperature: 16 }).heatFactor).toBe(1.0)
    expect(computeEnvCompensation(t, { temperature: 5 }).heatFactor).toBe(1.0)
  })

  it('heatFactor rises above 16 degrees, capped at 1.10', () => {
    const t = track({ n: 10, ele: Array.from({ length: 10 }, () => 50) })
    const mild = computeEnvCompensation(t, { temperature: 26 })
    expect(mild.heatFactor).toBeGreaterThan(1.0)
    expect(mild.heatFactor).toBeLessThanOrEqual(1.1)

    const extreme = computeEnvCompensation(t, { temperature: 45, humidity: 90 })
    expect(extreme.heatFactor).toBe(1.1)
  })

  it('humidity above 60% adds an additional penalty on top of heat, only when temperature > 16', () => {
    const t = track({ n: 10, ele: Array.from({ length: 10 }, () => 50) })
    const dry = computeEnvCompensation(t, { temperature: 25, humidity: 40 })
    const humid = computeEnvCompensation(t, { temperature: 25, humidity: 80 })
    expect(humid.heatFactor).toBeGreaterThan(dry.heatFactor)
  })

  it('totalFactor is the product of heatFactor and altFactor', () => {
    const t = track({ n: 10, ele: Array.from({ length: 10 }, () => 3000) })
    const r = computeEnvCompensation(t, { temperature: 30 })
    expect(r.totalFactor).toBeCloseTo(Math.round(r.heatFactor * r.altFactor * 1000) / 1000, 6)
  })
})
