import type { ResampledSeries, MetricKey, AlignmentResult } from './types'
import {
  alignedToLocal,
  alignedRangeToLocalWindows,
  isInPause,
} from './alignmentTime'

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

export type ComparisonConclusion =
  | 'equivalent'
  | 'different'
  | 'inconclusive'
  | 'insufficient-data'

export interface ComparisonOptions {
  range?: { fromTime: number; toTime: number }
  marginPercent: number
  marginFloor: number
}

export interface ComparisonStats {
  grandMean: number | null
  bias: number | null
  biasPercent: number | null
  sdDiff: number | null
  loaLower: number | null
  loaUpper: number | null
  loaLowerPercent: number | null
  loaUpperPercent: number | null
  equivalenceMargin: number | null
  equivalenceMarginPercent: number | null
  marginFloorApplied: boolean | null
  ciLower: number | null
  ciUpper: number | null
  conclusion: ComparisonConclusion
  cohensDz: number | null
  ccc: number | null
  rmse: number | null
  rmsePercent: number | null
  cvDiff: number | null
  r: number | null
  mae: number | null
  mpe: number | null
  n: number
}

/**
 * Compute per-file descriptive statistics from resampled data.
 * Only uses the 1 Hz grid, ignoring nulls.
 *
 * `range` is on the reference (aligned) timebase - the same one the graph
 * displays. Because `series.timestamps` are on the file's local timebase, the
 * range is translated through `alignment.segments` per segment before
 * filtering. The reference file has zero offsets so its local and aligned
 * timebases coincide.
 */
export function computeFileStats(
  series: ResampledSeries,
  metric: MetricKey,
  alignment: AlignmentResult | null = null,
  range?: { fromTime: number; toTime: number },
): FileStats {
  const values = series.values[metric]
  const ts = series.timestamps

  let nonNull: number[]
  if (range) {
    const localWindows = alignedRangeToLocalWindows(range, alignment?.segments ?? [])
    if (localWindows.length === 0) {
      return { mean: null, max: null, min: null, stddev: null, n: 0 }
    }
    nonNull = []
    for (let i = 0; i < ts.length; i++) {
      const v = values[i]
      if (v === null) continue
      const t = ts[i]
      for (const w of localWindows) {
        if (t >= w.from && t <= w.to) {
          nonNull.push(v)
          break
        }
      }
    }
  }
  else {
    nonNull = values.filter((v): v is number => v !== null)
  }

  if (nonNull.length === 0) {
    return { mean: null, max: null, min: null, stddev: null, n: 0 }
  }

  const n = nonNull.length
  const sum = nonNull.reduce((a, b) => a + b, 0)
  const mean = sum / n
  let max = nonNull[0]
  let min = nonNull[0]
  for (const v of nonNull) {
    if (v > max) max = v
    if (v < min) min = v
  }

  const variance =
    nonNull.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n
  const stddev = Math.sqrt(variance)

  return { mean, max, min, stddev, n }
}

/**
 * Get the aligned value at a given reference-grid (aligned) timestamp for a
 * file.  Uses `alignedToLocal` to translate the aligned timestamp through
 * the file's segment offsets before looking up the local grid.
 */
function getAlignedValue(
  series: ResampledSeries,
  metric: MetricKey,
  refTimestamp: number,
  alignment: AlignmentResult | null,
  tsIndex?: Map<number, number>,
): number | null {
  const segments = alignment?.segments ?? []
  const localTs = alignedToLocal(refTimestamp, segments)
  const idx = tsIndex
    ? (tsIndex.get(localTs) ?? -1)
    : series.timestamps.indexOf(localTs)
  if (idx === -1) return null
  return series.values[metric][idx]
}

interface AlignedPair {
  ref: number
  other: number
}

interface PairMoments {
  meanRef: number
  meanOther: number
  meanDiff: number
  varianceRef: number
  varianceOther: number
  varianceDiff: number
  covariance: number
}

const T_CRITICAL_95: readonly [number, number][] = [
  [1, 6.313752], [2, 2.919986], [3, 2.353363], [4, 2.131847],
  [5, 2.015048], [6, 1.943180], [7, 1.894579], [8, 1.859548],
  [9, 1.833113], [10, 1.812461], [11, 1.795885], [12, 1.782288],
  [13, 1.770933], [14, 1.761310], [15, 1.753050], [16, 1.745884],
  [17, 1.739607], [18, 1.734064], [19, 1.729133], [20, 1.724718],
  [21, 1.720743], [22, 1.717144], [23, 1.713872], [24, 1.710882],
  [25, 1.708141], [26, 1.705618], [27, 1.703288], [28, 1.701131],
  [29, 1.699127], [30, 1.697261], [40, 1.683851], [60, 1.670649],
  [120, 1.657651],
]

const NORMAL_CRITICAL_95 = 1.6448536269514722

function tCritical95(df: number): number {
  for (let i = 0; i < T_CRITICAL_95.length; i++) {
    const [tableDf, value] = T_CRITICAL_95[i]
    if (df === tableDf) return value
    if (df < tableDf) {
      const [lowerDf, lowerValue] = T_CRITICAL_95[i - 1]
      const position = (df - lowerDf) / (tableDf - lowerDf)
      return lowerValue + position * (value - lowerValue)
    }
  }

  // Cornish-Fisher expansion of Student's t around the normal quantile.
  const z = NORMAL_CRITICAL_95
  const z2 = z * z
  const z3 = z2 * z
  const z5 = z3 * z2
  const z7 = z5 * z2
  return z
    + (z3 + z) / (4 * df)
    + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2)
    + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3)
}

function pairMoments(pairs: AlignedPair[]): PairMoments {
  const n = pairs.length
  let sumRef = 0
  let sumOther = 0
  let sumDiff = 0

  for (const pair of pairs) {
    sumRef += pair.ref
    sumOther += pair.other
    sumDiff += pair.other - pair.ref
  }

  const meanRef = sumRef / n
  const meanOther = sumOther / n
  const meanDiff = sumDiff / n
  let squaredRef = 0
  let squaredOther = 0
  let squaredDiff = 0
  let crossProduct = 0

  for (const pair of pairs) {
    const refDeviation = pair.ref - meanRef
    const otherDeviation = pair.other - meanOther
    const diffDeviation = (pair.other - pair.ref) - meanDiff
    squaredRef += refDeviation ** 2
    squaredOther += otherDeviation ** 2
    squaredDiff += diffDeviation ** 2
    crossProduct += refDeviation * otherDeviation
  }

  const denominator = n - 1
  return {
    meanRef,
    meanOther,
    meanDiff,
    varianceRef: squaredRef / denominator,
    varianceOther: squaredOther / denominator,
    varianceDiff: squaredDiff / denominator,
    covariance: crossProduct / denominator,
  }
}

function pearsonR(moments: PairMoments): number | null {
  const denominator = Math.sqrt(moments.varianceRef * moments.varianceOther)
  return denominator === 0 ? null : moments.covariance / denominator
}

function meanAbsoluteError(pairs: AlignedPair[]): number {
  return pairs.reduce((sum, pair) => sum + Math.abs(pair.other - pair.ref), 0) / pairs.length
}

function meanPercentageError(pairs: AlignedPair[]): number | null {
  let sum = 0
  let count = 0

  for (const pair of pairs) {
    if (Math.abs(pair.ref) >= MPE_EPSILON) {
      sum += Math.abs((pair.other - pair.ref) / pair.ref) * 100
      count++
    }
  }

  return count > 0 ? sum / count : null
}

function insufficientComparison(n: number): ComparisonStats {
  return {
    grandMean: null,
    bias: null,
    biasPercent: null,
    sdDiff: null,
    loaLower: null,
    loaUpper: null,
    loaLowerPercent: null,
    loaUpperPercent: null,
    equivalenceMargin: null,
    equivalenceMarginPercent: null,
    marginFloorApplied: null,
    ciLower: null,
    ciUpper: null,
    conclusion: 'insufficient-data',
    cohensDz: null,
    ccc: null,
    rmse: null,
    rmsePercent: null,
    cvDiff: null,
    r: null,
    mae: null,
    mpe: null,
    n,
  }
}

function extractAlignedPairs(
  refSeries: ResampledSeries,
  otherSeries: ResampledSeries,
  metric: MetricKey,
  refAlignment: AlignmentResult | null,
  otherAlignment: AlignmentResult | null,
  range?: { fromTime: number; toTime: number },
): AlignedPair[] {
  const refValues = refSeries.values[metric]
  const refTimestamps = refSeries.timestamps
  const otherTsIndex = new Map<number, number>()

  for (let i = 0; i < otherSeries.timestamps.length; i++) {
    otherTsIndex.set(otherSeries.timestamps[i], i)
  }

  const pairs: AlignedPair[] = []

  for (let i = 0; i < refTimestamps.length; i++) {
    const ts = refTimestamps[i]

    if (range && (ts < range.fromTime || ts > range.toTime)) continue

    const refVal = refValues[i]
    if (refVal === null) continue
    if (isInPause(ts, refAlignment?.segments ?? [])) continue

    const otherVal = getAlignedValue(otherSeries, metric, ts, otherAlignment, otherTsIndex)
    if (otherVal === null) continue
    if (isInPause(ts, otherAlignment?.segments ?? [])) continue

    pairs.push({ ref: refVal, other: otherVal })
  }

  return pairs
}

export function computeComparisonStats(
  refSeries: ResampledSeries,
  otherSeries: ResampledSeries,
  metric: MetricKey,
  refAlignment: AlignmentResult | null,
  otherAlignment: AlignmentResult | null,
  options: ComparisonOptions,
): ComparisonStats {
  if (!Number.isFinite(options.marginPercent) || options.marginPercent <= 0) {
    throw new RangeError('marginPercent must be a finite number greater than 0')
  }
  if (!Number.isFinite(options.marginFloor) || options.marginFloor < 0) {
    throw new RangeError('marginFloor must be a finite number greater than or equal to 0')
  }

  const pairs = extractAlignedPairs(
    refSeries,
    otherSeries,
    metric,
    refAlignment,
    otherAlignment,
    options.range,
  )
  const n = pairs.length
  if (n < 2) return insufficientComparison(n)

  const moments = pairMoments(pairs)
  const grandMean = (moments.meanRef + moments.meanOther) / 2
  const absoluteGrandMean = Math.abs(grandMean)
  const hasPercentageDenominator = absoluteGrandMean >= MPE_EPSILON
  const bias = moments.meanDiff
  const sdDiff = Math.sqrt(moments.varianceDiff)
  const loaLower = bias - 1.96 * sdDiff
  const loaUpper = bias + 1.96 * sdDiff
  const percentMargin = absoluteGrandMean * options.marginPercent / 100
  const equivalenceMargin = Math.max(percentMargin, options.marginFloor)
  const marginFloorApplied = options.marginFloor > percentMargin
  const standardError = sdDiff / Math.sqrt(n)
  const critical = tCritical95(n - 1)
  const ciLower = bias - critical * standardError
  const ciUpper = bias + critical * standardError

  let conclusion: ComparisonConclusion
  if (ciLower > -equivalenceMargin && ciUpper < equivalenceMargin) {
    conclusion = 'equivalent'
  }
  else if (ciLower > equivalenceMargin || ciUpper < -equivalenceMargin) {
    conclusion = 'different'
  }
  else {
    conclusion = 'inconclusive'
  }

  let cohensDz: number | null
  if (sdDiff === 0) {
    cohensDz = bias === 0 ? 0 : null
  }
  else {
    cohensDz = bias / sdDiff
  }

  const cccDenominator = moments.varianceRef
    + moments.varianceOther
    + (moments.meanRef - moments.meanOther) ** 2
  let ccc: number | null
  if (cccDenominator === 0) {
    ccc = pairs.every((pair) => pair.ref === pair.other) ? 1 : null
  }
  else {
    ccc = 2 * moments.covariance / cccDenominator
  }

  const meanSquaredError = pairs.reduce(
    (sum, pair) => sum + (pair.other - pair.ref) ** 2,
    0,
  ) / n
  const rmse = Math.sqrt(meanSquaredError)
  const percentage = (value: number): number | null =>
    hasPercentageDenominator ? value / absoluteGrandMean * 100 : null

  return {
    grandMean,
    bias,
    biasPercent: percentage(bias),
    sdDiff,
    loaLower,
    loaUpper,
    loaLowerPercent: percentage(loaLower),
    loaUpperPercent: percentage(loaUpper),
    equivalenceMargin,
    equivalenceMarginPercent: percentage(equivalenceMargin),
    marginFloorApplied,
    ciLower,
    ciUpper,
    conclusion,
    cohensDz,
    ccc,
    rmse,
    rmsePercent: percentage(rmse),
    cvDiff: percentage(sdDiff),
    r: pearsonR(moments),
    mae: meanAbsoluteError(pairs),
    mpe: meanPercentageError(pairs),
    n,
  }
}

/**
 * Compute pairwise statistics between two aligned resampled series.
 * Uses rules:
 * (a) Common grid only - both must have non-null at the timestamp
 * (b) Nulls excluded pairwise
 * (c) Pause regions excluded
 * (d) Zeros kept
 * (e) MPE excludes rows where ref value < epsilon
 *
 * The "ref" series is used as the MPE denominator.
 *
 * `range` is on the reference (aligned) timebase. The ref file's offset is
 * always 0 (see align.ts), so refTimestamps are already aligned and a direct
 * comparison against the range bounds is correct.
 */
export function computePairwiseStats(
  refSeries: ResampledSeries,
  otherSeries: ResampledSeries,
  metric: MetricKey,
  refAlignment: AlignmentResult | null,
  otherAlignment: AlignmentResult | null,
  range?: { fromTime: number; toTime: number },
): PairwiseStats {
  const pairs = extractAlignedPairs(
    refSeries,
    otherSeries,
    metric,
    refAlignment,
    otherAlignment,
    range,
  )

  if (pairs.length < 2) {
    return { r: null, mae: null, mpe: null, n: pairs.length }
  }

  const n = pairs.length
  const moments = pairMoments(pairs)

  return {
    r: pearsonR(moments),
    mae: meanAbsoluteError(pairs),
    mpe: meanPercentageError(pairs),
    n,
  }
}
