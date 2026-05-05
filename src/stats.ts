import type { ResampledSeries, MetricKey, AlignmentResult } from './types'

const MPE_EPSILON = 0.01

export interface FileStats {
  mean: number | null
  max: number | null
  min: number | null
  stddev: number | null
  n: number
}

export interface PairwiseStats {
  r: number | null
  mae: number | null
  mpe: number | null
  n: number
}

/**
 * Compute per-file descriptive statistics from resampled data.
 * Only uses the 1 Hz grid, ignoring nulls.
 */
export function computeFileStats(
  series: ResampledSeries,
  metric: MetricKey,
): FileStats {
  const values = series.values[metric]
  const nonNull = values.filter((v): v is number => v !== null)

  if (nonNull.length === 0) {
    return { mean: null, max: null, min: null, stddev: null, n: 0 }
  }

  const n = nonNull.length
  const sum = nonNull.reduce((a, b) => a + b, 0)
  const mean = sum / n
  const max = Math.max(...nonNull)
  const min = Math.min(...nonNull)

  const variance =
    nonNull.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n
  const stddev = Math.sqrt(variance)

  return { mean, max, min, stddev, n }
}

/**
 * Check if a timestamp falls inside any pause region of a file.
 * A timestamp is "in a pause" if it's inside a gap that the other file has.
 * Here we just check if the timestamp is inside any OffsetSegment gap.
 *
 * For pause exclusion: we use the AlignmentResult segments.
 * A pause exists between segments when timestamps don't have contiguous offset.
 * We don't directly use OffsetSegment for pause detection — instead,
 * we detect pauses from the gap file's null runs in the resampled data.
 */
function timestampInPause(
  timestamp: number,
  alignment: AlignmentResult | null,
): boolean {
  if (!alignment || alignment.segments.length <= 1) return false

  // Check if this timestamp falls between any segment boundaries
  // Segments are contiguous: seg[i].toTime < seg[i+1].fromTime means a gap
  const segments = alignment.segments
  for (let i = 0; i < segments.length - 1; i++) {
    if (timestamp > segments[i].toTime && timestamp < segments[i + 1].fromTime) {
      return true
    }
  }

  return false
}

/**
 * Get the aligned value at a given reference-grid timestamp for a file.
 */
function getAlignedValue(
  series: ResampledSeries,
  metric: MetricKey,
  refTimestamp: number,
  alignment: AlignmentResult | null,
  tsIndex?: Map<number, number>,
): number | null {
  // Apply alignment offset to determine what local timestamp to look up
  const segments = alignment?.segments ?? []
  let localTs = refTimestamp

  // Find which segment this refTimestamp falls into and subtract the offset
  for (const seg of segments) {
    if (refTimestamp >= seg.fromTime && refTimestamp <= seg.toTime) {
      localTs = refTimestamp - seg.offsetSeconds * 1000
      break
    }
  }

  // If refTimestamp is before first segment, subtract first segment's offset
  if (segments.length > 0 && refTimestamp < segments[0].fromTime) {
    localTs = refTimestamp - segments[0].offsetSeconds * 1000
  }
  // If after last segment, use last segment's offset
  if (
    segments.length > 0
    && refTimestamp > segments[segments.length - 1].toTime
  ) {
    localTs =
      refTimestamp - segments[segments.length - 1].offsetSeconds * 1000
  }

  // Use pre-built index map when available (O(1)), fall back to indexOf (O(n))
  const idx = tsIndex
    ? (tsIndex.get(localTs) ?? -1)
    : series.timestamps.indexOf(localTs)
  if (idx === -1) return null
  return series.values[metric][idx]
}

/**
 * Compute pairwise statistics between two aligned resampled series.
 * Uses rules:
 * (a) Common grid only — both must have non-null at the timestamp
 * (b) Nulls excluded pairwise
 * (c) Pause regions excluded
 * (d) Zeros kept
 * (e) MPE excludes rows where ref value < epsilon
 *
 * The "ref" series uses index 0 (first uploaded file) for MPE.
 */
export function computePairwiseStats(
  refSeries: ResampledSeries,
  otherSeries: ResampledSeries,
  metric: MetricKey,
  refAlignment: AlignmentResult | null,
  otherAlignment: AlignmentResult | null,
): PairwiseStats {
  const refValues = refSeries.values[metric]
  const refTimestamps = refSeries.timestamps

  // Pre-build timestamp -> index map for O(1) lookup in getAlignedValue
  const otherTsIndex = new Map<number, number>()
  for (let i = 0; i < otherSeries.timestamps.length; i++) {
    otherTsIndex.set(otherSeries.timestamps[i], i)
  }

  // Build aligned pairs
  const pairs: { ref: number; other: number }[] = []

  for (let i = 0; i < refTimestamps.length; i++) {
    const refVal = refValues[i]
    if (refVal === null) continue

    const ts = refTimestamps[i]

    // Skip if ref is in a pause
    if (timestampInPause(ts, refAlignment)) continue

    const otherVal = getAlignedValue(otherSeries, metric, ts, otherAlignment, otherTsIndex)
    if (otherVal === null) continue

    // Skip if other is in a pause
    if (timestampInPause(ts, otherAlignment)) continue

    pairs.push({ ref: refVal, other: otherVal })
  }

  if (pairs.length < 2) {
    return { r: null, mae: null, mpe: null, n: pairs.length }
  }

  const n = pairs.length

  // Pearson r
  const sumX = pairs.reduce((s, p) => s + p.ref, 0)
  const sumY = pairs.reduce((s, p) => s + p.other, 0)
  const sumXY = pairs.reduce((s, p) => s + p.ref * p.other, 0)
  const sumX2 = pairs.reduce((s, p) => s + p.ref * p.ref, 0)
  const sumY2 = pairs.reduce((s, p) => s + p.other * p.other, 0)

  const numR = n * sumXY - sumX * sumY
  const denR = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY),
  )
  const r = denR === 0 ? null : numR / denR

  // MAE
  const mae =
    pairs.reduce((s, p) => s + Math.abs(p.ref - p.other), 0) / n

  // MPE (reference = first file = ref)
  let mpeSum = 0
  let mpeCount = 0
  for (const p of pairs) {
    if (Math.abs(p.ref) >= MPE_EPSILON) {
      mpeSum += Math.abs((p.ref - p.other) / p.ref) * 100
      mpeCount++
    }
  }
  const mpe = mpeCount > 0 ? mpeSum / mpeCount : null

  return { r, mae, mpe, n }
}
