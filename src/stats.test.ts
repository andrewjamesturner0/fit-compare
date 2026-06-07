import { describe, it, expect } from 'vitest'
import { computeFileStats, computePairwiseStats } from './stats'
import type { ResampledSeries, MetricKey, AlignmentResult } from './types'

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

  describe('with range', () => {
    function refAlignment(fromTime: number, toTime: number): AlignmentResult {
      return {
        status: 'ok',
        segments: [{ fromTime, toTime, offsetSeconds: 0 }],
      }
    }

    it('reference file: filters samples on the local timebase (offset 0)', () => {
      const series = makeSeries([100, 200, 300, 400, 500])
      // timestamps: 0, 1000, 2000, 3000, 4000
      const align = refAlignment(0, 4000)
      const result = computeFileStats(series, 'power', align, { fromTime: 1000, toTime: 3000 })

      expect(result.n).toBe(3)
      expect(result.mean).toBeCloseTo(300)
      expect(result.min).toBe(200)
      expect(result.max).toBe(400)
    })

    it('non-reference file: translates aligned range through segment offset', () => {
      const series = makeSeries([100, 200, 300, 400, 500])
      // local timestamps: 0, 1000, 2000, 3000, 4000
      // displayed = local + 5000ms (offset 5s)
      const align: AlignmentResult = {
        status: 'ok',
        segments: [{ fromTime: 0, toTime: 4000, offsetSeconds: 5 }],
      }
      // Aligned range [6000, 8000] -> local [1000, 3000] -> picks values 200, 300, 400
      const result = computeFileStats(series, 'power', align, { fromTime: 6000, toTime: 8000 })

      expect(result.n).toBe(3)
      expect(result.mean).toBeCloseTo(300)

      // Sanity: same numeric range without translation would have picked 100, 200, 300 (mean 200)
      const wrong = computeFileStats(series, 'power', null, { fromTime: 0, toTime: 2000 })
      expect(wrong.mean).toBeCloseTo(200)
    })

    it('returns nulls when range yields zero samples', () => {
      const series = makeSeries([100, 200, 300])
      const align = refAlignment(0, 2000)
      const result = computeFileStats(series, 'power', align, { fromTime: 10_000, toTime: 20_000 })

      expect(result.mean).toBeNull()
      expect(result.max).toBeNull()
      expect(result.n).toBe(0)
    })

    it('multi-segment alignment: range straddling a pause gap', () => {
      const series = makeSeries([10, 20, 30, 40, 50, 60])
      // local timestamps: 0, 1000, 2000, 3000, 4000, 5000
      // segment A: local 0..2000, offset 0  -> displayed 0..2000
      // segment B: local 3000..5000, offset 10 -> displayed 13000..15000
      const align: AlignmentResult = {
        status: 'ok',
        segments: [
          { fromTime: 0, toTime: 2000, offsetSeconds: 0 },
          { fromTime: 3000, toTime: 5000, offsetSeconds: 10 },
        ],
      }
      // Aligned range [1000, 14000] picks:
      //   from seg A: local [1000, 2000] -> values 20, 30
      //   from seg B: local [3000, 4000] -> values 40, 50
      const result = computeFileStats(series, 'power', align, { fromTime: 1000, toTime: 14000 })

      expect(result.n).toBe(4)
      expect(result.mean).toBeCloseTo((20 + 30 + 40 + 50) / 4)
      expect(result.min).toBe(20)
      expect(result.max).toBe(50)
    })
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

  describe('with range', () => {
    it('restricts pairs to range and skips outside it', () => {
      const ref = makeSeries([100, 200, 300, 400, 500])
      const other = makeSeries([110, 210, 310, 410, 510])
      // refTimestamps: 0, 1000, 2000, 3000, 4000
      const result = computePairwiseStats(ref, other, 'power', null, null, {
        fromTime: 1000,
        toTime: 3000,
      })

      expect(result.n).toBe(3)
      expect(result.mae).toBeCloseTo(10, 4)
    })

    it('returns insufficient-pairs result when range is too narrow', () => {
      const ref = makeSeries([100, 200, 300])
      const other = makeSeries([100, 200, 300])
      const result = computePairwiseStats(ref, other, 'power', null, null, {
        fromTime: 0,
        toTime: 0,
      })

      expect(result.n).toBe(1)
      expect(result.r).toBeNull()
    })

    it('range overlapping a pause region still excludes the pause', () => {
      const ref = makeSeries([100, 200, 300, 400, 500])
      const other = makeSeries([100, 200, 300, 400, 500])
      // ref pause between 1500..2500 (covers ts=2000)
      const refAlign: AlignmentResult = {
        status: 'ok',
        segments: [
          { fromTime: 0, toTime: 1500, offsetSeconds: 0 },
          { fromTime: 2500, toTime: 4000, offsetSeconds: 0 },
        ],
      }
      const result = computePairwiseStats(ref, other, 'power', refAlign, null, {
        fromTime: 0,
        toTime: 4000,
      })

      // ts=2000 sits inside the pause and must be excluded; the rest (4 pts) survive
      expect(result.n).toBe(4)
    })

    it('handles non-zero offset segments in other file (pairwise across pause)', () => {
      // Other file has two segments: offset 0 for t in [0, 3000], offset 10 for t in [4000, 6000].
      // Reference: aligns at t 0..7000
      const ref = makeSeries([
        100, 200, 300, 400, 500, 600, 700,
      ])
      const other = makeSeries([
        100, 200, 300, null, 400, 500, 600,
      ])
      // other timestamps: 0, 1000, 2000, 3000, 4000, 5000, 6000
      // Segment 1: local [0, 3000] offset 0 → aligned [0, 3000]
      // Segment 2: local [4000, 6000] offset 10 → aligned [14000, 16000]
      const otherAlign: AlignmentResult = {
        status: 'warning',
        segments: [
          { fromTime: 0, toTime: 3000, offsetSeconds: 0 },
          { fromTime: 4000, toTime: 6000, offsetSeconds: 10 },
        ],
      }

      // With no range, ref walks all timestamps (0..6000).
      // At ref ts=0: other's local ts=0 → 100. Pair (100, 100).
      // At ref ts=1000: other's local ts=1000 → 200. Pair (200, 200).
      // At ref ts=2000: other's local ts=2000 → 300. Pair (300, 300).
      // At ref ts=3000: other's local... segment 1 covers to 3000, so local=3000 → null. Skipped.
      // At ref ts=4000: other's local... segment 2 starts at 4000. But aligned window of seg 2 is [14000, 16000].
      //   So ref ts=4000 doesn't intersect any segment's aligned window.
      //   Fallback: after last segment, uses last segment's offset (10). local=4000-10000 = -6000 → not found.
      // So only pairs 0, 1000, 2000 match → n=3
      const result = computePairwiseStats(ref, other, 'power', null, otherAlign)
      expect(result.n).toBe(3)
      expect(result.r).toBeCloseTo(1, 4)
    })

    it('multi-segment other file with range across the gap', () => {
      // Same setup but with an aligned-time range that straddles the gap.
      const ref = makeSeries([
        100, 200, 300, 400, 500,
        600, 700, 800, 900, 1000,
      ])
      const otherPower: (number | null)[] = []
      for (let i = 0; i < 10; i++) otherPower.push((i + 1) * 100)
      const other = makeSeries(otherPower)

      // Segment 1: local [0, 4000] offset 0 → aligned [0, 4000]
      // Segment 2: local [5000, 9000] offset 5 → aligned [10000, 14000]
      const otherAlign: AlignmentResult = {
        status: 'warning',
        segments: [
          { fromTime: 0, toTime: 4000, offsetSeconds: 0 },
          { fromTime: 5000, toTime: 9000, offsetSeconds: 5 },
        ],
      }

      // Range [1000, 12000] on aligned (ref) timebase.
      // Ref walks ts from 0..9000, filtered to [1000, 12000]:
      //   ts=1000: local=1000 (seg 1, offset 0) → other[1]=200. Pair (200, 200).
      //   ts=2000: local=2000 → other[2]=300. Pair (300, 300).
      //   ts=3000: local=3000 → other[3]=400. Pair (400, 400).
      //   ts=4000: local=4000 (seg 1, offset 0) → other[4]=500. Pair (500, 500).
      //   ts=5000: local=5000 - but which segment? none for aligned 5000.
      //     After seg1 end (aligned 4000) and before seg2 start (aligned 10000): no match.
      //   ... until ts=10000: local=10000-5000=5000 (seg 2) → other[5]=600. Pair (600, 600).
      // But ref timestamps only go to 9000, so 10000 is out of range.
      const result = computePairwiseStats(ref, other, 'power', null, otherAlign, {
        fromTime: 1000,
        toTime: 12000,
      })
      expect(result.n).toBe(4) // ts 1000, 2000, 3000, 4000
    })
  })
})
