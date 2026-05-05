import type { FitSession, MetricKey, ResampledSeries } from './types'
import { METRIC_KEYS } from './types'

/**
 * Produce a 1 Hz resampled view of a FitSession.
 * - Round each record's timestamp to the nearest whole second.
 * - For each whole-second tick from min to max, take the last record
 *   whose rounded timestamp matches the tick.
 * - Null-fill ticks where no record maps (gaps).
 * - Do not interpolate across gaps.
 */
export function resample(session: FitSession): ResampledSeries {
  const { records } = session

  if (records.length === 0) {
    return {
      timestamps: [],
      values: Object.fromEntries(METRIC_KEYS.map((k) => [k, []])) as unknown as Record<MetricKey, (number | null)[]>,
    }
  }

  // Round each record's timestamp to nearest whole second (in milliseconds)
  const roundedRecords = records.map((r) => ({
    ts: Math.round(r.timestamp / 1000) * 1000,
    ...r,
  }))

  // Find timestamp range
  let minTs = Infinity
  let maxTs = -Infinity
  for (const r of roundedRecords) {
    if (r.ts < minTs) minTs = r.ts
    if (r.ts > maxTs) maxTs = r.ts
  }

  // Build a map of tick -> last matching record (overwrite = last record wins)
  const tickMap = new Map<number, typeof roundedRecords[0]>()
  for (const r of roundedRecords) {
    tickMap.set(r.ts, r)
  }

  // Generate the 1 Hz grid
  const step = 1000 // 1 second in ms
  const timestamps: number[] = []
  const values: Record<MetricKey, (number | null)[]> = Object.fromEntries(
    METRIC_KEYS.map((k) => [k, [] as (number | null)[]]),
  ) as Record<MetricKey, (number | null)[]>

  for (let ts = minTs; ts <= maxTs; ts += step) {
    timestamps.push(ts)
    const record = tickMap.get(ts)

    for (const key of METRIC_KEYS) {
      if (record) {
        values[key].push(record[key] as number | null)
      }
      else {
        values[key].push(null)
      }
    }
  }

  return { timestamps, values }
}
