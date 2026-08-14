import { describe, it, expect } from 'vitest'
import { assembleMuxerChunks, type MuxerChunk } from '../../src/cesium/videoEncoder'

const chunk = (position: number, bytes: number[]): MuxerChunk => ({
  position,
  data: Uint8Array.from(bytes),
})

describe('assembleMuxerChunks', () => {
  it('concatenates strictly in-order writes (the fragmented-MP4 fast path)', () => {
    const out = assembleMuxerChunks([chunk(0, [1, 2]), chunk(2, [3, 4]), chunk(4, [5])])
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })

  it('places out-of-order writes at their declared offsets', () => {
    // Muxer emits a later region first, then goes back to fill the front.
    const out = assembleMuxerChunks([chunk(4, [9, 9]), chunk(0, [1, 2, 3, 4])])
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 9, 9])
  })

  it('lets a later write patch bytes an earlier write already emitted', () => {
    // This is the case mp4-muxer's one-arg-onData warning is about: appending
    // blindly would produce [1,2,3,4,7,7] plus a stray tail instead.
    const out = assembleMuxerChunks([chunk(0, [1, 2, 3, 4]), chunk(1, [7, 7])])
    expect(Array.from(out)).toEqual([1, 7, 7, 4])
  })

  it('sizes the output by the furthest write, not by total bytes written', () => {
    const out = assembleMuxerChunks([chunk(0, [1, 2]), chunk(0, [3, 4])])
    expect(out.length).toBe(2)
    expect(Array.from(out)).toEqual([3, 4])
  })

  it('leaves gaps zero-filled rather than shifting later bytes forward', () => {
    const out = assembleMuxerChunks([chunk(0, [1]), chunk(3, [4])])
    expect(Array.from(out)).toEqual([1, 0, 0, 4])
  })

  it('returns an empty buffer for no writes', () => {
    expect(assembleMuxerChunks([]).length).toBe(0)
  })
})
