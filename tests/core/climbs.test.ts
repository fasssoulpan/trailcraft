import { describe, it, expect } from 'vitest'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import { computeGradeSegments } from '../../src/core/perf/climbs'

function track(opts: { n: number; ele?: number[]; time?: number[]; hr?: number[]; step?: number }): Track {
  const step = opts.step ?? 0.0001 // ~11m/point at lat 39
  const lon = Array.from({ length: opts.n }, (_, i) => 116 + i * step)
  const lat = Array.from({ length: opts.n }, () => 39)
  const t = createTrack(
    { lon, lat, ele: opts.ele, time: opts.time, hr: opts.hr },
    { name: 'x', format: 'gpx', fileName: 'x.gpx' },
  )
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

describe('computeGradeSegments', () => {
  it('returns [] when the track has no elevation column', () => {
    const t = track({ n: 100 })
    expect(computeGradeSegments(t)).toEqual([])
  })

  it('returns [] for a track shorter than MIN_SEGMENT_POINTS*2', () => {
    const t = track({ n: 15, ele: Array.from({ length: 15 }, (_, i) => 100 + i * 10) })
    expect(computeGradeSegments(t)).toEqual([])
  })

  it('detects two uphill climbs separated by a descent on a synthetic profile', () => {
    // 20 pts steep climb, 20 pts steep descent, 20 pts steep climb, 20 pts flat tail.
    const climb = (i: number) => 10 * i
    const ele: number[] = []
    for (let i = 0; i < 20; i++) ele.push(100 + climb(i)) // uphill #1: 100 -> 290
    const peak1 = ele[ele.length - 1]
    for (let i = 0; i < 20; i++) ele.push(peak1 - climb(i)) // downhill: 290 -> 100
    const valley = ele[ele.length - 1]
    for (let i = 0; i < 20; i++) ele.push(valley + climb(i)) // uphill #2: 100 -> 290
    const peak2 = ele[ele.length - 1]
    for (let i = 0; i < 20; i++) ele.push(peak2) // flat tail

    const t = track({ n: 80, ele })
    const segments = computeGradeSegments(t)

    const uphills = segments.filter((s) => s.type === 'uphill')
    const downhills = segments.filter((s) => s.type === 'downhill')
    expect(uphills.length).toBeGreaterThanOrEqual(2)
    expect(downhills.length).toBeGreaterThanOrEqual(1)

    // Ordering: first uphill ends before the downhill starts, which ends
    // before the second uphill starts.
    const firstUphill = uphills[0]
    const downhill = downhills[0]
    const secondUphill = uphills[1]
    expect(firstUphill.endDist).toBeLessThanOrEqual(downhill.startDist)
    expect(downhill.endDist).toBeLessThanOrEqual(secondUphill.startDist)

    // Uphill segments show positive average grade, downhill negative.
    expect(firstUphill.avgGrade).toBeGreaterThan(5)
    expect(downhill.avgGrade).toBeLessThan(-5)
    expect(secondUphill.avgGrade).toBeGreaterThan(5)

    // Each segment reports non-trivial ascent/descent consistent with its type.
    expect(firstUphill.ascent).toBeGreaterThan(0)
    expect(downhill.descent).toBeGreaterThan(0)
  })

  it('a flat, low-grade track yields a single flat segment covering the whole track', () => {
    const n = 40
    const ele = Array.from({ length: n }, () => 100) // dead flat
    const t = track({ n, ele })
    const segments = computeGradeSegments(t)
    expect(segments.length).toBe(1)
    expect(segments[0].type).toBe('flat')
    expect(segments[0].avgGrade).toBeCloseTo(0, 5)
  })

  it('reports segment time/avgPace as undefined when the track has no time column', () => {
    const n = 40
    const ele = Array.from({ length: n }, () => 100)
    const t = track({ n, ele })
    const segments = computeGradeSegments(t)
    expect(segments[0].time).toBeUndefined()
    expect(segments[0].avgPace).toBeUndefined()
  })

  it('reports segment time/avgPace when the track has a time column', () => {
    const n = 40
    const ele = Array.from({ length: n }, () => 100)
    const time = Array.from({ length: n }, (_, i) => i * 5000)
    const t = track({ n, ele, time })
    const segments = computeGradeSegments(t)
    expect(segments[0].time).toBeGreaterThan(0)
    expect(segments[0].avgPace).toBeGreaterThan(0)
  })

  it('averages heart rate over readings only, ignoring the 0 "no reading" sentinel', () => {
    const n = 40
    const ele = Array.from({ length: n }, () => 100)
    const hr = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 140 : 0))
    const t = track({ n, ele, hr })
    const segments = computeGradeSegments(t)
    expect(segments[0].avgHR).toBe(140)
  })

  it('avgHR is undefined when the track has no hr column', () => {
    const n = 40
    const ele = Array.from({ length: n }, () => 100)
    const t = track({ n, ele })
    const segments = computeGradeSegments(t)
    expect(segments[0].avgHR).toBeUndefined()
  })

  // P2 Q2 commit 1: per-segment ascent/descent switched from the reference's
  // own raw diff-sum to a prefix difference over P0's threshold-hysteresis
  // running totals (core/stats/runningStats.ts#buildRunningGain/
  // buildRunningLoss), honouring the same statsOptions as the whole-track
  // ascent feeding the score. See climbs.ts's header comment for the full
  // rationale and the path-dependence subtlety.
  it('per-segment ascent/descent sum to the whole-track total from core/stats/elevation.ts#computeGainLoss (prefix-difference additivity)', async () => {
    const { smoothElevation, computeGainLoss } = await import('../../src/core/stats/elevation')
    // Same fixture as the "detects two uphill climbs" test above: every run
    // is 20 points, well above MIN_SEGMENT_POINTS(10), so no segment gets
    // dropped for being too short and the returned segments cover the whole
    // track with no gaps -- required for an exact sum-to-total comparison (a
    // track with short, dropped transitional segments would legitimately NOT
    // sum to the total, since those points contribute to neither segment).
    const climb = (i: number) => 10 * i
    const ele: number[] = []
    for (let i = 0; i < 20; i++) ele.push(100 + climb(i))
    const peak1 = ele[ele.length - 1]
    for (let i = 0; i < 20; i++) ele.push(peak1 - climb(i))
    const valley = ele[ele.length - 1]
    for (let i = 0; i < 20; i++) ele.push(valley + climb(i))
    const peak2 = ele[ele.length - 1]
    for (let i = 0; i < 20; i++) ele.push(peak2)

    const t = track({ n: 80, ele })
    const segments = computeGradeSegments(t)

    const totalAscent = segments.reduce((s, g) => s + g.ascent, 0)
    const totalDescent = segments.reduce((s, g) => s + g.descent, 0)

    const smoothed = smoothElevation(Float32Array.from(ele), 5)
    const expected = computeGainLoss(smoothed, 5)

    // Per-segment rounding (Math.round in buildSegment) means the sum of 4
    // segments can differ from the unrounded whole-track total by a few
    // metres, not exactly zero.
    expect(totalAscent).toBeCloseTo(expected.gain, -1)
    expect(totalDescent).toBeCloseTo(expected.loss, -1)
  })

  it('honours statsOptions threshold: a looser threshold accumulates at least as much ascent as a stricter one', () => {
    const n = 60
    // Noisy-but-climbing profile: +6/-3 alternating on top of a steady climb,
    // so different thresholds plausibly disagree on how much of the jitter
    // counts.
    const ele = Array.from({ length: n }, (_, i) => 100 + i * 2 + (i % 2 === 0 ? 6 : -3))
    const t = track({ n, ele })

    const loose = computeGradeSegments(t, undefined, { threshold: 2, smoothWindow: 1 })
    const strict = computeGradeSegments(t, undefined, { threshold: 20, smoothWindow: 1 })

    const looseAscent = loose.reduce((s, g) => s + g.ascent, 0)
    const strictAscent = strict.reduce((s, g) => s + g.ascent, 0)
    expect(looseAscent).toBeGreaterThan(strictAscent)
  })
})
