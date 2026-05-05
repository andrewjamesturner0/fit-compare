import { describe, it, expect } from 'vitest'
import { resample } from './resample'
import type { FitSession, FitRecord } from './types'

function makeSession(records: FitRecord[]): FitSession {
  return {
    startTime: records.length > 0 ? records[0].timestamp : 0,
    deviceName: 'Test Device',
    manufacturer: 'test',
    sport: 'cycling',
    laps: [],
    records,
  }
}

function record(
  timestamp: number,
  power: number | null = null,
  hr: number | null = null,
): FitRecord {
  return {
    timestamp,
    power,
    cadence: null,
    heartRate: hr ?? null,
    speed: null,
    distance: null,
    elevation: null,
    temperature: null,
  }
}

describe('resample', () => {
  it('returns empty series for empty session', () => {
    const result = resample(makeSession([]))
    expect(result.timestamps).toHaveLength(0)
    expect(result.values.power).toHaveLength(0)
  })

  it('produces 1 Hz grid from evenly-spaced input', () => {
    const records = [
      record(1_000, 100),
      record(2_000, 110),
      record(3_000, 120),
    ]
    const result = resample(makeSession(records))

    expect(result.timestamps).toHaveLength(3)
    expect(result.timestamps).toEqual([1_000, 2_000, 3_000])
    expect(result.values.power).toEqual([100, 110, 120])
  })

  it('rounds fractional timestamps to nearest second', () => {
    const records = [
      record(1_499, 100), // rounds to 1000
      record(1_500, 110), // rounds to 2000
      record(2_499, 120), // rounds to 2000 (last one wins)
      record(3_000, 130),
    ]

    // At tick 1000: 1_499 rounds to 1000 -> value 100
    // At tick 2000: 1_500 rounds to 2000 (value 110), 2_499 rounds to 2000 (value 120) -> last wins = 120
    // At tick 3000: 3_000 rounds to 3000 -> value 130
    const result = resample(makeSession(records))

    expect(result.timestamps).toEqual([1_000, 2_000, 3_000])
    expect(result.values.power).toEqual([100, 120, 130])
  })

  it('null-fills gaps between non-contiguous records', () => {
    const records = [
      record(1_000, 100),
      record(5_000, 500),
    ]
    const result = resample(makeSession(records))

    // Should produce ticks at 1000, 2000, 3000, 4000, 5000
    expect(result.timestamps).toEqual([1_000, 2_000, 3_000, 4_000, 5_000])
    expect(result.values.power).toEqual([100, null, null, null, 500])
  })

  it('handles a single record', () => {
    const records = [record(5_000, 250)]
    const result = resample(makeSession(records))

    expect(result.timestamps).toEqual([5_000])
    expect(result.values.power).toEqual([250])
  })

  it('handles irregularly-spaced input (non-1 Hz source)', () => {
    // Simulating a 0.5 Hz source (record every 2 seconds)
    const records = [
      record(1_000, 100),
      record(3_000, 120),
      record(5_000, 140),
    ]
    const result = resample(makeSession(records))

    // Null-filled grid: 1000, 2000(null), 3000, 4000(null), 5000
    expect(result.timestamps).toEqual([1_000, 2_000, 3_000, 4_000, 5_000])
    expect(result.values.power).toEqual([100, null, 120, null, 140])
  })

  it('handles multiple records mapping to the same second tick', () => {
    const records = [
      record(1_000, 100),
      record(1_200, 110), // also rounds to 1000
      record(1_400, 120), // also rounds to 1000
      record(2_000, 130),
    ]

    // Tick 1000: last record wins = 120
    // Tick 2000: value = 130
    const result = resample(makeSession(records))

    expect(result.timestamps).toEqual([1_000, 2_000])
    expect(result.values.power).toEqual([120, 130])
  })

  it('produces null values for all metrics in gaps', () => {
    const records = [
      record(1_000, 100, 140),
      record(3_000, 120, 145),
    ]
    const result = resample(makeSession(records))

    expect(result.timestamps).toEqual([1_000, 2_000, 3_000])
    expect(result.values.power).toEqual([100, null, 120])
    expect(result.values.heartRate).toEqual([140, null, 145])
  })
})
