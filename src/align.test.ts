import { describe, it, expect } from 'vitest'
import { alignPair, alignAll } from './align'
import type { ResampledSeries, MetricKey } from './types'

const M: MetricKey[] = ['power', 'cadence', 'heartRate', 'speed', 'elevation', 'temperature']

function makeSeries(
  length: number,
  startTime: number,
  powerValues: (number | null)[],
): ResampledSeries {
  const timestamps: number[] = []
  for (let i = 0; i < length; i++) {
    timestamps.push(startTime + i * 1000)
  }
  const values = {} as Record<MetricKey, (number | null)[]>
  for (const key of M) {
    if (key === 'power') {
      values[key] = powerValues.slice(0, length)
    }
    else {
      values[key] = Array(length).fill(null)
    }
  }
  return { timestamps, values }
}

// Power: roughly sinusoidal for cross-correlation distinctiveness
function powerPattern(length: number, phase: number): (number | null)[] {
  const values: (number | null)[] = []
  for (let i = 0; i < length; i++) {
    values.push(150 + 50 * Math.sin((i + phase) * 0.1))
  }
  return values
}

describe('alignPair', () => {
  it('finds known global offset (Pass 1)', () => {
    const ref = makeSeries(600, 0, powerPattern(600, 0))
    // other's pattern is phase-shifted ahead by 10s: other[0] matches ref[10]
    // To align, we need a positive offset so other[i-10] is compared with ref[i]
    const other = makeSeries(600, 0, powerPattern(600, 10))

    const result = alignPair(ref, other)
    expect(result.status).toBe('warning')
    expect(result.segments.length).toBeGreaterThan(0)
    expect(result.segments[0].offsetSeconds).toBe(10)
  })

  it('handles files with no offset (same start time)', () => {
    const ref = makeSeries(600, 0, powerPattern(600, 0))
    const other = makeSeries(600, 0, powerPattern(600, 0))

    const result = alignPair(ref, other)
    expect(result.status).toBe('ok')
    expect(result.segments.length).toBeGreaterThan(0)
    expect(result.segments[0].offsetSeconds).toBe(0)
  })

  it('handles a single pause where one file has a gap', () => {
    // ref: continuous 600 seconds
    const refPower = powerPattern(600, 0)
    const ref = makeSeries(600, 0, refPower)

    // other: 200 seconds matching ref, then 20-second gap, then 380 seconds also matching ref
    // Entire file matches at the same offset (0), just has a pause gap
    const otherPowerFirst = refPower.slice(0, 200)
    const otherPowerSecond = refPower.slice(220, 600) // skip the gap region
    const otherPower = [...otherPowerFirst, ...Array(20).fill(null), ...otherPowerSecond]

    const other = makeSeries(600, 0, otherPower)

    const result = alignPair(ref, other)
    expect(result.status).toBe('warning')
    // Should detect the pause and produce segments
    expect(result.segments.length).toBeGreaterThanOrEqual(1)
  })

  it('handles files with no pauses', () => {
    const ref = makeSeries(100, 0, powerPattern(100, 5))
    const other = makeSeries(100, 0, powerPattern(100, 5))

    const result = alignPair(ref, other)
    expect(result.status).toBe('ok')
    expect(result.segments.length).toBe(1)
  })

  it('returns failed when no overlap exists', () => {
    // ref has power, other has none
    const ref = makeSeries(300, 0, powerPattern(300, 0))
    const other: ResampledSeries = {
      timestamps: ref.timestamps.slice(),
      values: Object.fromEntries(M.map((k) => [k, Array(300).fill(null)])) as unknown as Record<MetricKey, (number | null)[]>,
    }

    const result = alignPair(ref, other)
    expect(result.status).toBe('failed')
    expect(result.warning).toBeDefined()
  })

  it('returns failed when traces are too short for reliable correlation', () => {
    // Completely different patterns — no correlation
    const ref = makeSeries(60, 0, powerPattern(60, 0))
    const otherPower = Array(60).fill(0).map(() => Math.random() * 200 + 50)
    const other2 = makeSeries(60, 0, otherPower)

    const result2 = alignPair(ref, other2)
    // Random noise won't correlate with sine wave — should fail
    expect(result2.status).toBe('failed')
  })

  it('handles empty series', () => {
    const empty: ResampledSeries = {
      timestamps: [],
      values: Object.fromEntries(M.map((k) => [k, []])) as unknown as Record<MetricKey, (number | null)[]>,
    }
    const ref = makeSeries(100, 0, powerPattern(100, 0))

    expect(alignPair(empty, ref).status).toBe('failed')
    expect(alignPair(ref, empty).status).toBe('failed')
  })
})

describe('alignAll', () => {
  it('aligns multiple files against a reference', () => {
    const series: ResampledSeries[] = [
      makeSeries(600, 0, powerPattern(600, 0)), // ref (index 0)
      makeSeries(600, 0, powerPattern(600, 10)), // shifted by 10s
      makeSeries(600, 0, powerPattern(600, 0)), // same as ref
    ]

    const results = alignAll(series, 0)
    expect(results.size).toBe(3)
    expect(results.get(0)!.segments[0].offsetSeconds).toBe(0) // reference always 0
    expect(results.get(1)!.status).toBe('warning') // 10s offset causes a gap at the start
  })

  it('handles mixed success/failure across files', () => {
    const series: ResampledSeries[] = [
      makeSeries(600, 0, powerPattern(600, 0)),
      makeSeries(600, 0, powerPattern(600, 5)), // good
      {
        // no power data at all
        timestamps: [1000, 2000, 3000],
        values: Object.fromEntries(M.map((k) => [k, [null, null, null]])) as unknown as Record<MetricKey, (number | null)[]>,
      },
    ]

    const results = alignAll(series, 0)
    expect(results.get(0)!.status).toBe('ok')
    expect(results.get(1)!.status).toBe('ok')
    expect(results.get(2)!.status).toBe('failed')
  })
})
