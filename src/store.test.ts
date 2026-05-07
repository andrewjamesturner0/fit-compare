import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useStore } from './store'

// Mock the parser
vi.mock('./parser', () => ({
  parseFitFile: vi.fn(),
}))

// Mock the resampler
vi.mock('./resample', () => ({
  resample: vi.fn().mockReturnValue({
    timestamps: [1000, 2000, 3000],
    values: {
      power: [100, 110, 120],
      cadence: [80, 82, 84],
      heartRate: [140, 142, 144],
      speed: [8, 9, 10],
      elevation: [50, 51, 52],
      temperature: [20, 20, 21],
    },
  }),
}))

import { parseFitFile } from './parser'

function resetStore() {
  useStore.setState({
    files: [],
    referenceFileId: null,
    selectedMetric: 'power',
    selection: null,
  })
}

function makeFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name)
}

function mockParseResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok' as const,
    session: {
      startTime: 1_000_000_000,
      deviceName: 'Edge 530',
      manufacturer: 'garmin',
      sport: 'cycling',
      laps: [],
      records: [
        {
          timestamp: 1_000_000_000,
          power: 100,
          cadence: null,
          heartRate: null,
          speed: null,
          distance: null,
          elevation: null,
          temperature: null,
        },
      ],
    },
    warnings: [],
    ...overrides,
  }
}

describe('store', () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
  })

  describe('addFiles', () => {
    it('adds files and parses them', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse.mockResolvedValueOnce(mockParseResult())

      const file = makeFile('test.fit', 1000)
      await useStore.getState().addFiles([file])

      expect(useStore.getState().files).toHaveLength(1)
      expect(useStore.getState().files[0].name).toBe('test.fit')
      expect(useStore.getState().files[0].parseResult?.status).toBe('ok')
      expect(useStore.getState().files[0].resampledSeries).not.toBeNull()
    })

    it('sets reference file to the one with most records', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse
        .mockResolvedValueOnce(
          mockParseResult({
            session: {
              ...mockParseResult().session,
              records: Array(10).fill(mockParseResult().session!.records[0]),
            },
          }),
        )
        .mockResolvedValueOnce(
          mockParseResult({
            session: {
              ...mockParseResult().session,
              records: Array(100).fill(mockParseResult().session!.records[0]),
            },
          }),
        )

      const file1 = makeFile('small.fit', 500)
      const file2 = makeFile('large.fit', 1000)
      await useStore.getState().addFiles([file1, file2])

      const refId = useStore.getState().referenceFileId
      const refFile = useStore.getState().files.find((f) => f.id === refId)
      expect(refFile).toBeDefined()
      expect(refFile!.parseResult!.session!.records).toHaveLength(100)
    })

    it('skips duplicate files (same name + size)', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse.mockResolvedValue(mockParseResult())

      const file1 = makeFile('test.fit', 1000)
      const file2 = makeFile('test.fit', 1000)
      await useStore.getState().addFiles([file1, file2])

      expect(mockParse).toHaveBeenCalledTimes(1)
      expect(useStore.getState().files).toHaveLength(1)
    })
  })

  describe('removeFile', () => {
    it('removes a file by id', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse.mockResolvedValueOnce(mockParseResult())

      const file = makeFile('test.fit', 1000)
      await useStore.getState().addFiles([file])

      const id = useStore.getState().files[0].id
      useStore.getState().removeFile(id)

      expect(useStore.getState().files).toHaveLength(0)
    })

    it('updates reference file when removing the reference', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse
        .mockResolvedValueOnce(mockParseResult({ warnings: [] }))
        .mockResolvedValueOnce(mockParseResult({ warnings: [] }))

      const file1 = makeFile('a.fit', 100)
      const file2 = makeFile('b.fit', 100)
      await useStore.getState().addFiles([file1, file2])

      const refId = useStore.getState().referenceFileId!
      useStore.getState().removeFile(refId)

      expect(useStore.getState().files).toHaveLength(1)
      expect(useStore.getState().referenceFileId).not.toBeNull()
      expect(useStore.getState().referenceFileId).not.toBe(refId)
    })
  })

  describe('clearAll', () => {
    it('resets all state', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse.mockResolvedValueOnce(mockParseResult())

      await useStore.getState().addFiles([makeFile('test.fit', 1000)])
      useStore.getState().setSelectedMetric('heartRate')
      useStore.getState().clearAll()

      expect(useStore.getState().files).toHaveLength(0)
      expect(useStore.getState().referenceFileId).toBeNull()
      expect(useStore.getState().selectedMetric).toBe('power')
    })
  })

  describe('alignment actions', () => {
    it('setAlignmentResult stores alignment per file', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse.mockResolvedValueOnce(mockParseResult())

      await useStore.getState().addFiles([makeFile('test.fit', 1000)])
      const id = useStore.getState().files[0].id

      const result = { status: 'ok' as const, segments: [{ fromTime: 0, toTime: 100, offsetSeconds: 5 }] }
      useStore.getState().setAlignmentResult(id, result)

      expect(useStore.getState().files[0].alignmentResult).toEqual(result)
    })

    it('nudgeOffset adjusts all segments of a file', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse.mockResolvedValueOnce(mockParseResult())

      await useStore.getState().addFiles([makeFile('test.fit', 1000)])
      const id = useStore.getState().files[0].id

      useStore.getState().setAlignmentResult(id, {
        status: 'ok',
        segments: [
          { fromTime: 0, toTime: 50, offsetSeconds: 10 },
          { fromTime: 50, toTime: 100, offsetSeconds: 12 },
        ],
      })

      useStore.getState().nudgeOffset(id, 2)

      const segments = useStore.getState().files[0].alignmentResult!.segments
      expect(segments[0].offsetSeconds).toBe(12)
      expect(segments[1].offsetSeconds).toBe(14)
    })

    it('setSegmentOffset updates a specific segment', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse.mockResolvedValueOnce(mockParseResult())

      await useStore.getState().addFiles([makeFile('test.fit', 1000)])
      const id = useStore.getState().files[0].id

      useStore.getState().setAlignmentResult(id, {
        status: 'ok',
        segments: [
          { fromTime: 0, toTime: 50, offsetSeconds: 10 },
          { fromTime: 50, toTime: 100, offsetSeconds: 12 },
        ],
      })

      useStore.getState().setSegmentOffset(id, 1, 25)

      const segments = useStore.getState().files[0].alignmentResult!.segments
      expect(segments[0].offsetSeconds).toBe(10) // unchanged
      expect(segments[1].offsetSeconds).toBe(25) // updated
    })

    it('nudgeAllOffsets adjusts all segments of all files', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse
        .mockResolvedValueOnce(mockParseResult())
        .mockResolvedValueOnce(mockParseResult())

      await useStore.getState().addFiles([makeFile('a.fit', 100), makeFile('b.fit', 100)])

      const [id1, id2] = useStore.getState().files.map((f) => f.id)

      useStore.getState().setAlignmentResult(id1, {
        status: 'ok',
        segments: [{ fromTime: 0, toTime: 100, offsetSeconds: 5 }],
      })
      useStore.getState().setAlignmentResult(id2, {
        status: 'ok',
        segments: [{ fromTime: 0, toTime: 100, offsetSeconds: 10 }],
      })

      useStore.getState().nudgeAllOffsets(-1)

      expect(useStore.getState().files[0].alignmentResult!.segments[0].offsetSeconds).toBe(4)
      expect(useStore.getState().files[1].alignmentResult!.segments[0].offsetSeconds).toBe(9)
    })
  })

  describe('selectedMetric', () => {
    it('defaults to power', () => {
      expect(useStore.getState().selectedMetric).toBe('power')
    })

    it('changes the selected metric', () => {
      useStore.getState().setSelectedMetric('heartRate')
      expect(useStore.getState().selectedMetric).toBe('heartRate')
    })
  })

  describe('selection', () => {
    it('defaults to null', () => {
      expect(useStore.getState().selection).toBeNull()
    })

    it('rejects a selection with no files (no extent)', () => {
      useStore.getState().setSelection({ fromTime: 1000, toTime: 2000 })
      expect(useStore.getState().selection).toBeNull()
    })

    it('clamps a selection to the data extent', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse.mockResolvedValueOnce(mockParseResult())

      await useStore.getState().addFiles([makeFile('a.fit', 100)])
      const id = useStore.getState().files[0].id
      useStore.getState().setAlignmentResult(id, {
        status: 'ok',
        segments: [{ fromTime: 1000, toTime: 3000, offsetSeconds: 0 }],
      })

      // Request a range that overflows on both sides
      useStore.getState().setSelection({ fromTime: 0, toTime: 10_000 })
      expect(useStore.getState().selection).toEqual({ fromTime: 1000, toTime: 3000 })
    })

    it('clears a selection that falls entirely outside the extent', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse.mockResolvedValueOnce(mockParseResult())

      await useStore.getState().addFiles([makeFile('a.fit', 100)])
      const id = useStore.getState().files[0].id
      useStore.getState().setAlignmentResult(id, {
        status: 'ok',
        segments: [{ fromTime: 1000, toTime: 3000, offsetSeconds: 0 }],
      })

      useStore.getState().setSelection({ fromTime: 10_000, toTime: 20_000 })
      expect(useStore.getState().selection).toBeNull()
    })

    it('clearAll wipes the selection', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse.mockResolvedValueOnce(mockParseResult())
      await useStore.getState().addFiles([makeFile('a.fit', 100)])
      const id = useStore.getState().files[0].id
      useStore.getState().setAlignmentResult(id, {
        status: 'ok',
        segments: [{ fromTime: 1000, toTime: 3000, offsetSeconds: 0 }],
      })
      useStore.getState().setSelection({ fromTime: 1500, toTime: 2500 })

      useStore.getState().clearAll()
      expect(useStore.getState().selection).toBeNull()
    })

    it('removeFile to empty wipes the selection', async () => {
      const mockParse = vi.mocked(parseFitFile)
      mockParse.mockResolvedValueOnce(mockParseResult())
      await useStore.getState().addFiles([makeFile('a.fit', 100)])
      const id = useStore.getState().files[0].id
      useStore.getState().setAlignmentResult(id, {
        status: 'ok',
        segments: [{ fromTime: 1000, toTime: 3000, offsetSeconds: 0 }],
      })
      useStore.getState().setSelection({ fromTime: 1500, toTime: 2500 })

      useStore.getState().removeFile(id)
      expect(useStore.getState().selection).toBeNull()
    })
  })
})
