import { describe, it, expect } from 'vitest'
import {
  buildCameraPath,
  sampleAtMileage,
  clampProgress,
  clampMileage,
  progressToMileage,
  mileageToProgress,
  bearingDegrees,
  followCameraOffset,
  speedToMileageDelta,
  averageSpeedMps,
  fullPrecisionIndex,
  DEFAULT_FOLLOW_CAMERA_CONFIG,
  type TrackPathPoint,
} from '../../src/cesium/cameraPath'

function point(lon: number, lat: number, height = 0): TrackPathPoint {
  return { lon, lat, height }
}

describe('buildCameraPath', () => {
  it('throws on points/mileage length mismatch', () => {
    expect(() => buildCameraPath([point(0, 0)], [0, 10])).toThrow()
  })

  it('computes totalMileage as the last mileage entry', () => {
    const path = buildCameraPath([point(0, 0), point(0, 1), point(0, 2)], [0, 100, 250])
    expect(path.totalMileage).toBe(250)
  })

  it('empty path has totalMileage 0', () => {
    const path = buildCameraPath([], [])
    expect(path.totalMileage).toBe(0)
  })

  it('single-point path has totalMileage 0', () => {
    const path = buildCameraPath([point(1, 2)], [0])
    expect(path.totalMileage).toBe(0)
  })
})

describe('sampleAtMileage: interpolation', () => {
  const path = buildCameraPath(
    [point(0, 0, 0), point(0, 1, 100), point(0, 2, 200)],
    [0, 1000, 2000],
  )

  it('lands exactly on a vertex at an exact mileage parameter', () => {
    const s = sampleAtMileage(path, 1000)
    expect(s.position.lon).toBeCloseTo(0)
    expect(s.position.lat).toBeCloseTo(1)
    expect(s.position.height).toBeCloseTo(100)
    expect(s.t).toBeCloseTo(0)
    expect(s.renderIndex).toBe(1)
  })

  it('lands exactly on the first vertex at mileage 0', () => {
    const s = sampleAtMileage(path, 0)
    expect(s.position.lat).toBeCloseTo(0)
    expect(s.renderIndex).toBe(0)
    expect(s.t).toBeCloseTo(0)
  })

  it('interpolates between bracketing vertices at a mid-segment mileage', () => {
    const s = sampleAtMileage(path, 500)
    expect(s.position.lat).toBeCloseTo(0.5)
    expect(s.position.height).toBeCloseTo(50)
    expect(s.renderIndex).toBe(0)
    expect(s.t).toBeCloseTo(0.5)
  })

  it('interpolates in the second segment too', () => {
    const s = sampleAtMileage(path, 1500)
    expect(s.position.lat).toBeCloseTo(1.5)
    expect(s.position.height).toBeCloseTo(150)
    expect(s.renderIndex).toBe(1)
    expect(s.t).toBeCloseTo(0.5)
  })

  it('mileage beyond the end clamps to the last point', () => {
    const s = sampleAtMileage(path, 999999)
    expect(s.position.lat).toBeCloseTo(2)
  })

  it('negative mileage clamps to the first point', () => {
    const s = sampleAtMileage(path, -500)
    expect(s.position.lat).toBeCloseTo(0)
  })

  it('single-point path returns that point, heading 0, without dividing by zero', () => {
    const single = buildCameraPath([point(5, 6, 7)], [0])
    const s = sampleAtMileage(single, 0)
    expect(s.position).toEqual({ lon: 5, lat: 6, height: 7 })
    expect(s.headingDeg).toBe(0)
    expect(s.t).toBe(0)
    expect(Number.isFinite(s.t)).toBe(true)
  })

  it('empty path does not throw and does not divide by zero', () => {
    const empty = buildCameraPath([], [])
    expect(() => sampleAtMileage(empty, 0)).not.toThrow()
    const s = sampleAtMileage(empty, 0)
    expect(s.renderIndex).toBe(-1)
    expect(Number.isFinite(s.t)).toBe(true)
  })

  it('a zero-length track (coincident points, all-zero mileage) does not divide by zero', () => {
    const zeroLength = buildCameraPath([point(1, 1), point(1, 1), point(1, 1)], [0, 0, 0])
    expect(() => sampleAtMileage(zeroLength, 0)).not.toThrow()
    const s = sampleAtMileage(zeroLength, 0)
    expect(Number.isFinite(s.t)).toBe(true)
    expect(Number.isFinite(s.position.lon)).toBe(true)
  })
})

describe('progress <-> mileage clamping', () => {
  const path = buildCameraPath([point(0, 0), point(0, 1)], [0, 1000])

  it('clampProgress clamps below 0 and above 1', () => {
    expect(clampProgress(-1)).toBe(0)
    expect(clampProgress(2)).toBe(1)
    expect(clampProgress(0.5)).toBe(0.5)
    expect(clampProgress(NaN)).toBe(0)
  })

  it('clampMileage clamps to [0, total]', () => {
    expect(clampMileage(-10, 1000)).toBe(0)
    expect(clampMileage(5000, 1000)).toBe(1000)
    expect(clampMileage(500, 1000)).toBe(500)
  })

  it('progressToMileage clamps at both ends', () => {
    expect(progressToMileage(path, -1)).toBe(0)
    expect(progressToMileage(path, 2)).toBe(1000)
    expect(progressToMileage(path, 0.5)).toBeCloseTo(500)
  })

  it('mileageToProgress clamps at both ends', () => {
    expect(mileageToProgress(path, -100)).toBe(0)
    expect(mileageToProgress(path, 100000)).toBe(1)
    expect(mileageToProgress(path, 250)).toBeCloseTo(0.25)
  })

  it('mileageToProgress on a zero-length path always reports 0, never NaN', () => {
    const zero = buildCameraPath([point(0, 0)], [0])
    expect(mileageToProgress(zero, 0)).toBe(0)
    expect(mileageToProgress(zero, 500)).toBe(0)
  })

  it('monotonic progress produces monotonic mileage', () => {
    const progresses = [0, 0.1, 0.25, 0.4, 0.6, 0.75, 0.9, 1]
    const mileages = progresses.map((p) => progressToMileage(path, p))
    for (let i = 1; i < mileages.length; i++) {
      expect(mileages[i]).toBeGreaterThanOrEqual(mileages[i - 1])
    }
  })
})

describe('bearingDegrees', () => {
  it('due north is 0 degrees', () => {
    expect(bearingDegrees(point(0, 0), point(0, 1))).toBeCloseTo(0, 4)
  })

  it('due east is 90 degrees', () => {
    expect(bearingDegrees(point(0, 0), point(1, 0))).toBeCloseTo(90, 4)
  })

  it('due south is 180 degrees', () => {
    expect(bearingDegrees(point(0, 1), point(0, 0))).toBeCloseTo(180, 4)
  })

  it('due west is 270 degrees', () => {
    expect(bearingDegrees(point(1, 0), point(0, 0))).toBeCloseTo(270, 4)
  })

  it('wraps correctly across the antimeridian (eastward, short way)', () => {
    const b = bearingDegrees(point(179, 0), point(-179, 0))
    expect(b).toBeCloseTo(90, 3)
  })

  it('wraps correctly across the antimeridian going the other direction', () => {
    const b = bearingDegrees(point(-179, 0), point(179, 0))
    expect(b).toBeCloseTo(270, 3)
  })

  it('always returns a value in [0, 360)', () => {
    const b1 = bearingDegrees(point(10, 10), point(-170, -10))
    expect(b1).toBeGreaterThanOrEqual(0)
    expect(b1).toBeLessThan(360)
  })
})

describe('followCameraOffset', () => {
  it('places the camera south of the point when heading is due north (behind, not ahead)', () => {
    const pose = followCameraOffset(point(0, 0, 0), 0, DEFAULT_FOLLOW_CAMERA_CONFIG)
    expect(pose.position.lat).toBeLessThan(0)
    expect(pose.position.lon).toBeCloseTo(0, 6)
  })

  it('places the camera west of the point when heading is due east (behind, not ahead)', () => {
    const pose = followCameraOffset(point(0, 0, 0), 90, DEFAULT_FOLLOW_CAMERA_CONFIG)
    expect(pose.position.lon).toBeLessThan(0)
    expect(pose.position.lat).toBeCloseTo(0, 6)
  })

  it('places the camera north of the point when heading is due south (behind, not ahead)', () => {
    const pose = followCameraOffset(point(0, 0, 0), 180, DEFAULT_FOLLOW_CAMERA_CONFIG)
    expect(pose.position.lat).toBeGreaterThan(0)
  })

  it('places the camera east of the point when heading is due west (behind, not ahead)', () => {
    const pose = followCameraOffset(point(0, 0, 0), 270, DEFAULT_FOLLOW_CAMERA_CONFIG)
    expect(pose.position.lon).toBeGreaterThan(0)
  })

  it('always places the camera above the point', () => {
    const pose = followCameraOffset(point(10, 20, 300), 45, DEFAULT_FOLLOW_CAMERA_CONFIG)
    expect(pose.position.height).toBeGreaterThan(300)
    expect(pose.position.height).toBeCloseTo(300 + DEFAULT_FOLLOW_CAMERA_CONFIG.heightAboveM)
  })

  it('carries the configured pitch through to the orientation, unaffected by position', () => {
    const config = { distanceBehindM: 50, heightAboveM: 20, pitchDeg: -33 }
    const pose = followCameraOffset(point(0, 0, 0), 12, config)
    expect(pose.pitchDeg).toBe(-33)
  })

  it('normalizes the reported heading into [0, 360)', () => {
    const pose = followCameraOffset(point(0, 0, 0), 370, DEFAULT_FOLLOW_CAMERA_CONFIG)
    expect(pose.headingDeg).toBeCloseTo(10, 4)
  })
})

describe('speed handling', () => {
  it('scales linearly with multiplier', () => {
    const base = speedToMileageDelta(1, 1, 2.5)
    const fast = speedToMileageDelta(10, 1, 2.5)
    expect(fast).toBeCloseTo(base * 10)
  })

  it('scales linearly with elapsed real time', () => {
    const d1 = speedToMileageDelta(5, 1, 2.5)
    const d2 = speedToMileageDelta(5, 2, 2.5)
    expect(d2).toBeCloseTo(d1 * 2)
  })

  it('never goes negative for non-negative inputs', () => {
    expect(speedToMileageDelta(1, 0, 2.5)).toBeGreaterThanOrEqual(0)
    expect(speedToMileageDelta(0, 1, 2.5)).toBeGreaterThanOrEqual(0)
  })

  it('accumulating positive deltas over increasing elapsed time is monotonic', () => {
    let mileage = 0
    const deltas = [0.1, 0.2, 0.3, 0.4].map((dt) => speedToMileageDelta(5, dt, 2.5))
    const trail = [mileage]
    for (const d of deltas) {
      mileage += d
      trail.push(mileage)
    }
    for (let i = 1; i < trail.length; i++) expect(trail[i]).toBeGreaterThan(trail[i - 1])
  })

  it('averageSpeedMps derives pace from total distance / duration', () => {
    expect(averageSpeedMps(1000, 500, 2.5)).toBeCloseTo(2)
  })

  it('averageSpeedMps falls back for non-positive duration instead of returning 0/Infinity', () => {
    expect(averageSpeedMps(1000, 0, 2.5)).toBe(2.5)
    expect(averageSpeedMps(1000, -5, 2.5)).toBe(2.5)
  })
})

describe('fullPrecisionIndex', () => {
  const idx = Uint32Array.from([0, 10, 20, 100, 1000])

  it('returns the exact full-precision index at t=0', () => {
    expect(fullPrecisionIndex(idx, 2, 0)).toBe(20)
  })

  it('returns the next full-precision index at t=1', () => {
    expect(fullPrecisionIndex(idx, 2, 1)).toBe(100)
  })

  it('interpolates proportionally between the two', () => {
    expect(fullPrecisionIndex(idx, 2, 0.5)).toBe(60)
  })

  it('clamps renderIndex within bounds instead of throwing', () => {
    expect(() => fullPrecisionIndex(idx, -5, 0)).not.toThrow()
    expect(() => fullPrecisionIndex(idx, 999, 0)).not.toThrow()
    expect(fullPrecisionIndex(idx, 999, 0)).toBe(1000)
  })

  it('handles an empty idx map without throwing', () => {
    expect(fullPrecisionIndex(new Uint32Array(0), 0, 0.5)).toBe(0)
  })
})
