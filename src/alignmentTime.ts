import type { OffsetSegment } from './types'

/**
 * Map a local (owning-file) timestamp to the aligned (reference) display
 * timebase.  Falls back to the first segment's offset for timestamps before
 * the first segment and the last segment's offset for timestamps after the
 * last segment.  With no segments the timestamp is returned unchanged.
 */
export function localToAligned(
  localTs: number,
  segments: OffsetSegment[],
): number {
  for (const seg of segments) {
    if (localTs >= seg.fromTime && localTs <= seg.toTime) {
      return localTs + seg.offsetSeconds * 1000
    }
  }
  if (segments.length > 0) {
    if (localTs < segments[0].fromTime) {
      return localTs + segments[0].offsetSeconds * 1000
    }
    return localTs + segments[segments.length - 1].offsetSeconds * 1000
  }
  return localTs
}

/**
 * Map an aligned (reference/display) timestamp back to the owning file's
 * local timebase.  Falls back before the first segment and after the last
 * segment identically to `localToAligned`.
 */
export function alignedToLocal(
  alignedTs: number,
  segments: OffsetSegment[],
): number {
  for (const seg of segments) {
    const segFrom = seg.fromTime + seg.offsetSeconds * 1000
    const segTo = seg.toTime + seg.offsetSeconds * 1000
    if (alignedTs >= segFrom && alignedTs <= segTo) {
      return alignedTs - seg.offsetSeconds * 1000
    }
  }
  if (segments.length > 0) {
    const firstFrom = segments[0].fromTime + segments[0].offsetSeconds * 1000
    if (alignedTs < firstFrom) {
      return alignedTs - segments[0].offsetSeconds * 1000
    }
    return (
      alignedTs - segments[segments.length - 1].offsetSeconds * 1000
    )
  }
  return alignedTs
}

/**
 * Return the aligned display window [from, to] (in ms) that a segment
 * occupies on the reference timebase.
 */
export function segmentAlignedWindow(
  seg: OffsetSegment,
): { from: number; to: number } {
  const offsetMs = seg.offsetSeconds * 1000
  return { from: seg.fromTime + offsetMs, to: seg.toTime + offsetMs }
}

/**
 * Test whether an *aligned* (reference-grid) timestamp falls inside any
 * pause gap between segments.
 *
 * A pause gap exists between two segments when the earlier segment's aligned
 * window ends before the next segment's aligned window begins.  Single-
 * segment files never report a pause through this function.
 */
export function isInPause(
  alignedTs: number,
  segments: OffsetSegment[],
): boolean {
  if (segments.length <= 1) return false
  for (let i = 0; i < segments.length - 1; i++) {
    const prev = segmentAlignedWindow(segments[i])
    const next = segmentAlignedWindow(segments[i + 1])
    if (alignedTs > prev.to && alignedTs < next.from) {
      return true
    }
  }
  return false
}

/**
 * Find the offset (in seconds) that applies to a given *local* timestamp.
 * Returns 0 if no segment covers the timestamp (should not happen for
 * timestamps inside the file's recorded range).
 */
export function offsetForLocalTs(
  localTs: number,
  segments: OffsetSegment[],
): number {
  for (const seg of segments) {
    if (localTs >= seg.fromTime && localTs <= seg.toTime) {
      return seg.offsetSeconds
    }
  }
  return 0
}

/**
 * Given an aligned-time range, compute the set of per-segment local-time
 * windows that intersect it.  Each window is expressed in the file's local
 * timebase.
 */
export function alignedRangeToLocalWindows(
  range: { fromTime: number; toTime: number },
  segments: OffsetSegment[],
): { from: number; to: number }[] {
  if (segments.length === 0) {
    return [{ from: range.fromTime, to: range.toTime }]
  }
  const out: { from: number; to: number }[] = []
  for (const seg of segments) {
    const { from: segFrom, to: segTo } = segmentAlignedWindow(seg)
    const lo = Math.max(range.fromTime, segFrom)
    const hi = Math.min(range.toTime, segTo)
    if (lo <= hi) {
      out.push({ from: lo - seg.offsetSeconds * 1000, to: hi - seg.offsetSeconds * 1000 })
    }
  }
  return out
}
