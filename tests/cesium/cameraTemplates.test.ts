import { describe, it, expect } from 'vitest'
import {
  CAMERA_TEMPLATES,
  getCameraTemplate,
  isValidTemplateRange,
  applyCameraTemplate,
  materializeTemplate,
  rangeFromMileages,
  rangeFromClimb,
  type CameraTemplateContext,
} from '../../src/cesium/cameraTemplates'
import { sampleCameraAt, type CameraKeyframe, type CameraTrack } from '../../src/cesium/keyframes'

function idFactory(prefix = 'kf') {
  let n = 0
  return () => `${prefix}_${n++}`
}

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

describe('the required template roster', () => {
  it('ships at least the 4 templates 方案 V2.1 §5.5 names', () => {
    expect(CAMERA_TEMPLATES.length).toBeGreaterThanOrEqual(4)
    const ids = CAMERA_TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length) // no duplicate ids
    for (const required of ['gods-eye-opening', 'fast-flyover', 'climb-slowdown', 'finish-orbit']) {
      expect(ids).toContain(required)
    }
  })

  it('getCameraTemplate finds a known id and reports undefined for an unknown one', () => {
    expect(getCameraTemplate('fast-flyover')?.label).toBe('全程快速掠过')
    expect(getCameraTemplate('does-not-exist')).toBeUndefined()
  })
})

describe('every template produces keyframes within its requested range', () => {
  for (const template of CAMERA_TEMPLATES) {
    it(`${template.id}: all generated mileages fall within [start, end]`, () => {
      const ctx: CameraTemplateContext = { startMileageM: 10_000, endMileageM: 15_000, totalMileageM: 100_000 }
      const specs = template.build(ctx)
      expect(specs.length).toBeGreaterThan(0)
      for (const spec of specs) {
        expect(spec.mileageM).toBeGreaterThanOrEqual(ctx.startMileageM)
        expect(spec.mileageM).toBeLessThanOrEqual(ctx.endMileageM)
      }
    })
  }

  it('a template applied near the very end of the route still stays in-range (finish-orbit)', () => {
    const ctx: CameraTemplateContext = { startMileageM: 98_000, endMileageM: 100_000, totalMileageM: 100_000 }
    const template = getCameraTemplate('finish-orbit')!
    const specs = template.build(ctx)
    for (const spec of specs) {
      expect(spec.mileageM).toBeGreaterThanOrEqual(ctx.startMileageM)
      expect(spec.mileageM).toBeLessThanOrEqual(ctx.endMileageM)
    }
  })
})

describe('materializeTemplate', () => {
  it('assigns ids via the injected factory and fills unspecified config from DEFAULT_CAMERA_CONFIG', () => {
    const ctx: CameraTemplateContext = { startMileageM: 0, endMileageM: 1000, totalMileageM: 10_000 }
    const template = getCameraTemplate('fast-flyover')!
    const kfs = materializeTemplate(template, ctx, idFactory())
    expect(kfs.map((k) => k.id)).toEqual(['kf_0', 'kf_1'])
    for (const k of kfs) {
      expect(typeof k.fovDeg).toBe('number')
      expect(typeof k.speedMultiplier).toBe('number')
    }
  })
})

describe('applyCameraTemplate: sub-range application', () => {
  it("applying to a sub-range doesn't disturb keyframes elsewhere", () => {
    const untouchedEarly = kf('early', 500)
    const untouchedLate = kf('late', 50_000)
    const track: CameraTrack = [untouchedEarly, untouchedLate]
    const template = getCameraTemplate('climb-slowdown')!
    const next = applyCameraTemplate(track, template, { startMileageM: 10_000, endMileageM: 15_000 }, 100_000, idFactory())

    expect(next.find((k) => k.id === 'early')).toBe(untouchedEarly)
    expect(next.find((k) => k.id === 'late')).toBe(untouchedLate)
    // The template's own keyframes landed strictly inside the requested range.
    const generated = next.filter((k) => k.id !== 'early' && k.id !== 'late')
    expect(generated.length).toBeGreaterThan(0)
    for (const g of generated) {
      expect(g.mileageM).toBeGreaterThanOrEqual(10_000)
      expect(g.mileageM).toBeLessThanOrEqual(15_000)
    }
  })

  it('replaces any existing keyframe that falls inside the applied range', () => {
    const staleInside = kf('stale', 12_000, { distanceBehindM: 9999 })
    const track: CameraTrack = [staleInside]
    const template = getCameraTemplate('fast-flyover')!
    const next = applyCameraTemplate(track, template, { startMileageM: 10_000, endMileageM: 15_000 }, 100_000, idFactory())
    expect(next.find((k) => k.id === 'stale')).toBeUndefined()
    expect(next.every((k) => k.distanceBehindM !== 9999)).toBe(true)
  })
})

describe('applyCameraTemplate: overlap between two applications', () => {
  it('the later application wins inside the overlap; the earlier one survives outside it', () => {
    const makeId = idFactory()
    let track: CameraTrack = []
    const templateA = getCameraTemplate('fast-flyover')! // constant config across its range
    const templateB = getCameraTemplate('climb-slowdown')! // a different, distinguishable constant config

    track = applyCameraTemplate(track, templateA, { startMileageM: 0, endMileageM: 5000 }, 20_000, makeId)
    const afterA = track
    track = applyCameraTemplate(track, templateB, { startMileageM: 3000, endMileageM: 8000 }, 20_000, makeId)

    // Outside the overlap (< 3000), A's own keyframes are untouched.
    const survivingA = track.filter((k) => afterA.some((a) => a.id === k.id))
    expect(survivingA.length).toBeGreaterThan(0)
    for (const k of survivingA) expect(k.mileageM).toBeLessThan(3000)

    // Inside the overlap [3000, 5000], only B's config is present -- sampled
    // at 4000 (deep in the overlap) it must read as B's climb-slowdown
    // profile (speedMultiplier 0.4), not A's fast-flyover profile (4).
    const sample = sampleCameraAt(track, 4000)
    expect(sample.speedMultiplier).toBeCloseTo(0.4)
  })
})

describe('applyCameraTemplate: degenerate ranges fail safe', () => {
  const track: CameraTrack = [kf('a', 1000)]
  const template = getCameraTemplate('fast-flyover')!

  it('a zero-length range is a no-op', () => {
    const next = applyCameraTemplate(track, template, { startMileageM: 5000, endMileageM: 5000 }, 20_000, idFactory())
    expect(next).toBe(track)
  })

  it('an inverted (end before start) range is a no-op', () => {
    const next = applyCameraTemplate(track, template, { startMileageM: 5000, endMileageM: 1000 }, 20_000, idFactory())
    expect(next).toBe(track)
  })

  it('a range entirely beyond the route length is a no-op', () => {
    const next = applyCameraTemplate(track, template, { startMileageM: 25_000, endMileageM: 30_000 }, 20_000, idFactory())
    expect(next).toBe(track)
  })

  it('a non-positive totalMileageM (route not loaded) is a no-op', () => {
    const next = applyCameraTemplate(track, template, { startMileageM: 0, endMileageM: 1000 }, 0, idFactory())
    expect(next).toBe(track)
  })

  it('a range partially beyond the route is clamped, not rejected', () => {
    const next = applyCameraTemplate(track, template, { startMileageM: 18_000, endMileageM: 25_000 }, 20_000, idFactory())
    expect(next).not.toBe(track)
    const generated = next.filter((k) => k.id !== 'a')
    for (const g of generated) expect(g.mileageM).toBeLessThanOrEqual(20_000)
  })

  it('isValidTemplateRange agrees with applyCameraTemplate on every rejected case above', () => {
    expect(isValidTemplateRange({ startMileageM: 5000, endMileageM: 5000 }, 20_000)).toBe(false)
    expect(isValidTemplateRange({ startMileageM: 5000, endMileageM: 1000 }, 20_000)).toBe(false)
    expect(isValidTemplateRange({ startMileageM: 25_000, endMileageM: 30_000 }, 20_000)).toBe(false)
    expect(isValidTemplateRange({ startMileageM: 0, endMileageM: 1000 }, 0)).toBe(false)
    expect(isValidTemplateRange({ startMileageM: 18_000, endMileageM: 25_000 }, 20_000)).toBe(true)
  })
})

describe('range helpers', () => {
  it('rangeFromMileages normalises either input order', () => {
    expect(rangeFromMileages(1000, 500)).toEqual({ startMileageM: 500, endMileageM: 1000 })
    expect(rangeFromMileages(500, 1000)).toEqual({ startMileageM: 500, endMileageM: 1000 })
  })

  it('rangeFromClimb reads a grade segment\'s cumulative start/end distance directly', () => {
    expect(rangeFromClimb({ startDist: 32_000, endDist: 41_000 })).toEqual({ startMileageM: 32_000, endMileageM: 41_000 })
  })
})
