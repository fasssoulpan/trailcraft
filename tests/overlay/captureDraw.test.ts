import { describe, it, expect, vi } from 'vitest'
import { drawHudEntries, drawCheckpointCard, drawRadarCapture } from '../../src/overlay/captureDraw'
import { computeCaptureLayout } from '../../src/overlay/captureLayout'
import { formatHudStats } from '../../src/ui/hudStats'
import { buildCheckpointCardData } from '../../src/ui/checkpointApproach'
import { chooseRadarRings } from '../../src/overlay/radarMath'
import { createTrack, type Track } from '../../src/core/model/track'
import { computeCumDist } from '../../src/core/geo/distance'
import type { CheckPoint } from '../../src/core/model/checkpoint'

/**
 * A minimal stand-in for `CanvasRenderingContext2D` -- same pattern
 * `tests/overlay/radarRender.test.ts` already established: this repo's
 * tests run in Node with no real canvas, so `drawHudEntries`/
 * `drawCheckpointCard`/`drawRadarCapture` (all deliberately targeting an
 * arbitrary context, see captureDraw.ts's own doc comment) are exercised
 * against a fake that records calls instead of rendering anything, and
 * these tests assert "doesn't throw" plus a handful of call-count/content
 * invariants -- not literal pixel output, which the milestone brief
 * explicitly says not to attempt in Node.
 */
function makeFakeCtx() {
  const fillTextCalls: string[] = []
  const state = { fillRect: 0, strokeRect: 0, arc: 0, translateX: 0, translateY: 0 }
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn((x: number, y: number) => {
      state.translateX += x
      state.translateY += y
    }),
    clearRect: vi.fn(),
    fillRect: vi.fn(() => {
      state.fillRect++
    }),
    strokeRect: vi.fn(() => {
      state.strokeRect++
    }),
    fillText: vi.fn((text: string) => {
      fillTextCalls.push(text)
    }),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(() => {
      state.arc++
    }),
    stroke: vi.fn(),
    fill: vi.fn(),
    set strokeStyle(_v: string) {},
    set fillStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set font(_v: string) {},
    set textAlign(_v: string) {},
    set textBaseline(_v: string) {},
  } as unknown as CanvasRenderingContext2D
  return { ctx, fillTextCalls, state }
}

function makeTrack(): Track {
  const n = 20
  const lon = Array.from({ length: n }, (_, i) => 116 + i * 0.001)
  const lat = Array.from({ length: n }, () => 39)
  const ele = Array.from({ length: n }, (_, i) => 100 + i * 5)
  const t = createTrack({ lon, lat, ele }, { name: 'x', format: 'gpx', fileName: 'x.gpx' })
  t.points.cumDist = computeCumDist(t.points.lon, t.points.lat)
  return t
}

describe('drawHudEntries', () => {
  it('does not throw for a normal entry set and draws one chip per entry', () => {
    const { ctx, state } = makeFakeCtx()
    const layout = computeCaptureLayout(1920, 1080)
    const entries = formatHudStats(
      { mileageKm: 3.47, elevationM: 274, ascentM: 245, gradientPct: 1.5, heartRateBpm: 140 },
      true,
    )
    expect(() => drawHudEntries(ctx, entries, layout.hud)).not.toThrow()
    expect(state.fillRect).toBe(entries.length)
  })

  it('is a no-op for an empty entry set (no active track yet)', () => {
    const { ctx, state } = makeFakeCtx()
    const layout = computeCaptureLayout(1920, 1080)
    drawHudEntries(ctx, [], layout.hud)
    expect(state.fillRect).toBe(0)
  })

  it('draws label, value and unit text for every entry that has a unit', () => {
    const { ctx, fillTextCalls } = makeFakeCtx()
    const layout = computeCaptureLayout(1920, 1080)
    const entries = formatHudStats({ mileageKm: 1.23, elevationM: undefined, ascentM: undefined, gradientPct: undefined, heartRateBpm: undefined }, false)
    drawHudEntries(ctx, entries, layout.hud)
    expect(fillTextCalls).toContain('里程')
    expect(fillTextCalls).toContain('1.23')
    expect(fillTextCalls).toContain('km')
  })
})

describe('drawCheckpointCard', () => {
  it('does not throw and draws the card background plus the accent-colour left border', () => {
    const { ctx, state } = makeFakeCtx()
    const layout = computeCaptureLayout(1920, 1080)
    const track = makeTrack()
    const cp: CheckPoint = { id: 'cp1', trackId: track.id, name: '补给站A', kind: 'aid', anchorIndex: 10, cutoffTime: '2026-08-06T14:00:00+08:00' }
    const data = buildCheckpointCardData(cp, track)
    expect(() => drawCheckpointCard(ctx, data, layout.checkpointCard)).not.toThrow()
    // card background + accent border stripe = 2 fillRect calls, plus one strokeRect for the card outline.
    expect(state.fillRect).toBe(2)
    expect(state.strokeRect).toBe(1)
  })

  it('draws the checkpoint name and cutoff text', () => {
    const { ctx, fillTextCalls } = makeFakeCtx()
    const layout = computeCaptureLayout(1920, 1080)
    const track = makeTrack()
    const cp: CheckPoint = { id: 'cp1', trackId: track.id, name: '补给站A', kind: 'aid', anchorIndex: 10, cutoffTime: '2026-08-06T14:00:00+08:00' }
    const data = buildCheckpointCardData(cp, track)
    drawCheckpointCard(ctx, data, layout.checkpointCard)
    expect(fillTextCalls).toContain('补给站A')
    expect(fillTextCalls.some((t) => t.startsWith('关门 '))).toBe(true)
  })

  it('omits the cutoff text when the checkpoint has none', () => {
    const { ctx, fillTextCalls } = makeFakeCtx()
    const layout = computeCaptureLayout(1920, 1080)
    const track = makeTrack()
    const cp: CheckPoint = { id: 'cp1', trackId: track.id, name: '补给站A', kind: 'aid', anchorIndex: 10 }
    const data = buildCheckpointCardData(cp, track)
    drawCheckpointCard(ctx, data, layout.checkpointCard)
    expect(fillTextCalls.some((t) => t.startsWith('关门'))).toBe(false)
  })
})

describe('drawRadarCapture', () => {
  it('does not throw and translates by the layout position before drawing', () => {
    const { ctx, state } = makeFakeCtx()
    const layout = computeCaptureLayout(1920, 1080)
    const ringSet = chooseRadarRings(2, layout.radar.size / 2 - 24)
    expect(() => drawRadarCapture(ctx, layout.radar, ringSet, 0)).not.toThrow()
    expect(state.translateX).toBeCloseTo(layout.radar.x, 5)
    expect(state.translateY).toBeCloseTo(layout.radar.y, 5)
  })

  it('skips drawing entirely for a degenerate zero-size box', () => {
    const { ctx } = makeFakeCtx()
    const ringSet = chooseRadarRings(2, 100)
    expect(() => drawRadarCapture(ctx, { x: 0, y: 0, size: 0, scale: 1 }, ringSet, 0)).not.toThrow()
    expect(ctx.translate).not.toHaveBeenCalled()
  })
})
