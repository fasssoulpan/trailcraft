import { describe, it, expect } from 'vitest'
import { computeGainLoss, smoothElevation } from '../../src/core/stats/elevation'
import { buildRunningGain, buildRunningLoss, buildRunningGainLoss, gradientAt, GRADIENT_WINDOW } from '../../src/core/stats/runningStats'

describe('buildRunningGain / buildRunningLoss equivalence with computeGainLoss', () => {
  const profiles: Array<{ name: string; ele: number[] }> = [
    { name: 'real climb sequence', ele: [100, 110, 105, 120, 90] },
    { name: 'jittery flat', ele: [100, 104, 100, 104, 100, 104, 100, 104, 100, 104] },
    { name: 'long steady climb', ele: Array.from({ length: 200 }, (_, i) => 100 + i * 2) },
    { name: 'sawtooth descent', ele: [500, 480, 495, 460, 470, 430, 440, 400] },
    { name: 'single point', ele: [123] },
    { name: 'flat line', ele: [50, 50, 50, 50, 50] },
  ]
  const thresholds = [3, 5, 10]
  const smoothWindows = [1, 5]

  for (const p of profiles) {
    for (const threshold of thresholds) {
      for (const smoothWindow of smoothWindows) {
        it(`${p.name}, threshold=${threshold}, smoothWindow=${smoothWindow}: last prefix element matches computeGainLoss`, () => {
          const ele = Float32Array.from(p.ele)
          const gain = buildRunningGain(ele, threshold, smoothWindow)
          const loss = buildRunningLoss(ele, threshold, smoothWindow)
          const smoothed = smoothElevation(ele, smoothWindow)
          const expected = computeGainLoss(smoothed, threshold)
          expect(gain[gain.length - 1]).toBeCloseTo(expected.gain, 6)
          expect(loss[loss.length - 1]).toBeCloseTo(expected.loss, 6)
        })
      }
    }
  }

  it('buildRunningGainLoss returns both arrays consistent with the individual helpers', () => {
    const ele = Float32Array.from([100, 110, 105, 120, 90, 150, 140])
    const { gain, loss } = buildRunningGainLoss(ele, 5, 3)
    expect(Array.from(gain)).toEqual(Array.from(buildRunningGain(ele, 5, 3)))
    expect(Array.from(loss)).toEqual(Array.from(buildRunningLoss(ele, 5, 3)))
  })
})

describe('buildRunningGain / buildRunningLoss: monotonicity and edge cases', () => {
  it('prefix arrays are monotonically non-decreasing', () => {
    const ele = Float32Array.from([100, 130, 90, 160, 70, 200, 50, 40, 300])
    const gain = buildRunningGain(ele, 5, 1)
    const loss = buildRunningLoss(ele, 5, 1)
    for (let i = 1; i < gain.length; i++) {
      expect(gain[i]).toBeGreaterThanOrEqual(gain[i - 1])
      expect(loss[i]).toBeGreaterThanOrEqual(loss[i - 1])
    }
  })

  it('NaN elevations are skipped without breaking accumulation', () => {
    const ele = Float32Array.from([100, NaN, 110, NaN, NaN, 120, 90])
    expect(() => buildRunningGain(ele, 5, 1)).not.toThrow()
    const gain = buildRunningGain(ele, 5, 1)
    const loss = buildRunningLoss(ele, 5, 1)
    // NaN positions repeat the last accumulated value, not a fabricated one.
    expect(gain[1]).toBe(gain[0])
    expect(gain[3]).toBe(gain[2])
    expect(gain[4]).toBe(gain[2])
    // 100 -> 110 (+10), 110 -> 120 (+10): total gain 20; 120 -> 90 (-30): loss 30.
    expect(gain[gain.length - 1]).toBeCloseTo(20, 5)
    expect(loss[loss.length - 1]).toBeCloseTo(30, 5)
  })

  it('all-NaN elevation column: prefix arrays are all zero, no throw', () => {
    const ele = Float32Array.from([NaN, NaN, NaN, NaN])
    const gain = buildRunningGain(ele, 5, 1)
    const loss = buildRunningLoss(ele, 5, 1)
    expect(Array.from(gain)).toEqual([0, 0, 0, 0])
    expect(Array.from(loss)).toEqual([0, 0, 0, 0])
  })

  it('a track with no elevation column (undefined) is handled without throwing', () => {
    expect(() => buildRunningGain(undefined, 5, 5)).not.toThrow()
    expect(() => buildRunningLoss(undefined, 5, 5)).not.toThrow()
    expect(buildRunningGain(undefined, 5, 5).length).toBe(0)
    expect(buildRunningLoss(undefined, 5, 5).length).toBe(0)
  })

  it('empty elevation array is handled without throwing', () => {
    const ele = Float32Array.from([])
    expect(() => buildRunningGain(ele, 5, 5)).not.toThrow()
    expect(buildRunningGain(ele, 5, 5).length).toBe(0)
  })

  it('a higher threshold never produces more cumulative gain than a lower one', () => {
    const ele = Float32Array.from([100, 104, 100, 104, 100, 104, 100, 104, 100, 104])
    const lowGain = buildRunningGain(ele, 3, 1)
    const highGain = buildRunningGain(ele, 10, 1)
    expect(lowGain[lowGain.length - 1]).toBeGreaterThan(highGain[highGain.length - 1])
  })
})

describe('gradientAt', () => {
  it('positive slope reports a positive gradient of the expected magnitude', () => {
    // 100m rise over 1000m run at the window edges -> 10%.
    const ele = Float64Array.from([0, 25, 50, 75, 100])
    const dist = Float64Array.from([0, 250, 500, 750, 1000])
    const g = gradientAt(ele, dist, 2, 2)
    expect(g).toBeCloseTo(10, 5)
  })

  it('negative slope reports a negative gradient', () => {
    const ele = Float64Array.from([100, 75, 50, 25, 0])
    const dist = Float64Array.from([0, 250, 500, 750, 1000])
    const g = gradientAt(ele, dist, 2, 2)
    expect(g).toBeCloseTo(-10, 5)
  })

  it('flat terrain reports ~0%', () => {
    const ele = Float64Array.from([50, 50, 50, 50, 50])
    const dist = Float64Array.from([0, 100, 200, 300, 400])
    const g = gradientAt(ele, dist, 2, 2)
    expect(g).toBeCloseTo(0, 5)
  })

  it('skips non-finite samples at the window edges', () => {
    const ele = Float64Array.from([NaN, 10, 20, 30, NaN])
    const dist = Float64Array.from([0, 100, 200, 300, 400])
    // window edges are NaN, but 10 -> 30 over 200m still resolves to 10%
    const g = gradientAt(ele, dist, 2, 2)
    expect(g).toBeCloseTo(10, 5)
  })

  it('returns undefined when the whole window is non-finite', () => {
    const ele = Float64Array.from([NaN, NaN, 20, NaN, NaN])
    const dist = Float64Array.from([0, 100, 200, 300, 400])
    expect(gradientAt(ele, dist, 2, 2)).toBeUndefined()
  })

  it('returns undefined for a zero-distance window', () => {
    const ele = Float64Array.from([10, 10, 20, 10, 10])
    const dist = Float64Array.from([0, 0, 0, 0, 0])
    expect(gradientAt(ele, dist, 2, 2)).toBeUndefined()
  })

  it('returns undefined for an empty array', () => {
    expect(gradientAt(Float64Array.from([]), Float64Array.from([]), 0, GRADIENT_WINDOW)).toBeUndefined()
  })

  it('clamps the window at the array bounds instead of throwing', () => {
    const ele = Float64Array.from([0, 10, 20])
    const dist = Float64Array.from([0, 100, 200])
    expect(() => gradientAt(ele, dist, 0, GRADIENT_WINDOW)).not.toThrow()
    expect(() => gradientAt(ele, dist, 2, GRADIENT_WINDOW)).not.toThrow()
  })
})
