import { describe, it, expect } from 'vitest'
import { computeFileStats, computePairwiseStats } from './stats'
import type { ResampledSeries, MetricKey } from './types'

const M: MetricKey[] = ['power', 'cadence', 'heartRate', 'speed', 'elevation', 'temperature']

function makeSeries(values: (number | null)[]): ResampledSeries {
  const timestamps = values.map((_, i) => i * 1000)
  const v = {} as Record<MetricKey, (number | null)[]>
  for (const key of M) {
    v[key] = key === 'power' ? values : Array(values.length).fill(null)
  }
  return { timestamps, values: v }
}

describe('computeFileStats', () => {
  it('computes mean, max, min, stddev', () => {
    const series = makeSeries([100, 200, 300, 400, 500])
    const result = computeFileStats(series, 'power')

    expect(result.mean).toBeCloseTo(300)
    expect(result.max).toBe(500)
    expect(result.min).toBe(100)
    expect(result.stddev).toBeCloseTo(141.42, 1)
    expect(result.n).toBe(5)
  })

  it('handles null values', () => {
    const series = makeSeries([100, null, 300, null, 500])
    const result = computeFileStats(series, 'power')

    expect(result.mean).toBeCloseTo(300)
    expect(result.n).toBe(3)
  })

  it('handles all nulls', () => {
    const series = makeSeries([null, null, null])
    const result = computeFileStats(series, 'power')

    expect(result.mean).toBeNull()
    expect(result.max).toBeNull()
    expect(result.n).toBe(0)
  })

  it('handles zero values (kept)', () => {
    const series = makeSeries([0, 100, 0, 200])
    const result = computeFileStats(series, 'power')

    expect(result.min).toBe(0)
    expect(result.mean).toBeCloseTo(75)
  })

  it('handles single value', () => {
    const series = makeSeries([250])
    const result = computeFileStats(series, 'power')

    expect(result.mean).toBe(250)
    expect(result.stddev).toBe(0)
    expect(result.n).toBe(1)
  })
})

describe('computePairwiseStats', () => {
  it('computes perfect correlation (r=1) for identical series', () => {
    const ref = makeSeries([100, 200, 300, 400, 500])
    const other = makeSeries([100, 200, 300, 400, 500])

    const result = computePairwiseStats(ref, other, 'power', null, null)
    expect(result.r).toBeCloseTo(1, 4)
    expect(result.mae).toBeCloseTo(0, 4)
    expect(result.mpe).toBeCloseTo(0, 4)
    expect(result.n).toBe(5)
  })

  it('computes negative correlation', () => {
    const ref = makeSeries([100, 200, 300, 400, 500])
    const other = makeSeries([500, 400, 300, 200, 100])

    const result = computePairwiseStats(ref, other, 'power', null, null)
    expect(result.r).toBeCloseTo(-1, 4)
  })

  it('handles nulls in both series (pairwise exclusion)', () => {
    const ref = makeSeries([100, null, 300, 400, null])
    const other = makeSeries([100, 200, null, 400, 500])

    // Overlapping non-null pairs: (100,100), (400,400) = 2 pairs
    const result = computePairwiseStats(ref, other, 'power', null, null)

    expect(result.n).toBe(2)
    expect(result.r).toBeCloseTo(1, 4)
    expect(result.mae).toBeCloseTo(0, 4)
  })

  it('handles MAE correctly', () => {
    const ref = makeSeries([100, 200, 300])
    const other = makeSeries([110, 190, 310])

    const result = computePairwiseStats(ref, other, 'power', null, null)
    expect(result.mae).toBeCloseTo(10, 4)
  })

  it('MPE excludes rows where ref near zero', () => {
    const ref = makeSeries([0, 100, 200, 0])
    const other = makeSeries([1, 110, 220, 2])

    const result = computePairwiseStats(ref, other, 'power', null, null)
    // ref[0]=0 (< epsilon), excluded from MPE. ref[3]=0, excluded.
    // MPE computed only on (100,110) and (200,220)
    // |100-110|/100 * 100 = 10%, |200-220|/200 * 100 = 10%
    expect(result.mpe).toBeCloseTo(10, 4)
  })

  it('returns null for insufficient pairs', () => {
    const ref = makeSeries([100, null])
    const other = makeSeries([null, 200])

    const result = computePairwiseStats(ref, other, 'power', null, null)
    expect(result.r).toBeNull()
    expect(result.n).toBe(0)
  })

  it('zeros are kept (not excluded)', () => {
    const ref = makeSeries([0, 0, 0])
    const other = makeSeries([0, 0, 0])

    const result = computePairwiseStats(ref, other, 'power', null, null)
    expect(result.n).toBe(3)
    // MPE: zeros are < epsilon, so excluded from MPE
    expect(result.mpe).toBeNull()
    expect(result.mae).toBe(0)
  })
})
