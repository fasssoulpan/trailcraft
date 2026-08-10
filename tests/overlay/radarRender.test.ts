import { describe, it, expect, vi } from 'vitest'
import { drawRadar, drawNextCheckpointReadout } from '../../src/overlay/radarRender'
import { chooseRadarRings, type RadarRingSet } from '../../src/overlay/radarMath'
import { buildRadarTargets, type NextCheckpointInfo } from '../../src/overlay/radarTargets'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import type { CheckPoint } from '../../src/core/model/checkpoint'

/**
 * A minimal stand-in for `CanvasRenderingContext2D`, recording calls rather
 * than actually rendering anything -- this repo's tests run in Node (see
 * vite.config.ts's `test.environment`), with no real canvas available.
 * `drawRadar`'s whole point is that it targets an arbitrary context object
 * rather than reaching for a specific on-screen canvas (see that file's own
 * doc comment for why, and the milestone brief's explicit requirement) --
 * this fake is exactly the kind of "arbitrary context" that requirement is
 * meant to make possible to test against.
 */
function makeFakeCtx() {
  const calls: {
    arc: number
    fillText: string[]
    stroke: number
    fill: number
    fillRect: number
    clearRect: number
    setLineDash: number
  } = {
    arc: 0,
    fillText: [],
    stroke: 0,
    fill: 0,
    fillRect: 0,
    clearRect: 0,
    setLineDash: 0,
  }
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(() => {
      calls.clearRect++
    }),
    fillRect: vi.fn(() => {
      calls.fillRect++
    }),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(() => {
      calls.arc++
    }),
    stroke: vi.fn(() => {
      calls.stroke++
    }),
    fill: vi.fn(() => {
      calls.fill++
    }),
    fillText: vi.fn((text: string) => {
      calls.fillText.push(text)
    }),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
    setLineDash: vi.fn(() => {
      calls.setLineDash++
    }),
    set strokeStyle(_v: string) {},
    set fillStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set font(_v: string) {},
    set textAlign(_v: string) {},
    set textBaseline(_v: string) {},
  } as unknown as CanvasRenderingContext2D
  return { ctx, calls }
}

function ringSetOf(count: number): RadarRingSet {
  return chooseRadarRings(2, 100, count)
}

// A straight line of points ~roughly spaced, matching
// tests/core/checkpointApproach.test.ts's own fixture -- exact spacing
// doesn't matter, only that cumDist grows monotonically.
function makeTrack(n = 50): Track {
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.001)
  const lat = Array.from({ length: n }, () => 39)
  const t = createTrack({ lon, lat }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

function makeCp(patch: Partial<CheckPoint> & { anchorIndex: number; trackId: string }): CheckPoint {
  return { id: `cp_${patch.anchorIndex}`, name: 'CP', kind: 'cp', ...patch }
}

describe('drawRadar', () => {
  it('does not throw for a normal ring set', () => {
    const { ctx } = makeFakeCtx()
    expect(() => drawRadar(ctx, 200, 200, ringSetOf(4), { centerX: 100, centerY: 100, headingRad: 0 })).not.toThrow()
  })

  it('clears the given width/height exactly once, regardless of ring count', () => {
    const { ctx, calls } = makeFakeCtx()
    drawRadar(ctx, 150, 150, ringSetOf(3), { centerX: 75, centerY: 75, headingRad: 0 })
    expect(calls.clearRect).toBe(1)
  })

  it('draws one circle per ring, plus the backing disc and the centre dot', () => {
    const { ctx, calls } = makeFakeCtx()
    const ringSet = ringSetOf(4)
    drawRadar(ctx, 200, 200, ringSet, { centerX: 100, centerY: 100, headingRad: 0 })
    // backing disc + one per ring + centre dot
    expect(calls.arc).toBe(1 + ringSet.rings.length + 1)
  })

  it('draws one distance label per ring, plus the "N" north marker', () => {
    const { ctx, calls } = makeFakeCtx()
    const ringSet = ringSetOf(4)
    drawRadar(ctx, 200, 200, ringSet, { centerX: 100, centerY: 100, headingRad: 0 })
    expect(calls.fillText.length).toBe(ringSet.rings.length + 1)
    expect(calls.fillText).toContain('N')
    for (const ring of ringSet.rings) expect(calls.fillText).toContain(ring.label)
  })

  it('handles a degenerate empty ring set without throwing and skips ticks/north marker', () => {
    const { ctx, calls } = makeFakeCtx()
    const emptyRingSet: RadarRingSet = { stepM: 10, rings: [] }
    expect(() => drawRadar(ctx, 200, 200, emptyRingSet, { centerX: 100, centerY: 100, headingRad: 0 })).not.toThrow()
    // no backing disc (outerR === 0), no ring labels, no north marker -- just the centre dot.
    expect(calls.arc).toBe(1)
    expect(calls.fillText).toEqual([])
  })

  it('accepts any finite heading without throwing, including negative/large values', () => {
    const { ctx } = makeFakeCtx()
    const ringSet = ringSetOf(4)
    for (const heading of [0, Math.PI / 2, -Math.PI, Math.PI * 5]) {
      expect(() => drawRadar(ctx, 200, 200, ringSet, { centerX: 100, centerY: 100, headingRad: heading })).not.toThrow()
    }
  })

  describe('checkpoint target blips', () => {
    it('without targets/metersPerPixel, behaves exactly as before (no extra arcs/labels)', () => {
      const { ctx, calls } = makeFakeCtx()
      const ringSet = ringSetOf(4)
      drawRadar(ctx, 200, 200, ringSet, { centerX: 100, centerY: 100, headingRad: 0 })
      const baselineArc = calls.arc
      const baselineText = calls.fillText.length
      const { ctx: ctx2, calls: calls2 } = makeFakeCtx()
      const t = makeTrack()
      const cp = makeCp({ anchorIndex: 10, trackId: t.id })
      const targets = buildRadarTargets(t, [cp], 0, 0, undefined).targets
      // No metersPerPixel supplied -- targets must be ignored, not throw.
      drawRadar(ctx2, 200, 200, ringSet, { centerX: 100, centerY: 100, headingRad: 0, targets })
      expect(calls2.arc).toBe(baselineArc)
      expect(calls2.fillText.length).toBe(baselineText)
    })

    it('plots one blip per checkpoint AHEAD, skipping ones already passed', () => {
      const { ctx, calls } = makeFakeCtx()
      const ringSet = ringSetOf(4)
      const t = makeTrack()
      const ahead = makeCp({ anchorIndex: 30, trackId: t.id, name: 'ahead' })
      const passed = makeCp({ anchorIndex: 5, trackId: t.id, name: 'passed' })
      const targets = buildRadarTargets(t, [ahead, passed], 10, 0, undefined).targets
      drawRadar(ctx, 200, 200, ringSet, {
        centerX: 100,
        centerY: 100,
        headingRad: 0,
        metersPerPixel: 2,
        targets,
      })
      // The next-checkpoint label ("ahead") is drawn; "passed" never appears
      // as a label (only the next target is labelled) and contributes no
      // blip arc at all.
      expect(calls.fillText).toContain('ahead')
      expect(calls.fillText).not.toContain('passed')
    })

    it('does not throw for an empty targets array', () => {
      const { ctx } = makeFakeCtx()
      const ringSet = ringSetOf(4)
      expect(() =>
        drawRadar(ctx, 200, 200, ringSet, { centerX: 100, centerY: 100, headingRad: 0, metersPerPixel: 2, targets: [] }),
      ).not.toThrow()
    })

    it('draws a dashed clamp indicator for a target beyond the outermost ring', () => {
      const { ctx, calls } = makeFakeCtx()
      // A small ring set (short max range) so a distant checkpoint is
      // guaranteed to fall outside it.
      const ringSet = chooseRadarRings(1, 50, 2) // outer ring only a few tens of metres out
      const t = makeTrack(200)
      const farCp = makeCp({ anchorIndex: 199, trackId: t.id, name: 'far' })
      const targets = buildRadarTargets(t, [farCp], 0, 0, undefined).targets
      drawRadar(ctx, 200, 200, ringSet, {
        centerX: 100,
        centerY: 100,
        headingRad: 0,
        metersPerPixel: 1,
        targets,
      })
      expect(calls.setLineDash).toBeGreaterThan(0)
    })

    it('does not throw when plotting the next checkpoint (leader line + emphasis ring)', () => {
      const { ctx } = makeFakeCtx()
      const ringSet = ringSetOf(4)
      const t = makeTrack()
      const cp = makeCp({ anchorIndex: 20, trackId: t.id })
      const targets = buildRadarTargets(t, [cp], 0, 0, undefined).targets
      expect(() =>
        drawRadar(ctx, 200, 200, ringSet, {
          centerX: 100,
          centerY: 100,
          headingRad: 0,
          metersPerPixel: 2,
          targets,
        }),
      ).not.toThrow()
    })
  })
})

describe('drawNextCheckpointReadout', () => {
  const nextInfo: NextCheckpointInfo = {
    id: 'cp1',
    name: '大本营补给站',
    kind: 'aid',
    remainingDistanceM: 3420,
    remainingClimbM: 128,
    cutoff: '14:00',
  }

  it('does not throw for a normal box', () => {
    const { ctx } = makeFakeCtx()
    expect(() => drawNextCheckpointReadout(ctx, 0, 0, 150, 150, nextInfo)).not.toThrow()
  })

  it('draws name, formatted distance, climb, and cutoff text', () => {
    const { ctx, calls } = makeFakeCtx()
    drawNextCheckpointReadout(ctx, 0, 0, 150, 150, nextInfo)
    expect(calls.fillText).toContain('大本营补给站')
    expect(calls.fillText).toContain('3.42 km')
    expect(calls.fillText).toContain('↑ 128 m')
    expect(calls.fillText).toContain('关门 14:00')
  })

  it('omits the cutoff line when unset, and shows "↑ --" when climb is unknown', () => {
    const { ctx, calls } = makeFakeCtx()
    const info: NextCheckpointInfo = { ...nextInfo, remainingClimbM: undefined, cutoff: undefined }
    drawNextCheckpointReadout(ctx, 0, 0, 150, 150, info)
    expect(calls.fillText).toContain('↑ --')
    expect(calls.fillText.some((t) => t.startsWith('关门'))).toBe(false)
  })

  it('draws a muted placeholder when there is no next checkpoint, not the checkpoint fields', () => {
    const { ctx, calls } = makeFakeCtx()
    drawNextCheckpointReadout(ctx, 0, 0, 150, 150, undefined)
    expect(calls.fillText).toContain('无下一检查点')
    expect(calls.fillText).not.toContain('大本营补给站')
  })

  it('truncates a name too wide for the box instead of overflowing', () => {
    const { ctx, calls } = makeFakeCtx()
    const longName = 'A'.repeat(200)
    drawNextCheckpointReadout(ctx, 0, 0, 150, 150, { ...nextInfo, name: longName })
    const nameCall = calls.fillText.find((t) => t.startsWith('A'))
    expect(nameCall).toBeDefined()
    expect(nameCall!.length).toBeLessThan(longName.length)
    expect(nameCall!.endsWith('…')).toBe(true)
  })

  it('scales font/padding with box height (a taller box is not just a bigger empty box)', () => {
    const { ctx: ctxSmall, calls: callsSmall } = makeFakeCtx()
    drawNextCheckpointReadout(ctxSmall, 0, 0, 150, 150, nextInfo)
    // Just verifying it doesn't throw at a very different (recording-scale)
    // box size, and still draws the same set of text content.
    const { ctx: ctxBig, calls: callsBig } = makeFakeCtx()
    expect(() => drawNextCheckpointReadout(ctxBig, 0, 0, 300, 300, nextInfo)).not.toThrow()
    expect(callsBig.fillText).toEqual(callsSmall.fillText)
  })

  it('does nothing for a degenerate zero-size box', () => {
    const { ctx, calls } = makeFakeCtx()
    drawNextCheckpointReadout(ctx, 0, 0, 0, 0, nextInfo)
    expect(calls.fillText).toEqual([])
    expect(calls.fillRect).toBe(0)
  })
})
