import { describe, it, expect, vi } from 'vitest'
import { parseFitFile } from './parser'

// Mock fit-file-parser
const mockParseAsync = vi.fn()

vi.mock('fit-file-parser', () => ({
  default: vi.fn(function (this: { parseAsync: typeof mockParseAsync }) {
    this.parseAsync = mockParseAsync
  }),
}))

function makeBlob(size: number): Blob {
  return new Blob([new Uint8Array(size)])
}

describe('parseFitFile', () => {
  it('returns error status when parser throws', async () => {
    mockParseAsync.mockRejectedValueOnce(new Error('Corrupt FIT file'))

    const result = await parseFitFile(makeBlob(100))

    expect(result.status).toBe('error')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('Corrupt FIT file')
  })

  it('returns warning when no records are found', async () => {
    mockParseAsync.mockResolvedValueOnce({
      file_creator: {},
      activity: { sport: 'cycling' },
      records: [],
      sessions: [{ start_time: '2024-01-01T00:00:00Z', sport: 'cycling' }],
    })

    const result = await parseFitFile(makeBlob(200))

    expect(result.status).toBe('warning')
    expect(result.warnings).toContain('No usable records found')
    expect(result.session).toBeDefined()
    expect(result.session!.records).toHaveLength(0)
  })

  it('parses valid records with all fields present', async () => {
    mockParseAsync.mockResolvedValueOnce({
      file_creator: {},
      file_ids: [{ manufacturer: 'garmin', product_name: 'Edge 530' }],
      activity: {},
      sessions: [{ start_time: '2024-06-15T10:30:00Z', sport: 'cycling' }],
      records: [
        {
          timestamp: '2024-06-15T10:30:00Z',
          power: 200,
          heart_rate: 150,
          cadence: 90,
          speed: 8.5,
          distance: 100,
          altitude: 50,
          temperature: 22,
        },
        {
          timestamp: '2024-06-15T10:30:01Z',
          power: 210,
          heart_rate: 152,
          cadence: 92,
          speed: 8.7,
          distance: 108.5,
          altitude: 50.5,
          temperature: 22.5,
        },
      ],
      laps: [
        { start_time: '2024-06-15T10:30:00Z', total_elapsed_time: 60, total_distance: 50 },
      ],
    })

    const result = await parseFitFile(makeBlob(300))

    expect(result.status).toBe('ok')
    expect(result.session).toBeDefined()
    const session = result.session!
    expect(session.records).toHaveLength(2)
    expect(session.deviceName).toBe('Edge 530')
    expect(session.manufacturer).toBe('garmin')
    expect(session.sport).toBe('cycling')
    expect(session.laps).toHaveLength(1)

    const r0 = session.records[0]
    expect(r0.power).toBe(200)
    expect(r0.heartRate).toBe(150)
    expect(r0.cadence).toBe(90)
    expect(r0.speed).toBe(8.5)
    expect(r0.distance).toBe(100)
    expect(r0.elevation).toBe(50)
    expect(r0.temperature).toBe(22)
  })

  it('warns when power data is completely missing', async () => {
    mockParseAsync.mockResolvedValueOnce({
      file_creator: {},
      file_ids: [{ manufacturer: 'wahoo_fitness', product_name: 'BOLT' }],
      activity: {},
      sessions: [{ start_time: '2024-06-15T10:30:00Z', sport: 'cycling' }],
      records: [
        {
          timestamp: '2024-06-15T10:30:00Z',
          heart_rate: 140,
          cadence: 85,
        },
        {
          timestamp: '2024-06-15T10:30:01Z',
          heart_rate: 142,
          cadence: 86,
        },
      ],
    })

    const result = await parseFitFile(makeBlob(300))

    expect(result.status).toBe('ok')
    expect(result.warnings).toContain('No power data found in records')
    expect(result.session!.records).toHaveLength(2)
    // All records should have null power
    for (const r of result.session!.records) {
      expect(r.power).toBeNull()
    }
  })

  it('handles records with missing optional fields', async () => {
    mockParseAsync.mockResolvedValueOnce({
      file_creator: {},
      file_ids: [{ manufacturer: 'hammerhead' }],
      activity: {},
      sessions: [{ start_time: '2024-06-15T10:30:00Z', sport: 'cycling' }],
      records: [
        {
          timestamp: '2024-06-15T10:30:00Z',
          power: 180,
          // no heartRate, cadence, speed, etc.
        },
      ],
    })

    const result = await parseFitFile(makeBlob(200))

    expect(result.status).toBe('ok')
    const r = result.session!.records[0]
    expect(r.power).toBe(180)
    expect(r.heartRate).toBeNull()
    expect(r.cadence).toBeNull()
    expect(r.speed).toBeNull()
  })

  it('handles Date object timestamps (the format fit-file-parser actually emits)', async () => {
    // fit-file-parser binary.js builds timestamps as `new Date(...)`. Number(date)
    // gives Unix ms; the parser must keep that as ms (the rest of the pipeline
    // treats record timestamps as ms).
    const date = new Date(Date.UTC(2024, 5, 15, 10, 30, 0))
    const expectedMs = date.getTime()

    mockParseAsync.mockResolvedValueOnce({
      file_creator: {},
      activity: {},
      sessions: [{ start_time: date, sport: 'cycling' }],
      records: [
        { timestamp: date, power: 150 },
        { timestamp: new Date(expectedMs + 1000), power: 160 },
      ],
    })

    const result = await parseFitFile(makeBlob(200))
    expect(result.status).toBe('ok')
    expect(result.session!.records[0].timestamp).toBe(expectedMs)
    expect(result.session!.records[1].timestamp).toBe(expectedMs + 1000)
  })

  it('handles numeric timestamps (FIT epoch seconds)', async () => {
    // FIT epoch is 1989-12-31, so a timestamp like 1080000000 is ~2024
    const fitEpochSeconds = Math.floor(Date.UTC(2024, 5, 15, 10, 30, 0) / 1000) + 631065600

    mockParseAsync.mockResolvedValueOnce({
      file_creator: {},
      activity: {},
      sessions: [{ start_time: String(fitEpochSeconds), sport: 'cycling' }],
      records: [
        {
          timestamp: String(fitEpochSeconds),
          power: 150,
        },
      ],
    })

    const result = await parseFitFile(makeBlob(200))
    expect(result.status).toBe('ok')
    expect(result.session!.records[0].timestamp).toBeGreaterThan(0)
  })
})
