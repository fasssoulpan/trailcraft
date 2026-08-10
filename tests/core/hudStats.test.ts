import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import { getHudTrackStats, computeHudReadout, formatHudStats, type HudReadout } from '../../src/ui/hudStats'
import { buildProfileData } from '../../src/profile/profileRender'
import { computeGainLoss, smoothElevation } from '../../src/core/stats/elevation'

function makeTrack(opts: { n?: number; ele?: number[]; hr?: number[]; noEle?: boolean } = {}): Track {
  const n = opts.n ?? 10
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.001)
  const lat = Array.from({ length: n }, () => 39)
  const ele = opts.noEle ? undefined : (opts.ele ?? Array.from({ length: n }, (_, i) => 100 + i * 10))
  const hr = opts.hr
  const t = createTrack({ lon, lat, ele, hr }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

describe('getHudTrackStats', () => {
  it('caches per track+statsOptions: same object returned on a second call with the same options', () => {
    const t = makeTrack()
    const a = getHudTrackStats(t, { threshold: 5, smoothWindow: 5 })
    const b = getHudTrackStats(t, { threshold: 5, smoothWindow: 5 })
    expect(a).toBe(b)
  })

  it('rebuilds when statsOptions change even though the track did not', () => {
    const t = makeTrack()
    const a = getHudTrackStats(t, { threshold: 5, smoothWindow: 5 })
    const b = getHudTrackStats(t, { threshold: 8, smoothWindow: 5 })
    expect(a).not.toBe(b)
    expect(Array.from(a.gain)).not.toEqual(Array.from(b.gain))
  })

  it("gain prefix's last element matches computeGainLoss for the same threshold/smoothWindow", () => {
    const t = makeTrack({ ele: [100, 130, 90, 160, 70, 200, 50, 40, 300, 310] })
    const opts = { threshold: 5, smoothWindow: 3 }
    const stats = getHudTrackStats(t, opts)
    const smoothed = smoothElevation(t.points.ele!, opts.smoothWindow)
    const expected = computeGainLoss(smoothed, opts.threshold)
    expect(stats.gain[stats.gain.length - 1]).toBeCloseTo(expected.gain, 5)
  })

  it('a track with no elevation column produces empty gain/loss and no profile, without throwing', () => {
    const t = makeTrack({ noEle: true })
    expect(() => getHudTrackStats(t, { threshold: 5, smoothWindow: 5 })).not.toThrow()
    const stats = getHudTrackStats(t, { threshold: 5, smoothWindow: 5 })
    expect(stats.gain.length).toBe(0)
    expect(stats.loss.length).toBe(0)
    expect(stats.profile).toBeUndefined()
  })
})

describe('computeHudReadout', () => {
  it('reports mileage, elevation, ascent and gradient consistent with the source track', () => {
    const t = makeTrack({ ele: [100, 110, 120, 130, 140, 150, 160, 170, 180, 190] })
    const stats = getHudTrackStats(t, { threshold: 5, smoothWindow: 1 })
    const readout = computeHudReadout(t, stats, 5)
    expect(readout.mileageKm).toBeCloseTo(t.points.cumDist![5] / 1000, 6)
    expect(readout.elevationM).toBeCloseTo(150, 5)
    expect(readout.ascentM).toBeCloseTo(stats.gain[5], 6)
    expect(readout.gradientPct).toBeGreaterThan(0) // steady climb -> positive gradient
  })

  it('gradient reading agrees exactly with the profile chart at the same full-precision index', () => {
    const t = makeTrack({ n: 50, ele: Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 3) * 40) })
    const stats = getHudTrackStats(t, { threshold: 5, smoothWindow: 1 })
    const profile = buildProfileData(t)!
    // ProfileCanvas.tsx builds its chart data via the exact same
    // buildProfileData(track) call (same MAX_PROFILE_POINTS default) --
    // asserting the two decimated arrays are equal is what guarantees the
    // HUD's gradientAt/nearestSamplePos lookup lands on the same numbers
    // the chart's hover readout would show at this track position.
    expect(stats.profile!.dist).toEqual(profile.dist)
    expect(stats.profile!.ele).toEqual(profile.ele)
    expect(stats.profile!.idx).toEqual(profile.idx)
  })

  it('elevation/ascent/gradient are undefined for a track with no elevation column', () => {
    const t = makeTrack({ noEle: true })
    const stats = getHudTrackStats(t, { threshold: 5, smoothWindow: 5 })
    const readout = computeHudReadout(t, stats, 3)
    expect(readout.elevationM).toBeUndefined()
    expect(readout.ascentM).toBeUndefined()
    expect(readout.gradientPct).toBeUndefined()
    expect(readout.mileageKm).toBeGreaterThanOrEqual(0)
  })

  it('heart rate is undefined when the hr column is absent', () => {
    const t = makeTrack()
    const stats = getHudTrackStats(t, { threshold: 5, smoothWindow: 5 })
    expect(computeHudReadout(t, stats, 0).heartRateBpm).toBeUndefined()
  })

  it('heart rate 0 (the "no reading" sentinel) reports undefined, not 0 bpm', () => {
    const t = makeTrack({ hr: [0, 0, 140, 0, 150, 0, 0, 0, 0, 0] })
    const stats = getHudTrackStats(t, { threshold: 5, smoothWindow: 5 })
    expect(computeHudReadout(t, stats, 0).heartRateBpm).toBeUndefined()
    expect(computeHudReadout(t, stats, 2).heartRateBpm).toBe(140)
    expect(computeHudReadout(t, stats, 4).heartRateBpm).toBe(150)
  })

  it('an out-of-range point index is clamped, not thrown', () => {
    const t = makeTrack()
    const stats = getHudTrackStats(t, { threshold: 5, smoothWindow: 5 })
    expect(() => computeHudReadout(t, stats, -5)).not.toThrow()
    expect(() => computeHudReadout(t, stats, 9999)).not.toThrow()
    expect(computeHudReadout(t, stats, -5).mileageKm).toBeCloseTo(computeHudReadout(t, stats, 0).mileageKm, 6)
  })
})

// formatHudStats is the shared text-formatting layer both HudOverlay.tsx
// (DOM) and cesium/recorder.ts's video compositor (canvas, milestone N5)
// read from -- see that function's own doc comment for why this must stay
// the one place mileage/elevation/ascent/gradient/heart-rate get formatted
// into strings.
describe('formatHudStats', () => {
  const FULL_READOUT: HudReadout = {
    mileageKm: 3.47,
    elevationM: 274,
    ascentM: 245,
    gradientPct: 1.5,
    heartRateBpm: 140,
  }

  it('formats mileage to two decimal places with a km unit', () => {
    const entries = formatHudStats(FULL_READOUT, true)
    const mileage = entries.find((e) => e.key === 'mileage')!
    expect(mileage.value).toBe('3.47')
    expect(mileage.unit).toBe('km')
    expect(mileage.label).toBe('里程')
  })

  it('rounds elevation and ascent to the nearest metre', () => {
    const entries = formatHudStats({ ...FULL_READOUT, elevationM: 274.6, ascentM: 244.5 }, true)
    expect(entries.find((e) => e.key === 'ele')!.value).toBe('275')
    expect(entries.find((e) => e.key === 'ascent')!.value).toBe('245')
  })

  it('formats gradient with an explicit + sign for climbs and no sign for descents', () => {
    const climb = formatHudStats({ ...FULL_READOUT, gradientPct: 7.95 }, true)
    expect(climb.find((e) => e.key === 'gradient')!.value).toBe('+8.0%')
    const descent = formatHudStats({ ...FULL_READOUT, gradientPct: -7.59 }, true)
    expect(descent.find((e) => e.key === 'gradient')!.value).toBe('-7.6%')
  })

  it('shows the "--" placeholder for undefined elevation/ascent/gradient, not "undefined" or NaN', () => {
    const entries = formatHudStats(
      { mileageKm: 1, elevationM: undefined, ascentM: undefined, gradientPct: undefined, heartRateBpm: undefined },
      false,
    )
    expect(entries.find((e) => e.key === 'ele')!.value).toBe('--')
    expect(entries.find((e) => e.key === 'ascent')!.value).toBe('--')
    expect(entries.find((e) => e.key === 'gradient')!.value).toBe('--')
  })

  it('omits the heart-rate entry entirely when hasHr is false, even if heartRateBpm is set', () => {
    const entries = formatHudStats(FULL_READOUT, false)
    expect(entries.some((e) => e.key === 'hr')).toBe(false)
  })

  it('includes a heart-rate entry (placeholder if undefined) when hasHr is true', () => {
    const withReading = formatHudStats(FULL_READOUT, true)
    expect(withReading.find((e) => e.key === 'hr')!.value).toBe('140')
    const withoutReading = formatHudStats({ ...FULL_READOUT, heartRateBpm: undefined }, true)
    expect(withoutReading.find((e) => e.key === 'hr')!.value).toBe('--')
  })

  it('returns entries in a stable key order: mileage, ele, ascent, gradient[, hr]', () => {
    const entries = formatHudStats(FULL_READOUT, true)
    expect(entries.map((e) => e.key)).toEqual(['mileage', 'ele', 'ascent', 'gradient', 'hr'])
  })
})
