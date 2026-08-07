import { describe, it, expect } from 'vitest'
import { smoothElevation, computeGainLoss } from '../../src/core/stats/elevation'

describe('smoothElevation', () => {
  it('pulls a single-sample spike toward its neighbours', () => {
    const ele = Float32Array.from([100, 100, 200, 100, 100])
    const out = smoothElevation(ele, 5)
    expect(out[2]).toBeLessThan(200)
    expect(out[2]).toBeGreaterThan(100)
  })

  it('NaN at a position stays NaN and does not poison neighbours', () => {
    const ele = Float32Array.from([100, NaN, 100, 100, 100])
    const out = smoothElevation(ele, 5)
    expect(Number.isNaN(out[1])).toBe(true)
    expect(out[0]).toBeCloseTo(100, 5)
    expect(out[2]).toBeCloseTo(100, 5)
  })

  it('window larger than the array does not crash', () => {
    const ele = Float32Array.from([100, 110, 105])
    expect(() => smoothElevation(ele, 999)).not.toThrow()
    const out = smoothElevation(ele, 999)
    expect(out.length).toBe(3)
    expect(out[1]).toBeCloseTo(105, 3)
  })

  it('window 1 is identity', () => {
    const ele = Float32Array.from([100, 110, NaN, 90])
    const out = smoothElevation(ele, 1)
    expect(out[0]).toBe(100)
    expect(out[1]).toBe(110)
    expect(Number.isNaN(out[2])).toBe(true)
    expect(out[3]).toBe(90)
  })
})

describe('computeGainLoss', () => {
  it('oscillation below threshold yields zero gain and loss', () => {
    const ele = Float32Array.from([100, 103, 100, 103, 100])
    const { gain, loss } = computeGainLoss(ele, 5)
    expect(gain).toBe(0)
    expect(loss).toBe(0)
  })

  it('a real climb sequence accumulates gain/loss only past the threshold', () => {
    const ele = Float32Array.from([100, 110, 105, 120, 90])
    const { gain, loss } = computeGainLoss(ele, 5)
    // 100->110 (+10) and 105->120 (+15) both clear the threshold: gain 25
    expect(gain).toBeCloseTo(25, 5)
    // 110->105 (-5) and 120->90 (-30) both clear the threshold: loss 35
    expect(loss).toBeCloseTo(35, 5)
  })

  it('lower threshold yields more gain than higher threshold on jittery input', () => {
    const ele = Float32Array.from([100, 104, 100, 104, 100, 104, 100, 104, 100, 104])
    const low = computeGainLoss(ele, 3)
    const high = computeGainLoss(ele, 10)
    expect(low.gain).toBeGreaterThan(high.gain)
  })

  it('all-NaN array yields 0/0', () => {
    const ele = Float32Array.from([NaN, NaN, NaN])
    const { gain, loss } = computeGainLoss(ele, 5)
    expect(gain).toBe(0)
    expect(loss).toBe(0)
  })

  it('empty array yields 0/0', () => {
    const { gain, loss } = computeGainLoss(Float32Array.from([]), 5)
    expect(gain).toBe(0)
    expect(loss).toBe(0)
  })
})
