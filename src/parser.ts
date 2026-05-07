import FitParser from 'fit-file-parser'
import type { FitSession, FitRecord, Lap, ParseResult } from './types'

type ParsedData = Awaited<ReturnType<FitParser['parseAsync']>>

function parseTimeString(ts: string | Date): number {
  // The fit-file-parser emits Date objects for timestamps (binary.js builds
  // `new Date(epochSeconds * 1000 + GarminTimeOffset)`), but the type signature
  // is `string`. Number(date) coerces to Unix ms, so the same numeric branches
  // below cover both Date inputs and stringified numerics.
  //
  // The numeric branch handles three cases, all returning Unix milliseconds:
  //   1. Unix ms (> 100 billion, i.e. ~1.7 trillion for 2024): pass through
  //   2. FIT epoch seconds (>= 631065600 and <= 100 billion): subtract FIT
  //      epoch (631065600) and scale to ms
  //   3. Unix seconds (< 631065600): multiply by 1000
  // Threshold 100e9 cleanly separates Unix ms (~1.7e12) from FIT epoch
  // seconds (~1.1e9 in 2024).
  const num = Number(ts)
  if (!Number.isNaN(num) && num > 0) {
    if (num > 100_000_000_000) {
      return num // already Unix ms
    }
    if (num >= 631065600) {
      return (num - 631065600) * 1000 // FIT epoch seconds -> Unix ms
    }
    return num * 1000 // Unix seconds -> ms
  }
  // Try ISO string parse
  const parsed = Date.parse(ts as string)
  if (!Number.isNaN(parsed)) return parsed
  return 0
}

function extractRecords(records: ParsedData['records']): FitRecord[] {
  if (!records) return []
  return records.map((r): FitRecord => ({
    timestamp: parseTimeString(r.timestamp),
    power: r.power ?? null,
    cadence: r.cadence ?? null,
    heartRate: r.heart_rate ?? null,
    speed: r.speed ?? null,
    distance: r.distance ?? null,
    elevation: r.altitude ?? null,
    temperature: r.temperature ?? null,
  }))
}

function extractLaps(laps: ParsedData['laps']): Lap[] {
  if (!laps) return []
  return laps.map((l): Lap => ({
    startTime: parseTimeString(l.start_time),
    totalElapsedTime: l.total_elapsed_time ?? 0,
    totalDistance: l.total_distance ?? 0,
  }))
}

function getManufacturer(data: ParsedData): string {
  if (data.file_ids && data.file_ids.length > 0) {
    return data.file_ids[0].manufacturer ?? 'unknown'
  }
  return 'unknown'
}

function getDeviceName(data: ParsedData): string {
  if (data.file_ids && data.file_ids.length > 0 && data.file_ids[0].product_name) {
    return data.file_ids[0].product_name
  }
  return 'Unknown Device'
}

function getSport(data: ParsedData): string {
  if (data.sessions && data.sessions.length > 0) {
    return data.sessions[0].sport ?? 'unknown'
  }
  if (data.activity?.sports) {
    return data.activity.sports as unknown as string
  }
  return 'unknown'
}

function getStartTime(data: ParsedData, records: FitRecord[]): number {
  // Use session start time if available
  if (data.sessions && data.sessions.length > 0 && data.sessions[0].start_time) {
    return parseTimeString(data.sessions[0].start_time)
  }
  // Fall back to the first record's timestamp
  if (records.length > 0) {
    return records[0].timestamp
  }
  return 0
}

export async function parseFitFile(file: Blob): Promise<ParseResult> {
  try {
    const buffer = await file.arrayBuffer()
    const fitParser = new FitParser({
      force: true,
      speedUnit: 'm/s',
      lengthUnit: 'm',
      temperatureUnit: 'celsius',
      elapsedRecordField: false,
      mode: 'both',
    })

    const data: ParsedData = await fitParser.parseAsync(buffer as ArrayBuffer)

    const records = extractRecords(data.records)
    const warnings: string[] = []

    if (records.length === 0) {
      warnings.push('No usable records found')
    }

    // Check if power is completely absent (important for alignment)
    const hasPower = records.some((r) => r.power !== null)
    if (!hasPower && records.length > 0) {
      warnings.push('No power data found in records')
    }

    const session: FitSession = {
      startTime: getStartTime(data, records),
      deviceName: getDeviceName(data),
      manufacturer: getManufacturer(data),
      sport: getSport(data),
      laps: extractLaps(data.laps),
      records,
    }

    const status = records.length === 0 ? 'warning' : 'ok'

    return { status, session, warnings }
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'error', warnings: [message] }
  }
}
