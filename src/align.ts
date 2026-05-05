import type { ResampledSeries, OffsetSegment, AlignmentResult, MetricKey } from './types'
import { ALIGNMENT_METRIC_FALLBACK } from './types'

/** Configurable constants */
const SEARCH_WINDOW_SECONDS = 300 // ±5 minutes
const PASS3_SEARCH_WINDOW_SECONDS = 30 // ±30 seconds
const MIN_OVERLAP_SECONDS = 30
const PASS3_MIN_OVERLAP_SECONDS = 10
const PAUSE_GAP_THRESHOLD_SECONDS = 10
const SSE_FAILURE_THRESHOLD = 0.5

/**
 * Pick the best alignment metric available in both series.
 * Falls back: power -> HR -> speed.
 * Returns null if none are available in both.
 */
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
 * Get the aligned trace for a given metric, applying a time offset.
 * Returns an array of (value | null) at 1 Hz ticks aligned to the reference grid.
 *
 * The reference grid is defined by ref.timestamps.
 * For each ref tick t, look up other's value at t - offsetSeconds * 1000.
 */
function getAlignedTrace(
  ref: ResampledSeries,
  other: ResampledSeries,
  metric: MetricKey,
  offsetSeconds: number,
): (number | null)[] {
  const offsetMs = offsetSeconds * 1000
  const otherTimeSet = new Map<number, number | null>()
  for (let i = 0; i < other.timestamps.length; i++) {
    otherTimeSet.set(other.timestamps[i], other.values[metric][i])
  }

  const result: (number | null)[] = []
  for (const refTs of ref.timestamps) {
    const otherTs = refTs - offsetMs
    result.push(otherTimeSet.get(otherTs) ?? null)
  }
  return result
}

/**
 * Compute normalised SSE between two aligned traces.
 * Returns SSE / overlapLength, or Infinity if overlap is too short or no valid pairs.
 */
function normalizedSSE(
  refValues: (number | null)[],
  otherValues: (number | null)[],
): number {
  let sse = 0
  let overlap = 0
  for (let i = 0; i < refValues.length; i++) {
    if (refValues[i] !== null && otherValues[i] !== null) {
      sse += (refValues[i]! - otherValues[i]!) ** 2
      overlap++
    }
  }
  if (overlap === 0) return Infinity
  return sse / overlap
}

/**
 * Count the overlapping points where both traces have non-null values.
 */
function overlapLength(
  refValues: (number | null)[],
  otherValues: (number | null)[],
): number {
  let count = 0
  for (let i = 0; i < refValues.length; i++) {
    if (refValues[i] !== null && otherValues[i] !== null) count++
  }
  return count
}

// ─── PASS 1: Global offset via cross-correlation ──────────────────────────

function findGlobalOffset(
  ref: ResampledSeries,
  other: ResampledSeries,
  metric: MetricKey,
  windowSeconds: number,
): { offset: number; bestSSE: number } {
  let bestOffset = 0
  let bestSSE = Infinity

  for (let offset = -windowSeconds; offset <= windowSeconds; offset++) {
    const aligned = getAlignedTrace(ref, other, metric, offset)
    const sse = normalizedSSE(ref.values[metric], aligned)
    if (sse < bestSSE) {
      bestSSE = sse
      bestOffset = offset
    }
  }

  return { offset: bestOffset, bestSSE }
}

// ─── PASS 2: Detect pause regions ─────────────────────────────────────────

interface PauseRegion {
  /** Start index in the ref grid */
  startIdx: number
  /** End index (exclusive) in the ref grid */
  endIdx: number
  /** Which file has the gap: 'ref' or 'other' */
  gapFile: 'ref' | 'other'
}

function detectPauses(
  ref: ResampledSeries,
  other: ResampledSeries,
  metric: MetricKey,
  globalOffset: number,
  thresholdSeconds: number,
): PauseRegion[] {
  const refValues = ref.values[metric]
  const otherAligned = getAlignedTrace(ref, other, metric, globalOffset)
  const len = refValues.length
  const pauses: PauseRegion[] = []

  let inPause = false
  let pauseStart = 0
  let gapFile: 'ref' | 'other' = 'ref'

  for (let i = 0; i < len; i++) {
    const refVal = refValues[i]
    const otherVal = otherAligned[i]

    const refHas = refVal !== null
    const otherHas = otherVal !== null

    if (refHas && !otherHas) {
      // Other file has a gap
      if (!inPause || gapFile !== 'other') {
        if (inPause) {
          // Flush previous pause (ref gap)
          const duration = i - pauseStart
          if (duration >= thresholdSeconds) {
            pauses.push({ startIdx: pauseStart, endIdx: i, gapFile })
          }
        }
        inPause = true
        pauseStart = i
        gapFile = 'other'
      }
    }
    else if (!refHas && otherHas) {
      // Ref file has a gap
      if (!inPause || gapFile !== 'ref') {
        if (inPause) {
          const duration = i - pauseStart
          if (duration >= thresholdSeconds) {
            pauses.push({ startIdx: pauseStart, endIdx: i, gapFile })
          }
        }
        inPause = true
        pauseStart = i
        gapFile = 'ref'
      }
    }
    else {
      // Both have data or both are null
      if (inPause) {
        const duration = i - pauseStart
        if (duration >= thresholdSeconds) {
          pauses.push({ startIdx: pauseStart, endIdx: i, gapFile })
        }
        inPause = false
      }
    }
  }

  // Handle trailing pause
  if (inPause) {
    const duration = len - pauseStart
    if (duration >= thresholdSeconds) {
      pauses.push({ startIdx: pauseStart, endIdx: len, gapFile })
    }
  }

  return pauses
}

// ─── PASS 3: Re-anchor post-pause segments ────────────────────────────────

function reanchorSegments(
  ref: ResampledSeries,
  other: ResampledSeries,
  metric: MetricKey,
  globalOffset: number,
  pauses: PauseRegion[],
): OffsetSegment[] {
  const refTimestamps = ref.timestamps
  const len = refTimestamps.length

  if (len === 0) {
    return [{ fromTime: 0, toTime: 0, offsetSeconds: globalOffset }]
  }

  const segments: OffsetSegment[] = []

  // Find the segments: regions between pauses
  // Segment 0: from start to first pause start (or end if no pauses)
  // After each pause: from pause end to next pause start (or end)

  const breakpoints: number[] = [0]
  for (const pause of pauses) {
    breakpoints.push(pause.startIdx, pause.endIdx)
  }
  breakpoints.push(len)

  // Walk the breakpoints in pairs: [bp[0], bp[1]], [bp[2], bp[3]], ...
  // Each pair is a segStart, segEnd
  let currentOffset = globalOffset

  for (let b = 0; b < breakpoints.length - 1; b += 2) {
    const segStart = breakpoints[b]
    const segEnd = breakpoints[b + 1]

    if (segEnd <= segStart) continue

    const fromTime = refTimestamps[segStart]
    const toTime = segEnd < len ? refTimestamps[segEnd - 1] : refTimestamps[len - 1]

    // For the first segment, use the global offset
    if (b === 0) {
      segments.push({ fromTime, toTime, offsetSeconds: currentOffset })
      continue
    }

    // This is a post-pause segment. Cross-correlate to find correction.
    // Take the portion of ref and other from segStart to segEnd
    const refSlice = sliceSeries(ref, segStart, segEnd)
    const otherSlice = sliceSeries(other, segStart, segEnd)

    // The otherSlice is at the other file's original times. We need to
    // cross-correlate with refSlice to find the best offset.
    if (refSlice.timestamps.length >= PASS3_MIN_OVERLAP_SECONDS) {
      const { offset: correction, bestSSE } = findGlobalOffset(
        refSlice,
        otherSlice,
        metric,
        PASS3_SEARCH_WINDOW_SECONDS,
      )

      const aligned = getAlignedTrace(refSlice, otherSlice, metric, correction)
      const overlap = overlapLength(refSlice.values[metric], aligned)

      if (bestSSE < SSE_FAILURE_THRESHOLD && overlap >= PASS3_MIN_OVERLAP_SECONDS) {
        currentOffset = correction
      }
      // else: keep currentOffset unchanged (no correction for this segment)
    }

    segments.push({ fromTime, toTime, offsetSeconds: currentOffset })
  }

  return segments
}

function sliceSeries(
  series: ResampledSeries,
  startIdx: number,
  endIdx: number,
): ResampledSeries {
  const timestamps = series.timestamps.slice(startIdx, endIdx)
  const values = {} as Record<MetricKey, (number | null)[]>
  for (const key of Object.keys(series.values) as MetricKey[]) {
    values[key] = series.values[key].slice(startIdx, endIdx)
  }
  return { timestamps, values }
}

// ─── MAIN API ─────────────────────────────────────────────────────────────

/**
 * Align one file (other) against a reference file (ref).
 * Uses the three-pass algorithm:
 *   Pass 1: Global cross-correlation for initial offset
 *   Pass 2: Pause detection in aligned traces
 *   Pass 3: Re-anchor post-pause segments
 *
 * Returns an AlignmentResult with per-file OffsetSegment[].
 */
export function alignPair(
  ref: ResampledSeries,
  other: ResampledSeries,
): AlignmentResult {
  if (
    ref.timestamps.length === 0
    || other.timestamps.length === 0
  ) {
    return { status: 'failed', segments: [], warning: 'Empty trace — cannot align' }
  }

  const metric = pickAlignmentMetric(ref, other)
  if (!metric) {
    return {
      status: 'failed',
      segments: [],
      warning: 'No common alignment metric (power, HR, or speed) found in both files',
    }
  }

  // Pass 1: Global offset
  const { offset: globalOffset, bestSSE } = findGlobalOffset(
    ref, other, metric, SEARCH_WINDOW_SECONDS,
  )

  const aligned = getAlignedTrace(ref, other, metric, globalOffset)
  const overlap = overlapLength(ref.values[metric], aligned)

  if (bestSSE >= SSE_FAILURE_THRESHOLD || overlap < MIN_OVERLAP_SECONDS) {
    return {
      status: 'failed',
      segments: [],
      warning: `Could not find reliable alignment (SSE=${bestSSE.toFixed(2)}, overlap=${overlap}s)`,
    }
  }

  // Pass 2: Pause detection
  const pauses = detectPauses(ref, other, metric, globalOffset, PAUSE_GAP_THRESHOLD_SECONDS)

  // Pass 3: Segment re-anchoring
  const segments = reanchorSegments(ref, other, metric, globalOffset, pauses)

  return {
    status: pauses.length > 0 ? 'warning' : 'ok',
    segments,
  }
}

/**
 * Align multiple files against a reference file.
 * The reference file must be one of the provided series.
 * Returns a Map of file index -> AlignmentResult.
 */
export function alignAll(
  series: ResampledSeries[],
  referenceIndex: number,
): Map<number, AlignmentResult> {
  const results = new Map<number, AlignmentResult>()
  const ref = series[referenceIndex]

  // Reference file always has zero offset
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
