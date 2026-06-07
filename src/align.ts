import type { ResampledSeries, OffsetSegment, AlignmentResult, MetricKey } from './types'
import { ALIGNMENT_METRIC_FALLBACK } from './types'

// ─── Tunable constants ────────────────────────────────────────────────────

/** Width of scoring window (seconds) for initial anchoring. */
const INITIAL_WINDOW_SECONDS = 180
/** Step between consecutive scoring windows (seconds). */
const INITIAL_STRIDE_SECONDS = 60
/** Minimum number of consecutive windows that must agree on the same offset. */
const MIN_CONSECUTIVE_WINDOWS = 2
/** Tolerance (±seconds) for two offsets to be considered "the same". */
const OFFSET_TOLERANCE = 1

/** Full search range (±seconds) for post-pause re-anchoring. */
const PASS3_SEARCH_SECONDS = 300
/** Width of the post-resume reference window (seconds) we score against. */
const PASS3_WINDOW_SECONDS = 180

/** Minimum overlap (seconds) for accepting an offset candidate. */
const MIN_OVERLAP_SECONDS = 30
const PASS3_MIN_OVERLAP_SECONDS = 10

/** Null-run threshold (seconds) for detecting a pause. */
const PAUSE_GAP_THRESHOLD_SECONDS = 10

/**
 * Short-window regime-change detection catches pause-like sections that are
 * recorded as zero/flat data rather than null gaps.
 */
const REGIME_WINDOW_SECONDS = 75
const REGIME_STRIDE_SECONDS = 15
const REGIME_MIN_CONSECUTIVE_WINDOWS = 2
const REGIME_MIN_OVERLAP_SECONDS = 30

/**
 * Normalised-SSE failure threshold.  Candidates above this value are
 * rejected.  Dimensionless; 0.5 corresponds to R² ≈ 0.5.
 */
const SSE_FAILURE_THRESHOLD = 0.5

/**
 * Bias-to-zero margin (Pass 1 only).  Only accept a non-zero offset if its
 * residual is at most this fraction of the residual at offset 0.
 * A value of 0.8 means the best offset must be at least 20 % better.
 */
const ZERO_OFFSET_MARGIN = 0.8

/**
 * Post-pause improvement margin.  A new post-pause offset is only accepted
 * if its residual is at most this fraction of the residual with the
 * previous offset.  0.95 means at least 5 % improvement.
 */
const IMPROVEMENT_MARGIN = 0.95

// ─── Helpers ──────────────────────────────────────────────────────────────

function pickAlignmentMetric(
  ref: ResampledSeries,
  other: ResampledSeries,
): MetricKey | null {
  for (const key of ALIGNMENT_METRIC_FALLBACK) {
    const refHas = ref.values[key].some((v) => v !== null)
    const otherHas = other.values[key].some((v) => v !== null)
    if (refHas && otherHas) return key
  }
  return null
}

/**
 * Pre-build a map from local timestamp -> index for the other series so
 * each candidate offset can look up values in O(1).
 */
function buildTsIndex(s: ResampledSeries): Map<number, number> {
  const m = new Map<number, number>()
  for (let i = 0; i < s.timestamps.length; i++) {
    m.set(s.timestamps[i], i)
  }
  return m
}

// ─── Scoring ──────────────────────────────────────────────────────────────

interface ScoreResult {
  offset: number
  normalizedSSE: number
  overlap: number
  correlation: number
}

/**
 * Score a single offset candidate over a reference-timeline window.
 *
 * For each ref tick `i` in [refStartIdx, refEndIdx), look up the 'other'
 * value at `ref.timestamps[i] - offsetMs` via `otherTsIndex`.
 *
 * Returns the normalised SSE, overlap count, and Pearson r.
 * Returns infinite SSE / zero correlation when the overlap is empty or the
 * reference signal is flat over the window.
 */
function scoreOffset(
  ref: ResampledSeries,
  other: ResampledSeries,
  metric: MetricKey,
  otherTsIndex: Map<number, number>,
  offsetSeconds: number,
  refStartIdx: number,
  refEndIdx: number,
): ScoreResult {
  const offsetMs = offsetSeconds * 1000
  const refValues = ref.values[metric]
  const otherValues = other.values[metric]
  const refTs = ref.timestamps

  // Collect paired values
  const pairs: { ref: number; other: number }[] = []

  for (let i = refStartIdx; i < refEndIdx; i++) {
    const rv = refValues[i]
    if (rv === null) continue
    const otherTs = refTs[i] - offsetMs
    const oi = otherTsIndex.get(otherTs)
    if (oi === undefined) continue
    const ov = otherValues[oi]
    if (ov === null) continue
    pairs.push({ ref: rv, other: ov })
  }

  const n = pairs.length
  if (n < 2) {
    return { offset: offsetSeconds, normalizedSSE: Infinity, overlap: n, correlation: 0 }
  }

  // SSE and SST over the overlap
  let sse = 0
  let refSum = 0
  for (const p of pairs) {
    sse += (p.ref - p.other) ** 2
    refSum += p.ref
  }
  const refMean = refSum / n
  let sst = 0
  for (const p of pairs) {
    sst += (p.ref - refMean) ** 2
  }
  if (sst === 0) {
    return { offset: offsetSeconds, normalizedSSE: Infinity, overlap: n, correlation: 0 }
  }
  const normalizedSSE = sse / sst

  // Pearson r
  const sumX = refSum
  const sumY = pairs.reduce((s, p) => s + p.other, 0)
  const sumXY = pairs.reduce((s, p) => s + p.ref * p.other, 0)
  const sumX2 = pairs.reduce((s, p) => s + p.ref * p.ref, 0)
  const sumY2 = pairs.reduce((s, p) => s + p.other * p.other, 0)
  const numR = n * sumXY - sumX * sumY
  const denR = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY))
  const correlation = denR === 0 ? 0 : numR / denR

  return { offset: offsetSeconds, normalizedSSE, overlap: n, correlation }
}

/**
 * Find the best offset within ±searchRange for a single reference window.
 */
function bestOffsetForWindow(
  ref: ResampledSeries,
  other: ResampledSeries,
  metric: MetricKey,
  otherTsIndex: Map<number, number>,
  searchRange: number,
  refStartIdx: number,
  refEndIdx: number,
): { best: ScoreResult; zero: ScoreResult } {
  let best: ScoreResult = { offset: 0, normalizedSSE: Infinity, overlap: 0, correlation: 0 }
  let zero: ScoreResult = best

  for (let offset = -searchRange; offset <= searchRange; offset++) {
    const s = scoreOffset(ref, other, metric, otherTsIndex, offset, refStartIdx, refEndIdx)
    if (offset === 0) zero = s
    if (s.normalizedSSE < best.normalizedSSE) best = s
  }

  return { best, zero }
}

// ─── PASS 1: Initial anchor via consecutive windows ───────────────────────

/**
 * Find the initial pre-pause offset using a windowed scan.
 *
 * Strategy (D1 – Option B):
 *  - Slide a fixed-duration scoring window across the reference timeline.
 *  - For each window find the best offset (±60 s).
 *  - Require MIN_CONSECUTIVE_WINDOWS consecutive windows to agree on the
 *    same offset (within OFFSET_TOLERANCE) AND to have acceptable quality
 *    (normalised SSE ≤ SSE_FAILURE_THRESHOLD, overlap ≥ MIN_OVERLAP_SECONDS).
 *  - Apply bias-to-zero to the returned offset.
 *
 *  Falls back to a whole-trace scan if no window run qualifies.
 */
function findInitialAnchor(
  ref: ResampledSeries,
  other: ResampledSeries,
  metric: MetricKey,
): ScoreResult {
  const len = ref.timestamps.length
  const windowLenSec = Math.min(INITIAL_WINDOW_SECONDS, len)
  const strideSec = INITIAL_STRIDE_SECONDS
  const otherTsIndex = buildTsIndex(other)

  // Collect per-window results
  interface WindowResult {
    offset: number
    sse: number
    overlap: number
    correlation: number
  }
  const windows: WindowResult[] = []

  for (let startSec = 0; startSec + windowLenSec <= len; startSec += strideSec) {
    const { best } = bestOffsetForWindow(
      ref, other, metric, otherTsIndex, 60, startSec, startSec + windowLenSec,
    )
    windows.push({
      offset: best.offset,
      sse: best.normalizedSSE,
      overlap: best.overlap,
      correlation: best.correlation,
    })
    if (startSec + strideSec + windowLenSec > len) break // last window
  }

  // Find the first run of MIN_CONSECUTIVE_WINDOWS consecutive windows that
  // agree on the same offset and have adequate quality.
  for (let i = 0; i <= windows.length - MIN_CONSECUTIVE_WINDOWS; i++) {
    const w0 = windows[i]
    if (w0.sse > SSE_FAILURE_THRESHOLD || w0.overlap < MIN_OVERLAP_SECONDS) continue

    let ok = true
    for (let j = 1; j < MIN_CONSECUTIVE_WINDOWS; j++) {
      const wj = windows[i + j]
      if (
        Math.abs(wj.offset - w0.offset) > OFFSET_TOLERANCE
        || wj.sse > SSE_FAILURE_THRESHOLD
        || wj.overlap < MIN_OVERLAP_SECONDS
      ) {
        ok = false
        break
      }
    }
    if (ok) {
      // Bias-to-zero gate: re-score the agreed offset and zero over the
      // full timeline.  The window-level quality (w0) is the one that
      // matters for the acceptance gate; full-timeline scores are only
      // used for the zero-bias comparison.
      const full = scoreOffset(
        ref, other, metric, otherTsIndex, w0.offset, 0, len,
      )
      const zeroFull = scoreOffset(ref, other, metric, otherTsIndex, 0, 0, len)

      if (
        w0.offset !== 0
        && Number.isFinite(zeroFull.normalizedSSE)
        && full.normalizedSSE >= zeroFull.normalizedSSE * ZERO_OFFSET_MARGIN
      ) {
        return zeroFull
      }

      // Return the window-level quality, not the full-timeline quality.
      return {
        offset: w0.offset,
        normalizedSSE: w0.sse,
        overlap: w0.overlap,
        correlation: w0.correlation,
      }
    }
  }

  // Fallback: whole-trace scan (±60 s) with bias-to-zero
  const { best, zero } = bestOffsetForWindow(
    ref, other, metric, otherTsIndex, 60, 0, len,
  )
  if (
    best.offset !== 0
    && Number.isFinite(zero.normalizedSSE)
    && best.normalizedSSE >= zero.normalizedSSE * ZERO_OFFSET_MARGIN
  ) {
    return zero
  }
  return best
}

// ─── PASS 2 & 3: Iterative pause scanning and re-anchoring ────────────────

/**
 * Internal pause candidate returned by `findNextInternalPause`.
 * `startIdx` is the first ref-grid index of the gap;
 * `endIdxExclusive` is the first ref-grid index *after* the gap (the resume point).
 */
interface PauseCandidate {
  startIdx: number
  endIdxExclusive: number
  gapFile: 'ref' | 'other'
}

/**
 * Look up the other-file value aligned to a given ref-grid index under a
 * specific offset.  Returns null if no corresponding local tick exists or
 * the value itself is null.
 */
function otherValueAt(
  other: ResampledSeries,
  metric: MetricKey,
  otherTsIndex: Map<number, number>,
  offsetSeconds: number,
  refIdx: number,
  refTs: number[],
): number | null {
  const otherTs = refTs[refIdx] - offsetSeconds * 1000
  const oi = otherTsIndex.get(otherTs)
  if (oi === undefined) return null
  return other.values[metric][oi]
}

/**
 * Count non-null overlapping pairs between ref and other over a range of
 * ref-grid indices, using the given offset.
 */
function countOverlap(
  ref: ResampledSeries,
  other: ResampledSeries,
  metric: MetricKey,
  otherTsIndex: Map<number, number>,
  offsetSeconds: number,
  refStartIdx: number,
  refEndIdx: number,
): number {
  let count = 0
  const refValues = ref.values[metric]
  const refTs = ref.timestamps
  const end = Math.min(refEndIdx, refTs.length)
  for (let i = refStartIdx; i < end; i++) {
    if (refValues[i] === null) continue
    const ov = otherValueAt(other, metric, otherTsIndex, offsetSeconds, i, refTs)
    if (ov !== null) count++
  }
  return count
}

/**
 * Scan forward from `refStartIdx` under `currentOffset` and return the next
 * *internal* pause candidate, or null if none exists.
 *
 * A pause is "internal" only when:
 *  1. Sufficient mutual overlap (≥ MIN_OVERLAP_SECONDS) has been observed
 *     before the gap.  Leading extent gaps (file B starts later than file A)
 *     are ignored.
 *  2. The gap duration is ≥ PAUSE_GAP_THRESHOLD_SECONDS.
 *  3. After the gap, the missing file resumes with at least a minimum
 *     amount of overlap.  Trailing extent gaps (file B ends before file A
 *     and never resumes) are ignored.
 *
 * D4 (Option B): each call uses the caller-supplied `currentOffset`, so the
 * scanner sees the correct offset after a previous re-anchor.
 * D5 (Option C): leading and trailing extent gaps are filtered.
 */
function findNextInternalPause(
  ref: ResampledSeries,
  other: ResampledSeries,
  metric: MetricKey,
  otherTsIndex: Map<number, number>,
  currentOffset: number,
  refStartIdx: number,
): PauseCandidate | null {
  const refValues = ref.values[metric]
  const refTs = ref.timestamps
  const len = refTs.length
  const offsetMs = currentOffset * 1000

  // Phase A: require established overlap before any pause is considered internal.
  // Scan ahead up to MIN_OVERLAP_SECONDS + PAUSE_GAP_THRESHOLD_SECONDS to see
  // whether we ever get mutual data.
  const probeEnd = Math.min(refStartIdx + MIN_OVERLAP_SECONDS + PAUSE_GAP_THRESHOLD_SECONDS, len)
  const preOverlap = countOverlap(ref, other, metric, otherTsIndex, currentOffset, refStartIdx, probeEnd)
  if (preOverlap < MIN_OVERLAP_SECONDS) {
    // Not enough evidence that the two files share data in this region.
    return null
  }

  // Phase B: walk forward looking for a gap in one file while the other has data.
  let inPause = false
  let pauseStart = 0
  let gapFile: 'ref' | 'other' = 'ref'

  const flush = (endIdx: number): PauseCandidate | null => {
    const duration = endIdx - pauseStart
    if (duration < PAUSE_GAP_THRESHOLD_SECONDS) return null

    // Phase C: verify the missing file actually resumes after this gap.
    // Score a short window after the gap to see whether there is resumed overlap.
    const resumeWindowEnd = Math.min(endIdx + PASS3_MIN_OVERLAP_SECONDS, len)
    const postOverlap = countOverlap(
      ref, other, metric, otherTsIndex, currentOffset, endIdx, resumeWindowEnd,
    )
    if (postOverlap === 0) {
      // Trailing extent gap -- the missing file never comes back.  Do not
      // treat this as an internal pause.
      return null
    }

    return { startIdx: pauseStart, endIdxExclusive: endIdx, gapFile }
  }

  for (let i = refStartIdx; i < len; i++) {
    const rv = refValues[i]
    const otherTs = refTs[i] - offsetMs
    const oi = otherTsIndex.get(otherTs)
    const ov = oi !== undefined ? other.values[metric][oi] : null

    const refHas = rv !== null
    const otherHas = ov !== null

    if (refHas && !otherHas) {
      if (!inPause || gapFile !== 'other') {
        if (inPause) {
          const result = flush(i)
          if (result) return result
        }
        inPause = true
        pauseStart = i
        gapFile = 'other'
      }
    }
    else if (!refHas && otherHas) {
      if (!inPause || gapFile !== 'ref') {
        if (inPause) {
          const result = flush(i)
          if (result) return result
        }
        inPause = true
        pauseStart = i
        gapFile = 'ref'
      }
    }
    else {
      if (inPause) {
        const result = flush(i)
        if (result) return result
        inPause = false
      }
    }
  }

  // End of file reached while in a pause — this is a trailing extent gap, skip it.
  return null
}

/**
 * Search for the best post-pause offset, applying D3 gates.
 * Returns the new offset if a better one is found, else returns the
 * current offset unchanged.
 */
function reanchorAfterPause(
  ref: ResampledSeries,
  other: ResampledSeries,
  metric: MetricKey,
  otherTsIndex: Map<number, number>,
  currentOffset: number,
  resumeIdx: number,
): number {
  const refEndIdx = Math.min(resumeIdx + PASS3_WINDOW_SECONDS, ref.timestamps.length)
  if (refEndIdx <= resumeIdx) return currentOffset

  const currentScore = scoreOffset(
    ref, other, metric, otherTsIndex, currentOffset, resumeIdx, refEndIdx,
  )

  let bestCandidate: ScoreResult | null = null
  for (let off = -PASS3_SEARCH_SECONDS; off <= PASS3_SEARCH_SECONDS; off++) {
    const s = scoreOffset(ref, other, metric, otherTsIndex, off, resumeIdx, refEndIdx)
    if (s.normalizedSSE < (bestCandidate?.normalizedSSE ?? Infinity)) {
      bestCandidate = s
    }
  }

  if (!bestCandidate) return currentOffset

  // D3 gates: overlap, quality, improvement
  if (bestCandidate.overlap < PASS3_MIN_OVERLAP_SECONDS) return currentOffset
  if (bestCandidate.normalizedSSE > SSE_FAILURE_THRESHOLD) return currentOffset
  if (
    Number.isFinite(currentScore.normalizedSSE)
    && bestCandidate.normalizedSSE >= currentScore.normalizedSSE * IMPROVEMENT_MARGIN
  ) return currentOffset

  return bestCandidate.offset
}

interface OffsetChangeCandidate {
  startIdx: number
  offset: number
  score: ScoreResult
}

/**
 * Find the next sustained offset-regime change without requiring a null gap.
 *
 * Some devices record pause-like sections as zero or otherwise low-quality
 * data rather than leaving null gaps.  In those cases `findNextInternalPause`
 * sees no gap, but the current offset's fit collapses and a different offset
 * becomes stable over consecutive windows.  This detector uses short windows
 * so it can catch those late changes without smearing them over the rest of
 * the file.
 */
function findNextOffsetChange(
  ref: ResampledSeries,
  other: ResampledSeries,
  metric: MetricKey,
  otherTsIndex: Map<number, number>,
  currentOffset: number,
  refStartIdx: number,
): OffsetChangeCandidate | null {
  let runOffset = 0
  let runStartIdx = 0
  let runCount = 0
  let runScore: ScoreResult | null = null

  const maxStart = ref.timestamps.length - REGIME_WINDOW_SECONDS
  for (let startIdx = refStartIdx; startIdx <= maxStart; startIdx += REGIME_STRIDE_SECONDS) {
    const currentScore = scoreOffset(
      ref, other, metric, otherTsIndex, currentOffset,
      startIdx, startIdx + REGIME_WINDOW_SECONDS,
    )
    const { best } = bestOffsetForWindow(
      ref, other, metric, otherTsIndex, PASS3_SEARCH_SECONDS,
      startIdx, startIdx + REGIME_WINDOW_SECONDS,
    )

    const reliable =
      Math.abs(best.offset - currentOffset) > OFFSET_TOLERANCE
      && best.overlap >= REGIME_MIN_OVERLAP_SECONDS
      && best.normalizedSSE <= SSE_FAILURE_THRESHOLD
      && Number.isFinite(currentScore.normalizedSSE)
      && best.normalizedSSE <= currentScore.normalizedSSE * IMPROVEMENT_MARGIN

    if (!reliable) {
      runCount = 0
      runScore = null
      continue
    }

    if (runCount > 0 && Math.abs(best.offset - runOffset) <= OFFSET_TOLERANCE) {
      runCount++
    }
    else {
      runOffset = best.offset
      runStartIdx = startIdx
      runCount = 1
      runScore = best
    }

    if (runCount >= REGIME_MIN_CONSECUTIVE_WINDOWS && runScore) {
      return { startIdx: runStartIdx, offset: runOffset, score: runScore }
    }
  }

  return null
}

/**
 * Build the segment partition for 'other' against 'ref' using an iterative
 * state machine.
 *
 * D4 (Option B): after each accepted re-anchor the scanner continues under
 * the new offset, so every later pause is detected correctly.
 * D5 (Option C): leading and trailing extent gaps are ignored.
 * D6 (Option B): a new segment is emitted only when the offset changes
 * (by more than OFFSET_TOLERANCE).  Adjacent segments with the same offset
 * are coalesced at the end.
 */
function buildSegmentsIteratively(
  ref: ResampledSeries,
  other: ResampledSeries,
  metric: MetricKey,
  initialOffset: number,
): OffsetSegment[] {
  const otherTs = other.timestamps
  if (otherTs.length === 0) {
    return [{ fromTime: 0, toTime: 0, offsetSeconds: initialOffset }]
  }

  const otherTsIndex = buildTsIndex(other)
  const segments: OffsetSegment[] = []
  let currentOffset = initialOffset
  let refCursor = 0
  let localStart = otherTs[0]
  let allowRecordedRegimeChanges = false

  // If the other file starts after the ref, skip the leading ref ticks
  // that have no matching other data.  This prevents a leading extent gap
  // from being treated as a pause.
  const firstOverlap = countOverlap(
    ref, other, metric, otherTsIndex, currentOffset, 0,
    Math.min(MIN_OVERLAP_SECONDS, ref.timestamps.length),
  )
  if (firstOverlap === 0 && ref.timestamps.length > MIN_OVERLAP_SECONDS) {
    // Advance refCursor to the first ref tick that maps to otherTs[0]
    for (let i = 0; i < ref.timestamps.length; i++) {
      const otherTick = ref.timestamps[i] - currentOffset * 1000
      if (otherTick >= otherTs[0]) {
        refCursor = i
        break
      }
    }
  }

  // Main loop: scan iteratively for either a null-gap pause or a sustained
  // offset-regime change from recorded pause-like data.
  while (refCursor < ref.timestamps.length) {
    const pause = findNextInternalPause(
      ref, other, metric, otherTsIndex, currentOffset, refCursor,
    )
    const offsetChange = allowRecordedRegimeChanges
      ? findNextOffsetChange(ref, other, metric, otherTsIndex, currentOffset, refCursor)
      : null

    if (!pause && !offsetChange) {
      // No more internal pauses or stable offset changes — emit the final
      // segment covering localStart through the other file's end.
      if (localStart <= otherTs[otherTs.length - 1]) {
        segments.push({
          fromTime: localStart,
          toTime: otherTs[otherTs.length - 1],
          offsetSeconds: currentOffset,
        })
      }
      break
    }

    const useOffsetChange = offsetChange !== null
      && (pause === null || offsetChange.startIdx < pause.startIdx)

    const eventStartIdx = useOffsetChange ? offsetChange!.startIdx : pause!.startIdx
    const resumeIdx = useOffsetChange ? offsetChange!.startIdx : pause!.endIdxExclusive
    const newOffset = useOffsetChange
      ? offsetChange!.offset
      : reanchorAfterPause(ref, other, metric, otherTsIndex, currentOffset, resumeIdx)

    if (!useOffsetChange) {
      // Once we have seen a real internal null-gap pause, permit later
      // recorded-data regime detection.  This prevents early false matches
      // in repeated workout shapes before any pause evidence exists.
      allowRecordedRegimeChanges = true
    }

    if (useOffsetChange && newOffset < currentOffset - OFFSET_TOLERANCE) {
      // A decrease in offset without a real local gap would make this file's
      // aligned timeline run backwards and usually means a repeated workout
      // shape has produced a false match.  Real decreases are handled through
      // null-gap pauses (especially gapFile='other'), not through recorded-data
      // regime detection.
      refCursor = Math.max(eventStartIdx + REGIME_STRIDE_SECONDS, refCursor + 1)
      continue
    }

    if (Math.abs(newOffset - currentOffset) <= OFFSET_TOLERANCE) {
      // Same-offset pause: do not split.  Advance past the event and keep
      // growing the current segment.
      refCursor = Math.max(resumeIdx + 1, refCursor + 1)
      continue
    }

    // A real offset change.  For a null-gap pause, close the old segment at
    // the pause start under the old offset.  For a recorded-data regime
    // change, the matched reference window belongs to the new offset, so the
    // new segment must start at refEventStart - newOffset.  Using the old
    // offset here leaves the first part of the newly matched shape in the old
    // segment and causes the visible late-cutover bug.
    const refEventStartTs = ref.timestamps[eventStartIdx]
    const nextLocalStartTs = useOffsetChange
      ? refEventStartTs - newOffset * 1000
      : ref.timestamps[Math.min(resumeIdx, ref.timestamps.length - 1)] - newOffset * 1000
    const localEndTarget = nextLocalStartTs - 1000
    const localEndIdx = findClosestLocalIdx(otherTs, localEndTarget, 'atOrBefore')
    const localEnd = otherTs[localEndIdx]

    if (localStart <= localEnd) {
      segments.push({
        fromTime: localStart,
        toTime: localEnd,
        offsetSeconds: currentOffset,
      })
    }

    currentOffset = newOffset
    const nextLocalStartIdx = findClosestLocalIdx(otherTs, nextLocalStartTs, 'atOrAfter')
    localStart = Math.max(otherTs[nextLocalStartIdx], localEnd + 1000)
    refCursor = Math.max(resumeIdx, eventStartIdx + 1)
  }

  // Coalesce adjacent segments with the same offset (D6, Option B).
  return coalesceSegments(segments, otherTs)
}

/**
 * Merge adjacent segments that share the same offset.  Also clamps the
 * first segment's start to otherTs[0] and the last segment's end to
 * otherTs[otherTs.length - 1], ensuring full local coverage.
 */
function coalesceSegments(
  segments: OffsetSegment[],
  otherTs: number[],
): OffsetSegment[] {
  if (segments.length <= 1) return segments

  const merged: OffsetSegment[] = []
  let current = segments[0]

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i]
    if (
      next.offsetSeconds === current.offsetSeconds
      // Adjacent: next.fromTime should be current.toTime + 1000
      && next.fromTime <= current.toTime + 1000
    ) {
      // Merge: extend current's end to next's end
      current = { ...current, toTime: next.toTime }
    }
    else {
      merged.push(current)
      current = next
    }
  }
  merged.push(current)

  // Clamp bounds to the other file's extent
  if (merged.length > 0 && otherTs.length > 0) {
    if (merged[0].fromTime < otherTs[0]) {
      merged[0] = { ...merged[0], fromTime: otherTs[0] }
    }
    const last = merged.length - 1
    if (merged[last].toTime < otherTs[otherTs.length - 1]) {
      merged[last] = { ...merged[last], toTime: otherTs[otherTs.length - 1] }
    }
  }

  return merged
}

// ─── Index helpers ────────────────────────────────────────────────────────

/**
 * Find the index in `timestamps` that is closest to `target`.
 * `mode`:
 *   - 'atOrBefore': largest index where timestamps[i] ≤ target
 *   - 'atOrAfter':  smallest index where timestamps[i] ≥ target
 */
function findClosestLocalIdx(
  timestamps: number[],
  target: number,
  mode: 'atOrBefore' | 'atOrAfter',
): number {
  if (timestamps.length === 0) return 0
  let lo = 0
  let hi = timestamps.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (timestamps[mid] < target) lo = mid + 1
    else hi = mid
  }
  if (mode === 'atOrBefore') {
    while (lo > 0 && timestamps[lo] > target) lo--
  }
  else {
    while (lo < timestamps.length - 1 && timestamps[lo] < target) lo++
  }
  return lo
}

// ─── MAIN API ─────────────────────────────────────────────────────────────

export function alignPair(
  ref: ResampledSeries,
  other: ResampledSeries,
): AlignmentResult {
  const failedResult = (warning: string): AlignmentResult => ({
    status: 'failed',
    segments: other.timestamps.length > 0
      ? [{
          fromTime: other.timestamps[0],
          toTime: other.timestamps[other.timestamps.length - 1],
          offsetSeconds: 0,
        }]
      : [],
    warning,
  })

  if (ref.timestamps.length === 0 || other.timestamps.length === 0) {
    return failedResult('Empty trace — cannot align')
  }

  const metric = pickAlignmentMetric(ref, other)
  if (!metric) {
    return failedResult('No common alignment metric (power, HR, or speed) found in both files')
  }

  // Pass 1: Initial anchor via consecutive reliable windows
  const anchor = findInitialAnchor(ref, other, metric)

  if (
    anchor.normalizedSSE >= SSE_FAILURE_THRESHOLD
    || anchor.overlap < MIN_OVERLAP_SECONDS
  ) {
    return failedResult(
      `Could not find reliable alignment (residual ratio=${anchor.normalizedSSE.toFixed(2)}, overlap=${anchor.overlap}s)`,
    )
  }

  // Pass 2 & 3: Iterative pause scanning and re-anchoring
  const segments = buildSegmentsIteratively(ref, other, metric, anchor.offset)

  if (segments.length === 0) {
    return failedResult('No valid segments after alignment')
  }

  return {
    status: segments.length > 1 ? 'warning' : 'ok',
    segments,
  }
}

export function alignAll(
  series: ResampledSeries[],
  referenceIndex: number,
): Map<number, AlignmentResult> {
  const results = new Map<number, AlignmentResult>()
  const ref = series[referenceIndex]

  if (ref.timestamps.length > 0) {
    results.set(referenceIndex, {
      status: 'ok',
      segments: [
        {
          fromTime: ref.timestamps[0],
          toTime: ref.timestamps[ref.timestamps.length - 1],
          offsetSeconds: 0,
        },
      ],
    })
  }

  for (let i = 0; i < series.length; i++) {
    if (i === referenceIndex) continue
    results.set(i, alignPair(ref, series[i]))
  }

  return results
}
