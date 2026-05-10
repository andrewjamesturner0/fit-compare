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

  it('returns failed-with-zero-offset segment when no overlap exists', () => {
    // ref has power, other has none
    const ref = makeSeries(300, 0, powerPattern(300, 0))
    const other: ResampledSeries = {
      timestamps: ref.timestamps.slice(),
      values: Object.fromEntries(M.map((k) => [k, Array(300).fill(null)])) as unknown as Record<MetricKey, (number | null)[]>,
    }

    const result = alignPair(ref, other)
    expect(result.status).toBe('failed')
    expect(result.warning).toBeDefined()
    // Failed alignment now emits a single zero-offset fallback segment so
    // the manual offset controls have something to attach to.
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].offsetSeconds).toBe(0)
  })

  it('returns failed when traces are too short for reliable correlation', () => {
    // Completely different patterns — no correlation
    const ref = makeSeries(60, 0, powerPattern(60, 0))
    const otherPower = Array(60).fill(0).map(() => Math.random() * 200 + 50)
    const other2 = makeSeries(60, 0, otherPower)

    const result2 = alignPair(ref, other2)
    // Random noise won't correlate with sine wave — should fail
    expect(result2.status).toBe('failed')
    expect(result2.segments).toHaveLength(1)
    expect(result2.segments[0].offsetSeconds).toBe(0)
  })

  it('handles empty series', () => {
    const empty: ResampledSeries = {
      timestamps: [],
      values: Object.fromEntries(M.map((k) => [k, []])) as unknown as Record<MetricKey, (number | null)[]>,
    }
    const ref = makeSeries(100, 0, powerPattern(100, 0))

    // Empty other has no timestamps to span, so the fallback segment list
    // is empty in that direction; non-empty other still gets one segment.
    expect(alignPair(empty, ref).status).toBe('failed')
    expect(alignPair(empty, ref).segments).toHaveLength(1)
    expect(alignPair(ref, empty).status).toBe('failed')
    expect(alignPair(ref, empty).segments).toHaveLength(0)
  })

  it('does not drift to a spurious offset when files share little signal', () => {
    // Two unrelated workouts that happen to share a clock window: ramp up
    // (100..400 W) vs steady ~150 W. There is no real time-alignment to
    // find. The algorithm should pin to offset 0 rather than chase a
    // spurious local minimum.
    const ramp: (number | null)[] = []
    for (let i = 0; i < 600; i++) ramp.push(100 + i * 0.5)
    const ref = makeSeries(600, 0, ramp)
    const steady: (number | null)[] = []
    for (let i = 0; i < 600; i++) steady.push(150)
    const other = makeSeries(600, 0, steady)

    const result = alignPair(ref, other)
    expect(result.segments[0].offsetSeconds).toBe(0)
  })

  it('passes alignment when residuals are realistic for two power meters', () => {
    // Two co-recorded power meters: same shape, ~10 W RMSE noise.
    // Old absolute-MSE threshold (0.5 W^2) rejected this; the variance-
    // normalised threshold passes it because the residuals are small
    // relative to the signal's natural variance.
    const ref = makeSeries(600, 0, powerPattern(600, 0))
    let seed = 1
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280
      return seed / 233280
    }
    const noisy = (ref.values.power as number[]).map((v) => v + (rand() - 0.5) * 30)
    const other = makeSeries(600, 0, noisy)

    const result = alignPair(ref, other)
    expect(result.status).not.toBe('failed')
    expect(result.segments.length).toBeGreaterThan(0)
    expect(result.segments[0].offsetSeconds).toBe(0)
  })

  it('residual metric is scale-invariant', () => {
    // Same shape with the same proportional noise should give the same
    // alignment outcome regardless of absolute magnitude.
    const refSmall = makeSeries(600, 0, powerPattern(600, 0))
    const refLarge = makeSeries(
      600,
      0,
      (refSmall.values.power as number[]).map((v) => v * 1000),
    )
    const otherSmall = makeSeries(600, 0, powerPattern(600, 5))
    const otherLarge = makeSeries(
      600,
      0,
      (otherSmall.values.power as number[]).map((v) => v * 1000),
    )

    const small = alignPair(refSmall, otherSmall)
    const large = alignPair(refLarge, otherLarge)
    expect(small.status).toBe(large.status)
    expect(small.segments[0].offsetSeconds).toBe(large.segments[0].offsetSeconds)
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
