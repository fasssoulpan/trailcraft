import { describe, it, expect } from 'vitest'
import { createTrack } from '../../src/core/model/track'
import { computeSensorCoverage } from '../../src/core/perf/sensorCoverage'

describe('computeSensorCoverage', () => {
  it('a column that is wholly absent reports present:false, coverage 0, no min/max/mean', () => {
    const t = createTrack({ lon: [0, 1, 2], lat: [0, 0, 0] }, { name: 't', format: 'fit', fileName: 't.fit' })
    const cov = computeSensorCoverage(t.points)
    for (const stat of [cov.hr, cov.cadence, cov.power, cov.temperature]) {
      expect(stat.present).toBe(false)
      expect(stat.totalCount).toBe(0)
      expect(stat.validCount).toBe(0)
      expect(stat.coverage).toBe(0)
      expect(stat.min).toBeUndefined()
      expect(stat.max).toBeUndefined()
      expect(stat.mean).toBeUndefined()
    }
  })

  it('hr: all points have a real (non-zero) reading -> coverage 1, correct min/max/mean', () => {
    const t = createTrack(
      { lon: [0, 1, 2], lat: [0, 0, 0], hr: [100, 120, 140] },
      { name: 't', format: 'fit', fileName: 't.fit' },
    )
    const cov = computeSensorCoverage(t.points)
    expect(cov.hr.present).toBe(true)
    expect(cov.hr.totalCount).toBe(3)
    expect(cov.hr.validCount).toBe(3)
    expect(cov.hr.coverage).toBe(1)
    expect(cov.hr.min).toBe(100)
    expect(cov.hr.max).toBe(140)
    expect(cov.hr.mean).toBeCloseTo(120, 10)
  })

  it('hr: column present but every point is the 0 sentinel -> present true, coverage 0, no min/max/mean', () => {
    const t = createTrack(
      { lon: [0, 1, 2], lat: [0, 0, 0], hr: [0, 0, 0] },
      { name: 't', format: 'fit', fileName: 't.fit' },
    )
    const cov = computeSensorCoverage(t.points)
    expect(cov.hr.present).toBe(true)
    expect(cov.hr.validCount).toBe(0)
    expect(cov.hr.coverage).toBe(0)
    expect(cov.hr.min).toBeUndefined()
  })

  it('hr: partial coverage -- 0 readings excluded from validCount and from min/max/mean', () => {
    const t = createTrack(
      { lon: [0, 1, 2, 3], lat: [0, 0, 0, 0], hr: [0, 100, 0, 140] },
      { name: 't', format: 'fit', fileName: 't.fit' },
    )
    const cov = computeSensorCoverage(t.points)
    expect(cov.hr.totalCount).toBe(4)
    expect(cov.hr.validCount).toBe(2)
    expect(cov.hr.coverage).toBeCloseTo(0.5, 10)
    expect(cov.hr.min).toBe(100)
    expect(cov.hr.max).toBe(140)
    expect(cov.hr.mean).toBeCloseTo(120, 10)
  })

  it('cadence/power/temperature: NaN is the missing sentinel, a real 0 reading counts as valid', () => {
    const t = createTrack(
      {
        lon: [0, 1, 2, 3], lat: [0, 0, 0, 0],
        cadence: [0, NaN, 80, NaN],
        power: [NaN, NaN, 0, 200],
        temperature: [0, -3, NaN, 5],
      },
      { name: 't', format: 'fit', fileName: 't.fit' },
    )
    const cov = computeSensorCoverage(t.points)

    expect(cov.cadence.totalCount).toBe(4)
    expect(cov.cadence.validCount).toBe(2) // 0 and 80 are both real readings
    expect(cov.cadence.coverage).toBeCloseTo(0.5, 10)
    expect(cov.cadence.min).toBe(0)
    expect(cov.cadence.max).toBe(80)
    expect(cov.cadence.mean).toBeCloseTo(40, 10)

    expect(cov.power.validCount).toBe(2) // 0 and 200
    expect(cov.power.min).toBe(0)
    expect(cov.power.max).toBe(200)

    expect(cov.temperature.validCount).toBe(3) // 0, -3, 5
    expect(cov.temperature.min).toBe(-3)
    expect(cov.temperature.max).toBe(5)
    expect(cov.temperature.mean).toBeCloseTo((0 - 3 + 5) / 3, 5)
  })

  it('cadence/power/temperature: all-present column -> coverage 1', () => {
    const t = createTrack(
      { lon: [0, 1, 2], lat: [0, 0, 0], cadence: [80, 82, 84] },
      { name: 't', format: 'fit', fileName: 't.fit' },
    )
    const cov = computeSensorCoverage(t.points)
    expect(cov.cadence.coverage).toBe(1)
    expect(cov.cadence.validCount).toBe(3)
  })

  it('cadence/power/temperature: column present but every point is NaN -> present true, coverage 0', () => {
    const t = createTrack(
      { lon: [0, 1, 2], lat: [0, 0, 0], power: [NaN, NaN, NaN] },
      { name: 't', format: 'fit', fileName: 't.fit' },
    )
    const cov = computeSensorCoverage(t.points)
    expect(cov.power.present).toBe(true)
    expect(cov.power.validCount).toBe(0)
    expect(cov.power.coverage).toBe(0)
    expect(cov.power.mean).toBeUndefined()
  })

  it('sensor columns are independent -- one column can be full coverage while another is wholly absent', () => {
    const t = createTrack(
      { lon: [0, 1, 2], lat: [0, 0, 0], hr: [100, 110, 120] },
      { name: 't', format: 'fit', fileName: 't.fit' },
    )
    const cov = computeSensorCoverage(t.points)
    expect(cov.hr.coverage).toBe(1)
    expect(cov.cadence.present).toBe(false)
    expect(cov.power.present).toBe(false)
    expect(cov.temperature.present).toBe(false)
  })

  it('an empty track (0 points) does not throw and reports coverage 0 for present columns', () => {
    const t = createTrack({ lon: [], lat: [], hr: [], cadence: [] }, { name: 't', format: 'fit', fileName: 't.fit' })
    const cov = computeSensorCoverage(t.points)
    expect(cov.hr.present).toBe(true)
    expect(cov.hr.totalCount).toBe(0)
    expect(cov.hr.coverage).toBe(0)
    expect(cov.cadence.totalCount).toBe(0)
    expect(cov.cadence.coverage).toBe(0)
  })
})
