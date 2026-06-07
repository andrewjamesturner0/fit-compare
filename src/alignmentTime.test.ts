import { describe, it, expect } from 'vitest'
import {
  localToAligned,
  alignedToLocal,
  segmentAlignedWindow,
  isInPause,
  offsetForLocalTs,
  alignedRangeToLocalWindows,
} from './alignmentTime'
import type { OffsetSegment } from './types'

function t(s: number): number {
  return s * 1000
}

describe('localToAligned', () => {
  it('maps through the matching segment', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(100), offsetSeconds: 5 },
    ]
    expect(localToAligned(t(50), segs)).toBe(t(55))
  })

  it('falls back to first segment offset before first segment', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(10), toTime: t(100), offsetSeconds: 5 },
    ]
    expect(localToAligned(t(5), segs)).toBe(t(10))
  })

  it('falls back to last segment offset after last segment', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(50), offsetSeconds: 2 },
      { fromTime: t(60), toTime: t(100), offsetSeconds: 8 },
    ]
    expect(localToAligned(t(120), segs)).toBe(t(128))
  })

  it('returns unchanged timestamp with no segments', () => {
    expect(localToAligned(t(42), [])).toBe(t(42))
  })

  it('handles offset 0 correctly', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(100), offsetSeconds: 0 },
    ]
    expect(localToAligned(t(50), segs)).toBe(t(50))
  })

  it('handles negative offset', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(100), offsetSeconds: -10 },
    ]
    expect(localToAligned(t(50), segs)).toBe(t(40))
  })
})

describe('alignedToLocal', () => {
  it('maps through the matching segment aligned window', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(100), offsetSeconds: 5 },
    ]
    // aligned 55 maps to local 50
    expect(alignedToLocal(t(55), segs)).toBe(t(50))
  })

  it('falls back before first segment', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(10), toTime: t(100), offsetSeconds: 5 },
    ]
    expect(alignedToLocal(t(12), segs)).toBe(t(7))
  })

  it('falls back after last segment', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(50), offsetSeconds: 2 },
      { fromTime: t(60), toTime: t(100), offsetSeconds: 8 },
    ]
    // aligned 120 maps to local 112 (last segment's offset=8)
    expect(alignedToLocal(t(120), segs)).toBe(t(112))
  })

  it('returns unchanged with no segments', () => {
    expect(alignedToLocal(t(42), [])).toBe(t(42))
  })

  it('handles offset jumps > 60 s', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(100), offsetSeconds: 0 },
      { fromTime: t(200), toTime: t(300), offsetSeconds: 133 },
    ]
    // Aligned 333 maps to local t=(333-133)=t(200), which falls in segment 2
    expect(alignedToLocal(t(333), segs)).toBe(t(200))
    // Aligned 50 maps to local 50, which is before segment 1's aligned from=0
    // so falls back to first offset: 50 - 0 = 50
    expect(alignedToLocal(t(50), segs)).toBe(t(50))
    // Aligned 433 maps to local 300 (last segment offset=133)
    expect(alignedToLocal(t(433), segs)).toBe(t(300))
  })
})

describe('segmentAlignedWindow', () => {
  it('applies offset to local bounds', () => {
    expect(
      segmentAlignedWindow({ fromTime: t(10), toTime: t(50), offsetSeconds: 3 }),
    ).toEqual({ from: t(13), to: t(53) })
  })

  it('handles zero offset', () => {
    expect(
      segmentAlignedWindow({ fromTime: t(10), toTime: t(50), offsetSeconds: 0 }),
    ).toEqual({ from: t(10), to: t(50) })
  })
})

describe('isInPause', () => {
  it('returns false for single-segment files', () => {
    expect(
      isInPause(t(50), [{ fromTime: t(0), toTime: t(100), offsetSeconds: 0 }]),
    ).toBe(false)
  })

  it('returns false for empty segments', () => {
    expect(isInPause(t(50), [])).toBe(false)
  })

  it('returns true when aligned ts falls in a gap between segments', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(50), offsetSeconds: 0 },
      { fromTime: t(70), toTime: t(120), offsetSeconds: 5 },
    ]
    // Aligned windows: [0, 50] and [75, 125]
    // Gap: (50, 75). t=60 is in the gap.
    expect(isInPause(t(60), segs)).toBe(true)
  })

  it('returns false when aligned ts is inside a segment', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(50), offsetSeconds: 0 },
      { fromTime: t(70), toTime: t(120), offsetSeconds: 5 },
    ]
    expect(isInPause(t(25), segs)).toBe(false)
    expect(isInPause(t(90), segs)).toBe(false)
  })

  it('handles offset gap at boundary precisely', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(100), offsetSeconds: 0 },
      { fromTime: t(200), toTime: t(300), offsetSeconds: 133 },
    ]
    // Aligned windows: [0, 100] and [333, 433]
    // Gap: (100, 333)
    expect(isInPause(t(200), segs)).toBe(true) // inside gap
    expect(isInPause(t(100), segs)).toBe(false) // at boundary
    expect(isInPause(t(333), segs)).toBe(false) // at boundary
  })
})

describe('offsetForLocalTs', () => {
  it('returns the offset for the segment containing the local ts', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(50), offsetSeconds: 0 },
      { fromTime: t(60), toTime: t(100), offsetSeconds: 10 },
    ]
    expect(offsetForLocalTs(t(25), segs)).toBe(0)
    expect(offsetForLocalTs(t(80), segs)).toBe(10)
  })

  it('returns 0 when no segment covers the timestamp', () => {
    expect(offsetForLocalTs(t(55), [{ fromTime: t(0), toTime: t(50), offsetSeconds: 5 }])).toBe(0)
  })
})

describe('alignedRangeToLocalWindows', () => {
  it('returns the full range unchanged with no segments', () => {
    expect(alignedRangeToLocalWindows({ fromTime: t(10), toTime: t(50) }, [])).toEqual([
      { from: t(10), to: t(50) },
    ])
  })

  it('subtracts segment offset from aligned range', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(100), offsetSeconds: 5 },
    ]
    // Aligned range [60, 80] -> local [55, 75]
    expect(
      alignedRangeToLocalWindows({ fromTime: t(60), toTime: t(80) }, segs),
    ).toEqual([{ from: t(55), to: t(75) }])
  })

  it('splits across multiple segments with non-zero offsets', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(50), offsetSeconds: 0 },
      { fromTime: t(60), toTime: t(110), offsetSeconds: 10 },
    ]
    // Aligned windows: [0, 50] and [70, 120]
    // Range [25, 90] intersects:
    //   [25, 50] -> local [25, 50]
    //   [70, 90] -> local [60, 80]
    const result = alignedRangeToLocalWindows({ fromTime: t(25), toTime: t(90) }, segs)
    expect(result).toEqual([
      { from: t(25), to: t(50) },
      { from: t(60), to: t(80) },
    ])
  })

  it('returns empty array when range is outside all segments', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(50), offsetSeconds: 0 },
    ]
    expect(
      alignedRangeToLocalWindows({ fromTime: t(100), toTime: t(200) }, segs),
    ).toEqual([])
  })

  it('handles large offset gaps (>60 s)', () => {
    const segs: OffsetSegment[] = [
      { fromTime: t(0), toTime: t(100), offsetSeconds: 0 },
      { fromTime: t(200), toTime: t(300), offsetSeconds: 133 },
    ]
    // Aligned windows: [0, 100] and [333, 433]
    // Range [80, 400]:
    //   [80, 100] -> local [80, 100]
    //   [333, 400] -> local [200, 267]
    const result = alignedRangeToLocalWindows({ fromTime: t(80), toTime: t(400) }, segs)
    expect(result).toEqual([
      { from: t(80), to: t(100) },
      { from: t(200), to: t(267) },
    ])
  })
})
