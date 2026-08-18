import { describe, it, expect } from 'vitest'
import {
  sampleCameraAt,
  insertKeyframe,
  moveKeyframe,
  updateKeyframe,
  deleteKeyframe,
  DEFAULT_CAMERA_CONFIG,
  type CameraKeyframe,
  type CameraTrack,
} from '../../src/cesium/keyframes'

function kf(id: string, mileageM: number, patch: Partial<CameraKeyframe> = {}): CameraKeyframe {
  return {
    id,
    mileageM,
    distanceBehindM: 120,
    heightAboveM: 55,
    pitchDeg: -18,
    headingOffsetDeg: 0,
    fovDeg: 60,
    speedMultiplier: 1,
    ...patch,
  }
}

describe('sampleCameraAt: empty/single tracks', () => {
  it('an empty track resolves to DEFAULT_CAMERA_CONFIG at any mileage', () => {
    expect(sampleCameraAt([], 0)).toEqual(DEFAULT_CAMERA_CONFIG)
    expect(sampleCameraAt([], 5000)).toEqual(DEFAULT_CAMERA_CONFIG)
    expect(sampleCameraAt([], -100)).toEqual(DEFAULT_CAMERA_CONFIG)
  })

  it('a single-keyframe track returns that keyframe everywhere, before/at/after it', () => {
    const track: CameraTrack = [kf('a', 1000, { distanceBehindM: 300, fovDeg: 45 })]
    for (const m of [-500, 0, 999, 1000, 1001, 999999]) {
      const c = sampleCameraAt(track, m)
      expect(c.distanceBehindM).toBe(300)
      expect(c.fovDeg).toBe(45)
    }
  })
})

describe('sampleCameraAt: interpolation', () => {
  const a = kf('a', 0, { distanceBehindM: 100, heightAboveM: 20, pitchDeg: -10, fovDeg: 40, speedMultiplier: 1 })
  const b = kf('b', 1000, { distanceBehindM: 300, heightAboveM: 60, pitchDeg: -30, fovDeg: 80, speedMultiplier: 2 })
  const track: CameraTrack = [a, b]

  it('lands exactly on the config at each keyframe boundary', () => {
    expect(sampleCameraAt(track, 0)).toMatchObject({ distanceBehindM: 100, heightAboveM: 20, pitchDeg: -10, fovDeg: 40, speedMultiplier: 1 })
    expect(sampleCameraAt(track, 1000)).toMatchObject({ distanceBehindM: 300, heightAboveM: 60, pitchDeg: -30, fovDeg: 80, speedMultiplier: 2 })
  })

  it('holds the first keyframe before it, and the last keyframe after it (no extrapolation)', () => {
    expect(sampleCameraAt(track, -500)).toMatchObject({ distanceBehindM: 100 })
    expect(sampleCameraAt(track, 5000)).toMatchObject({ distanceBehindM: 300 })
  })

  it('midpoint (t=0.5) matches the simple average, since smoothstep(0.5) === 0.5', () => {
    const c = sampleCameraAt(track, 500)
    expect(c.distanceBehindM).toBeCloseTo(200)
    expect(c.heightAboveM).toBeCloseTo(40)
    expect(c.pitchDeg).toBeCloseTo(-20)
    expect(c.fovDeg).toBeCloseTo(60)
    expect(c.speedMultiplier).toBeCloseTo(1.5)
  })

  it('uses smoothstep, not linear, off the midpoint', () => {
    const c = sampleCameraAt(track, 250) // t = 0.25
    const smoothstepT = 0.25 * 0.25 * (3 - 2 * 0.25) // 0.15625
    const expected = 100 + (300 - 100) * smoothstepT
    expect(c.distanceBehindM).toBeCloseTo(expected)
    // A plain linear lerp at t=0.25 would give 150 -- must NOT match that.
    expect(c.distanceBehindM).not.toBeCloseTo(150, 1)
  })
})

describe('sampleCameraAt: heading wraps the short way, both directions', () => {
  it('350 -> 10 sweeps forward through 360/0 (short way, +20 total)', () => {
    const track: CameraTrack = [kf('a', 0, { headingOffsetDeg: 350 }), kf('b', 1000, { headingOffsetDeg: 10 })]
    // At t=0.25 (mileage 250): +20 * smoothstep(0.25) = +20*0.15625 = +3.125
    const c = sampleCameraAt(track, 250)
    expect(c.headingOffsetDeg).toBeCloseTo((350 + 3.125) % 360, 3)
    // Must never sweep the long way (would land somewhere in the 30-190
    // range at t=0.25 for a 340-degree long-way sweep); this must stay
    // close to the start value, on the short-way side of it.
    expect(c.headingOffsetDeg).toBeGreaterThan(350)
  })

  it('10 -> 350 sweeps backward through 0/360 (short way, -20 total), the opposite direction', () => {
    const track: CameraTrack = [kf('a', 0, { headingOffsetDeg: 10 }), kf('b', 1000, { headingOffsetDeg: 350 })]
    const c = sampleCameraAt(track, 250)
    const expected = ((10 - 20 * 0.15625) % 360 + 360) % 360 // ~7.8125, i.e. just under 10, not sweeping up toward 180
    expect(c.headingOffsetDeg).toBeCloseTo(expected, 3)
    expect(c.headingOffsetDeg).toBeLessThan(10)
  })

  it('both directions agree exactly at the midpoint (350<->10 and 10<->350 meet at 0)', () => {
    const forward: CameraTrack = [kf('a', 0, { headingOffsetDeg: 350 }), kf('b', 1000, { headingOffsetDeg: 10 })]
    const backward: CameraTrack = [kf('a', 0, { headingOffsetDeg: 10 }), kf('b', 1000, { headingOffsetDeg: 350 })]
    expect(sampleCameraAt(forward, 500).headingOffsetDeg).toBeCloseTo(0, 3)
    expect(sampleCameraAt(backward, 500).headingOffsetDeg).toBeCloseTo(0, 3)
  })
})

describe('sampleCameraAt: out-of-order keyframes', () => {
  it('is sampled correctly regardless of the input array order', () => {
    const inOrder: CameraTrack = [kf('a', 0, { distanceBehindM: 100 }), kf('b', 1000, { distanceBehindM: 300 })]
    const reversed: CameraTrack = [kf('b', 1000, { distanceBehindM: 300 }), kf('a', 0, { distanceBehindM: 100 })]
    expect(sampleCameraAt(reversed, 500).distanceBehindM).toBeCloseTo(sampleCameraAt(inOrder, 500).distanceBehindM)
  })

  it('a three-keyframe track given in scrambled order still brackets correctly', () => {
    const scrambled: CameraTrack = [
      kf('mid', 500, { distanceBehindM: 999 }),
      kf('end', 1000, { distanceBehindM: 300 }),
      kf('start', 0, { distanceBehindM: 100 }),
    ]
    expect(sampleCameraAt(scrambled, 0).distanceBehindM).toBe(100)
    expect(sampleCameraAt(scrambled, 500).distanceBehindM).toBe(999)
    expect(sampleCameraAt(scrambled, 1000).distanceBehindM).toBe(300)
  })
})

describe('sampleCameraAt: two keyframes at the same mileage (ties)', () => {
  it('the later keyframe (in original array order) wins at that exact mileage', () => {
    const track: CameraTrack = [kf('first', 500, { distanceBehindM: 111 }), kf('second', 500, { distanceBehindM: 222 })]
    expect(sampleCameraAt(track, 500).distanceBehindM).toBe(222)
  })

  it('a tie in the middle of a longer track still resolves to the later one, and brackets correctly on both sides', () => {
    const track: CameraTrack = [
      kf('start', 0, { distanceBehindM: 0 }),
      kf('tie1', 500, { distanceBehindM: 100 }),
      kf('tie2', 500, { distanceBehindM: 900 }),
      kf('end', 1000, { distanceBehindM: 1000 }),
    ]
    expect(sampleCameraAt(track, 500).distanceBehindM).toBe(900)
    // Approaching 500 from below interpolates toward the winning tie value.
    const near = sampleCameraAt(track, 499.999).distanceBehindM
    expect(near).toBeGreaterThan(0)
    expect(near).toBeLessThan(900)
  })
})

describe('editing helpers: purity (never mutate the input)', () => {
  const track: CameraTrack = [kf('a', 0), kf('b', 1000)]
  const snapshotBefore = JSON.parse(JSON.stringify(track))

  it('insertKeyframe does not mutate its input', () => {
    const next = insertKeyframe(track, kf('c', 500))
    expect(track).toEqual(snapshotBefore)
    expect(next).not.toBe(track)
    expect(next.length).toBe(3)
  })

  it('moveKeyframe does not mutate its input', () => {
    const next = moveKeyframe(track, 'a', 750)
    expect(track).toEqual(snapshotBefore)
    expect(next).not.toBe(track)
    expect(next.find((k) => k.id === 'a')?.mileageM).toBe(750)
  })

  it('updateKeyframe does not mutate its input', () => {
    const next = updateKeyframe(track, 'a', { fovDeg: 90 })
    expect(track).toEqual(snapshotBefore)
    expect(next).not.toBe(track)
    expect(next.find((k) => k.id === 'a')?.fovDeg).toBe(90)
    expect(track.find((k) => k.id === 'a')?.fovDeg).not.toBe(90)
  })

  it('deleteKeyframe does not mutate its input', () => {
    const next = deleteKeyframe(track, 'a')
    expect(track).toEqual(snapshotBefore)
    expect(next).not.toBe(track)
    expect(next.length).toBe(1)
    expect(next.find((k) => k.id === 'a')).toBeUndefined()
  })
})

describe('editing helpers: keep the list sorted by mileage', () => {
  it('insertKeyframe re-sorts even when inserted before existing keyframes', () => {
    const track: CameraTrack = [kf('b', 1000), kf('c', 2000)]
    const next = insertKeyframe(track, kf('a', 100))
    expect(next.map((k) => k.id)).toEqual(['a', 'b', 'c'])
  })

  it('moveKeyframe re-sorts when a move crosses another keyframe', () => {
    const track: CameraTrack = [kf('a', 0), kf('b', 1000), kf('c', 2000)]
    const next = moveKeyframe(track, 'a', 1500)
    expect(next.map((k) => k.id)).toEqual(['b', 'a', 'c'])
  })

  it('moveKeyframe clamps a negative target mileage to 0 rather than producing a negative mileage', () => {
    const track: CameraTrack = [kf('a', 500)]
    const next = moveKeyframe(track, 'a', -200)
    expect(next[0].mileageM).toBe(0)
  })

  it('updateKeyframe never changes mileageM, even if the patch object is empty', () => {
    const track: CameraTrack = [kf('a', 500)]
    const next = updateKeyframe(track, 'a', {})
    expect(next[0].mileageM).toBe(500)
  })
})

describe('editing helpers: unknown id is a no-op', () => {
  const track: CameraTrack = [kf('a', 0), kf('b', 1000)]

  it('moveKeyframe with an unknown id leaves every keyframe unchanged', () => {
    const next = moveKeyframe(track, 'nope', 500)
    expect(next.map((k) => ({ id: k.id, mileageM: k.mileageM }))).toEqual([
      { id: 'a', mileageM: 0 },
      { id: 'b', mileageM: 1000 },
    ])
  })

  it('updateKeyframe with an unknown id leaves every keyframe unchanged', () => {
    const next = updateKeyframe(track, 'nope', { fovDeg: 10 })
    expect(next).toEqual(track)
  })

  it('deleteKeyframe with an unknown id leaves the track the same length', () => {
    const next = deleteKeyframe(track, 'nope')
    expect(next.length).toBe(2)
  })
})
