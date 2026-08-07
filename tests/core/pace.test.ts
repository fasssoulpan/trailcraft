import { describe, it, expect } from 'vitest'
import {
  toblerSpeed,
  practicalSegmentTime,
  toblerSegmentTime,
  estimateArrivals,
  type PaceParams,
  type SegmentLike,
} from '../../src/core/pace/models'

describe('toblerSpeed', () => {
  it('flat (slope 0) is slower than the peak at slope -0.05', () => {
    expect(toblerSpeed(0)).toBeLessThan(toblerSpeed(-0.05))
  })

  it('a steep uphill (0.3) is much slower than flat', () => {
    const flat = toblerSpeed(0)
    const steepUp = toblerSpeed(0.3)
    expect(steepUp).toBeLessThan(flat / 2)
  })

  it('a steep descent (-0.4) is slower than a gentle descent (-0.1)', () => {
    expect(toblerSpeed(-0.4)).toBeLessThan(toblerSpeed(-0.1))
  })

  it('points symmetric around the -0.05 peak are equal', () => {
    // -0.05 + 0.1 = 0.05, -0.05 - 0.1 = -0.15, both 0.1 away from the peak
    expect(toblerSpeed(0.05)).toBeCloseTo(toblerSpeed(-0.15), 10)
  })
})

const basePaceParams: PaceParams = {
  flatPaceSecPerKm: 360,
  vamMPerH: 800,
  descentFactor: 2,
  fatiguePctPerHour: 0,
}

describe('practicalSegmentTime', () => {
  it('10 km flat at 360 s/km with zero fatigue is exactly 3600 s', () => {
    const seg: SegmentLike = { dist: 10000, gain: 0, loss: 0 }
    expect(practicalSegmentTime(seg, basePaceParams, 0)).toBeCloseTo(3600, 6)
  })

  it('800 m of gain at VAM 800 with zero distance is exactly 3600 s', () => {
    const seg: SegmentLike = { dist: 0, gain: 800, loss: 0 }
    expect(practicalSegmentTime(seg, basePaceParams, 0)).toBeCloseTo(3600, 6)
  })

  it('descent contributes loss x descentFactor', () => {
    const seg: SegmentLike = { dist: 0, gain: 0, loss: 100 }
    expect(practicalSegmentTime(seg, basePaceParams, 0)).toBeCloseTo(100 * basePaceParams.descentFactor, 6)
  })

  it('a segment run after 10 hours elapsed at 5%/h fatigue takes at least 1.4x the fresh time', () => {
    const seg: SegmentLike = { dist: 10000, gain: 0, loss: 0 }
    const p: PaceParams = { ...basePaceParams, fatiguePctPerHour: 5 }
    const fresh = practicalSegmentTime(seg, p, 0)
    const tired = practicalSegmentTime(seg, p, 10 * 3600)
    expect(tired).toBeGreaterThanOrEqual(fresh * 1.4)
  })
})

describe('toblerSegmentTime', () => {
  it('on flat ground with zero fatigue it reproduces the user flat pace (10 km at 360 s/km ~ 3600 s)', () => {
    const seg: SegmentLike = { dist: 10000, gain: 0, loss: 0 }
    expect(toblerSegmentTime(seg, basePaceParams, 0)).toBeCloseTo(3600, 2)
  })

  it('an uphill segment takes longer than the same distance flat', () => {
    const flatSeg: SegmentLike = { dist: 1000, gain: 0, loss: 0 }
    const upSeg: SegmentLike = { dist: 1000, gain: 100, loss: 0 }
    const flatTime = toblerSegmentTime(flatSeg, basePaceParams, 0)
    const upTime = toblerSegmentTime(upSeg, basePaceParams, 0)
    expect(upTime).toBeGreaterThan(flatTime)
  })
})

describe('estimateArrivals', () => {
  const segs: SegmentLike[] = [
    { dist: 5000, gain: 200, loss: 0 },
    { dist: 5000, gain: 0, loss: 200 },
    { dist: 5000, gain: 100, loss: 100 },
  ]
  const startMs = Date.UTC(2026, 7, 7, 6, 0, 0) // 2026-08-07T06:00:00Z

  it('arrival times increase monotonically', () => {
    const arrivals = estimateArrivals(segs, basePaceParams, startMs, [undefined, undefined, undefined])
    expect(arrivals[0].etaMs).toBeGreaterThan(startMs)
    expect(arrivals[1].etaMs).toBeGreaterThan(arrivals[0].etaMs)
    expect(arrivals[2].etaMs).toBeGreaterThan(arrivals[1].etaMs)
  })

  it('a generous cutoff is green', () => {
    const [arrival] = estimateArrivals([segs[0]], basePaceParams, startMs, [startMs + 100 * 3600 * 1000])
    expect(arrival.level).toBe('green')
    expect(arrival.marginSec).toBeGreaterThan(0)
  })

  it('an impossible cutoff (before the start) is red', () => {
    const [arrival] = estimateArrivals([segs[0]], basePaceParams, startMs, [startMs - 1000])
    expect(arrival.level).toBe('red')
    expect(arrival.marginSec).toBeLessThan(0)
  })

  it('a cutoff met with a small margin is yellow', () => {
    const seg = segs[0]
    const segTime = practicalSegmentTime(seg, basePaceParams, 0)
    const threshold = Math.max(segTime * 0.15, 1200)
    const etaMs = startMs + segTime * 1000
    // margin just inside the yellow band: positive but below threshold
    const cutoffMs = etaMs + (threshold - 1) * 1000
    const [arrival] = estimateArrivals([seg], basePaceParams, startMs, [cutoffMs])
    expect(arrival.level).toBe('yellow')
    expect(arrival.marginSec).toBeGreaterThanOrEqual(0)
    expect(arrival.marginSec).toBeLessThan(threshold)
  })

  it('a missing cutoff is green with infinite margin', () => {
    const [arrival] = estimateArrivals([segs[0]], basePaceParams, startMs, [undefined])
    expect(arrival.level).toBe('green')
    expect(arrival.marginSec).toBe(Infinity)
  })

  it('fatigue makes a later identical segment slower than an earlier one', () => {
    const seg: SegmentLike = { dist: 20000, gain: 0, loss: 0 } // long enough to build up elapsed time
    const p: PaceParams = { ...basePaceParams, fatiguePctPerHour: 20 }
    const arrivals = estimateArrivals([seg, seg], p, startMs, [undefined, undefined])
    const firstDurationSec = (arrivals[0].etaMs - startMs) / 1000
    const secondDurationSec = (arrivals[1].etaMs - arrivals[0].etaMs) / 1000
    expect(secondDurationSec).toBeGreaterThan(firstDurationSec)
  })
})
