export type MetricKey = 'power' | 'cadence' | 'heartRate' | 'speed' | 'elevation' | 'temperature'

export const METRIC_KEYS: MetricKey[] = [
  'power', 'cadence', 'heartRate', 'speed', 'elevation', 'temperature',
]

export const METRIC_LABELS: Record<MetricKey, string> = {
  power: 'Power (W)',
  cadence: 'Cadence (rpm)',
  heartRate: 'Heart Rate (bpm)',
  speed: 'Speed (m/s)',
  elevation: 'Elevation (m)',
  temperature: 'Temperature (°C)',
}

export const METRIC_UNITS: Record<MetricKey, string> = {
  power: 'W',
  cadence: 'rpm',
  heartRate: 'bpm',
  speed: 'm/s',
  elevation: 'm',
  temperature: '°C',
}

export const ALIGNMENT_METRIC_FALLBACK: MetricKey[] = ['power', 'heartRate', 'speed']

/** A single data record from a FIT file. All values are nullable — fields may be missing. */
export interface FitRecord {
  timestamp: number
  power: number | null
  cadence: number | null
  heartRate: number | null
  speed: number | null
  distance: number | null
  elevation: number | null
  temperature: number | null
}

export interface Lap {
  startTime: number
  totalElapsedTime: number
  totalDistance: number
}

/** Parsed FIT file session — raw records plus metadata. */
export interface FitSession {
  startTime: number
  deviceName: string
  manufacturer: string
  sport: string
  laps: Lap[]
  records: FitRecord[]
}

/** 1 Hz resampled view of a FitSession, null-filled across gaps. Produced independently by resample.ts. */
export interface ResampledSeries {
  timestamps: number[]
  values: Record<MetricKey, (number | null)[]>
}

/** A user-selected time range on the reference (aligned) timebase, in ms - the same units as the graph's x-axis. */
export interface Selection {
  fromTime: number
  toTime: number
}

/** A time segment with an offset correction (in seconds). */
export interface OffsetSegment {
  fromTime: number
  toTime: number
  offsetSeconds: number
}

export type ParseStatus = 'ok' | 'warning' | 'error'

export interface ParseResult {
  status: ParseStatus
  session?: FitSession
  warnings: string[]
}

export type AlignmentStatus = 'ok' | 'warning' | 'failed'

export interface AlignmentResult {
  status: AlignmentStatus
  segments: OffsetSegment[]
  warning?: string
}

/** Colour palette for file traces. Deterministic by file index. */
export const COLOR_PALETTE: string[] = [
  '#000000', // black
  '#E69F00', // orange
  '#56B4E9', // sky blue
  '#009E73', // bluish green
  '#F0E442', // yellow
  '#0072B2', // blue
  '#D55E00', // vermillion
  '#CC79A7', // reddish purple
]

export function getFileColor(index: number): string {
  return COLOR_PALETTE[index % COLOR_PALETTE.length]
}

/** A file entry in the store, holding parse and alignment results. */
export interface FileEntry {
  id: string
  name: string
  size: number
  file: File
  colorIndex: number
  loading: boolean
  parseResult: ParseResult | null
  resampledSeries: ResampledSeries | null
  alignmentResult: AlignmentResult | null
}
