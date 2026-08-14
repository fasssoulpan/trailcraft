import { describe, it, expect } from 'vitest'
import {
  computeTotalDurationSeconds,
  computeFrameCount,
  virtualTimeForFrame,
  mileageForFrame,
  nextExportPhase,
  isTerminalExportPhase,
  type FrameScheduleConfig,
  type RenderLoopPhase,
} from '../../src/cesium/frameSchedule'

describe('computeTotalDurationSeconds', () => {
  it('divides mileage by speed', () => {
    expect(computeTotalDurationSeconds({ totalMileageM: 1000, speedMps: 10, fps: 30 })).toBeCloseTo(100)
  })

  it('is 0 for a zero-length track', () => {
    expect(computeTotalDurationSeconds({ totalMileageM: 0, speedMps: 10, fps: 30 })).toBe(0)
  })

  it('is 0 for zero/negative speed rather than Infinity', () => {
    expect(computeTotalDurationSeconds({ totalMileageM: 1000, speedMps: 0, fps: 30 })).toBe(0)
    expect(computeTotalDurationSeconds({ totalMileageM: 1000, speedMps: -5, fps: 30 })).toBe(0)
  })
})

describe('computeFrameCount', () => {
  it('is always at least 1, even for a degenerate config', () => {
    expect(computeFrameCount({ totalMileageM: 0, speedMps: 0, fps: 30 })).toBeGreaterThanOrEqual(1)
    expect(computeFrameCount({ totalMileageM: 1000, speedMps: 10, fps: 0 })).toBeGreaterThanOrEqual(1)
  })

  it('covers the full duration at the given fps, plus one frame', () => {
    // duration = 10s, so at 30fps that's exactly 300 ticks -- +1 guarantees a
    // final frame at/after the end (see the module's own doc comment).
    const config: FrameScheduleConfig = { totalMileageM: 300, speedMps: 30, fps: 30 }
    expect(computeFrameCount(config)).toBe(301)
  })

  it('scales with fps for the same duration', () => {
    const base = { totalMileageM: 300, speedMps: 30 }
    const at30 = computeFrameCount({ ...base, fps: 30 })
    const at60 = computeFrameCount({ ...base, fps: 60 })
    expect(at60).toBeGreaterThan(at30)
    // Roughly double -- not exact because of the shared "+1" final frame.
    expect(at60).toBeCloseTo(at30 * 2, -1)
  })

  it('the last frame index always reaches the end of the track', () => {
    const config: FrameScheduleConfig = { totalMileageM: 12345, speedMps: 7, fps: 24 }
    const frameCount = computeFrameCount(config)
    const lastMileage = mileageForFrame(frameCount - 1, config)
    expect(lastMileage).toBeCloseTo(config.totalMileageM)
  })
})

describe('virtualTimeForFrame', () => {
  it('is frameIndex / fps', () => {
    expect(virtualTimeForFrame(90, 30)).toBeCloseTo(3)
    expect(virtualTimeForFrame(0, 30)).toBe(0)
  })

  it('never negative, even for a negative frame index', () => {
    expect(virtualTimeForFrame(-5, 30)).toBe(0)
  })

  it('degrades to 0 for a non-positive fps instead of Infinity/NaN', () => {
    expect(virtualTimeForFrame(10, 0)).toBe(0)
    expect(virtualTimeForFrame(10, -30)).toBe(0)
  })
})

describe('mileageForFrame: determinism', () => {
  const config: FrameScheduleConfig = { totalMileageM: 10_000, speedMps: 5, fps: 30 }

  it('frame 0 is at mileage 0', () => {
    expect(mileageForFrame(0, config)).toBe(0)
  })

  it('is a pure function of frameIndex/fps/speed -- same virtual instant, same mileage regardless of fps', () => {
    // 3 seconds in, at 5 m/s -- frame 90 at 30fps and frame 180 at 60fps both
    // land on t=3s, so both must report the identical mileage.
    const at30fps = mileageForFrame(90, { ...config, fps: 30 })
    const at60fps = mileageForFrame(180, { ...config, fps: 60 })
    expect(at30fps).toBeCloseTo(15)
    expect(at60fps).toBeCloseTo(15)
    expect(at30fps).toBeCloseTo(at60fps)
  })

  it('does not depend on any wall-clock/real-time input -- repeated calls with the same arguments are bit-identical', () => {
    const a = mileageForFrame(4321, config)
    const b = mileageForFrame(4321, config)
    expect(a).toBe(b)
  })

  it('clamps to totalMileageM for a frame index past the end', () => {
    expect(mileageForFrame(1_000_000, config)).toBe(config.totalMileageM)
  })

  it('clamps to 0 for a negative frame index', () => {
    expect(mileageForFrame(-10, config)).toBe(0)
  })

  it('is monotonically non-decreasing across frames', () => {
    let prev = -1
    for (let i = 0; i < 50; i++) {
      const m = mileageForFrame(i, config)
      expect(m).toBeGreaterThanOrEqual(prev)
      prev = m
    }
  })
})

describe('nextExportPhase: cancellation state machine', () => {
  it('walks the happy path idle -> prefetching -> rendering -> finalizing -> completed', () => {
    let phase: RenderLoopPhase = 'idle'
    phase = nextExportPhase(phase, { type: 'start' })
    expect(phase).toBe('prefetching')
    phase = nextExportPhase(phase, { type: 'prefetchDone' })
    expect(phase).toBe('rendering')
    phase = nextExportPhase(phase, { type: 'framesDone' })
    expect(phase).toBe('finalizing')
    phase = nextExportPhase(phase, { type: 'finalizeDone' })
    expect(phase).toBe('completed')
  })

  it.each<RenderLoopPhase>(['prefetching', 'rendering', 'finalizing'])('cancel from %s goes to cancelled', (phase) => {
    expect(nextExportPhase(phase, { type: 'cancel' })).toBe('cancelled')
  })

  it.each<RenderLoopPhase>(['prefetching', 'rendering', 'finalizing'])('fail from %s goes to error', (phase) => {
    expect(nextExportPhase(phase, { type: 'fail' })).toBe('error')
  })

  it('an event that does not apply to the current phase is a no-op', () => {
    expect(nextExportPhase('idle', { type: 'framesDone' })).toBe('idle')
    expect(nextExportPhase('prefetching', { type: 'finalizeDone' })).toBe('prefetching')
    expect(nextExportPhase('rendering', { type: 'prefetchDone' })).toBe('rendering')
  })

  it.each<RenderLoopPhase>(['completed', 'cancelled', 'error'])('terminal phase %s absorbs every further event', (phase) => {
    expect(nextExportPhase(phase, { type: 'start' })).toBe(phase)
    expect(nextExportPhase(phase, { type: 'cancel' })).toBe(phase)
    expect(nextExportPhase(phase, { type: 'fail' })).toBe(phase)
    expect(nextExportPhase(phase, { type: 'framesDone' })).toBe(phase)
  })

  it('isTerminalExportPhase matches the three absorbing phases', () => {
    expect(isTerminalExportPhase('completed')).toBe(true)
    expect(isTerminalExportPhase('cancelled')).toBe(true)
    expect(isTerminalExportPhase('error')).toBe(true)
    expect(isTerminalExportPhase('idle')).toBe(false)
    expect(isTerminalExportPhase('prefetching')).toBe(false)
    expect(isTerminalExportPhase('rendering')).toBe(false)
    expect(isTerminalExportPhase('finalizing')).toBe(false)
  })
})
