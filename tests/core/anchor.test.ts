import { describe, it, expect } from 'vitest'
import { anchorMonotonic } from '../../src/core/stats/anchor'

/**
 * 合成一条往返(out-and-back)轨迹:
 * 出程 11 个点,从 lon 116 起,沿纬度 39.9 每步东移 0.001:
 *   index 0..10  -> lon 116.000 .. 116.010
 * 回程 10 个点,原路折返:
 *   index 11..20 -> lon 116.009 .. 116.000 (每步西移 0.001)
 * 因此 lon=116.003 在出程 index 3 和回程 index 17 各出现一次(经度相同,
 * 距离恰好为 0,可用于验证"同一坐标两次经过时,按点击顺序锚定到不同的通过点")。
 */
function outAndBack() {
  const n = 21
  const lon = new Float64Array(n)
  const lat = new Float64Array(n)
  for (let i = 0; i <= 10; i++) {
    lon[i] = 116 + i * 0.001
    lat[i] = 39.9
  }
  for (let i = 0; i <= 9; i++) {
    lon[11 + i] = 116.009 - i * 0.001
    lat[11 + i] = 39.9
  }
  return { lon, lat }
}

describe('anchorMonotonic', () => {
  it('anchors repeated clicks at the same coordinate to successive passes (headline case)', () => {
    const { lon, lat } = outAndBack()
    const idx = anchorMonotonic(lon, lat, [
      [116.003, 39.9],
      [116.003, 39.9],
    ])
    expect(idx[0]).toBe(3)
    expect(idx[1]).toBeGreaterThan(10)
  })

  it('keeps indices strictly increasing even when the second click\'s true nearest point lies before the first anchor', () => {
    const { lon, lat } = outAndBack()
    // click1 -> outbound index 8 (lon 116.008)
    // click2's globally-nearest point is outbound index 1 (lon 116.001), which
    // is *before* click1's anchor. The monotonic constraint must force it to
    // the return-leg point at the same longitude (index 19) instead.
    const idx = anchorMonotonic(lon, lat, [
      [116.008, 39.9],
      [116.001, 39.9],
    ])
    expect(idx[0]).toBe(8)
    expect(idx[1]).toBe(19)
    expect(idx[1]).toBeGreaterThan(idx[0])
  })

  it('returns [] for an empty clicks array', () => {
    const { lon, lat } = outAndBack()
    expect(anchorMonotonic(lon, lat, [])).toEqual([])
  })

  it('more clicks than remaining points: stays in bounds and never throws', () => {
    const lon = Float64Array.from([116, 116.001, 116.002])
    const lat = Float64Array.from([39.9, 39.9, 39.9])
    const clicks: [number, number][] = [
      [116.002, 39.9],
      [116.002, 39.9],
      [116.002, 39.9],
      [116.002, 39.9],
      [116.002, 39.9],
    ]
    // Once `from` saturates at n-1, every further click re-anchors to the
    // last point (from = min(bestIndex + 1, n - 1) clamps there forever) —
    // it does not throw or go out of bounds, but it also stops being able
    // to move forward, so indices from that point on repeat n-1.
    expect(() => anchorMonotonic(lon, lat, clicks)).not.toThrow()
    const idx = anchorMonotonic(lon, lat, clicks)
    expect(idx).toHaveLength(5)
    for (const i of idx) {
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(3)
    }
    expect(idx[2]).toBe(2)
    expect(idx[3]).toBe(2)
    expect(idx[4]).toBe(2)
  })

  it('single-point track does not throw', () => {
    const lon = Float64Array.from([116])
    const lat = Float64Array.from([39.9])
    expect(() => anchorMonotonic(lon, lat, [[116, 39.9], [200, 80]])).not.toThrow()
    expect(anchorMonotonic(lon, lat, [[116, 39.9], [200, 80]])).toEqual([0, 0])
  })
})
