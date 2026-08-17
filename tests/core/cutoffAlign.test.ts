import { describe, it, expect } from 'vitest'
import type { CheckPoint } from '../../src/core/model/checkpoint'
import type { SegmentStats } from '../../src/core/stats/segments'
import { sortCpsByAnchor, alignCutoffsToSegments } from '../../src/core/stats/cutoffAlign'

function cp(name: string, anchorIndex: number, cutoffTime?: string): CheckPoint {
  return { id: name, trackId: 'trk_test', name, kind: 'cp', anchorIndex, cutoffTime }
}

function seg(fromName: string, toName: string): SegmentStats {
  return {
    fromName, toName, fromIndex: 0, toIndex: 0,
    dist: 1000, gain: 0, loss: 0, gainRate: 0, lossRate: 0, netSlope: 0,
  }
}

describe('sortCpsByAnchor', () => {
  it('sorts by anchorIndex ascending regardless of input order', () => {
    const sorted = sortCpsByAnchor([cp('CP2', 60), cp('CP1', 30)])
    expect(sorted.map((c) => c.name)).toEqual(['CP1', 'CP2'])
  })

  it('does not mutate the input array', () => {
    const input = [cp('CP2', 60), cp('CP1', 30)]
    sortCpsByAnchor(input)
    expect(input.map((c) => c.name)).toEqual(['CP2', 'CP1'])
  })
})

describe('alignCutoffsToSegments', () => {
  it('maps each non-final segment to its ending CP cutoff, and the final segment to undefined', () => {
    const sortedCps = [cp('CP1', 30, '2026-08-07T09:00:00+08:00'), cp('CP2', 60, '2026-08-07T12:00:00+08:00')]
    const segments = [seg('起点', 'CP1'), seg('CP1', 'CP2'), seg('CP2', '终点')]
    const cutoffs = alignCutoffsToSegments(segments, sortedCps)
    expect(cutoffs).toHaveLength(3)
    expect(cutoffs[0]).toBe(Date.parse('2026-08-07T09:00:00+08:00'))
    expect(cutoffs[1]).toBe(Date.parse('2026-08-07T12:00:00+08:00'))
    expect(cutoffs[2]).toBeUndefined()
  })

  it('a CP with no cutoffTime yields undefined at its index', () => {
    const sortedCps = [cp('CP1', 30)]
    const segments = [seg('起点', 'CP1'), seg('CP1', '终点')]
    const cutoffs = alignCutoffsToSegments(segments, sortedCps)
    expect(cutoffs[0]).toBeUndefined()
  })

  it('an unparseable cutoffTime yields undefined rather than NaN', () => {
    const sortedCps = [cp('CP1', 30, 'not-a-date')]
    const segments = [seg('起点', 'CP1'), seg('CP1', '终点')]
    const cutoffs = alignCutoffsToSegments(segments, sortedCps)
    expect(cutoffs[0]).toBeUndefined()
  })

  it('zero CPs: every segment maps to undefined', () => {
    const segments = [seg('起点', '终点')]
    const cutoffs = alignCutoffsToSegments(segments, [])
    expect(cutoffs).toEqual([undefined])
  })
})
