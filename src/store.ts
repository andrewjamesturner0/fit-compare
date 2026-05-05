import { create } from 'zustand'
import type { FileEntry, MetricKey } from './types'
import { parseFitFile } from './parser'
import { resample } from './resample'
import { alignAll } from './align'

let nextId = 1

async function parseFileToEntry(file: File, id: string): Promise<FileEntry> {
  const parseResult = await parseFitFile(file)
  let resampledSeries = null
  if (parseResult.status !== 'error' && parseResult.session) {
    resampledSeries = resample(parseResult.session)
  }
  return {
    id,
    name: file.name,
    size: file.size,
    file,
    colorIndex: 0, // placeholder; overwritten by addFiles
    loading: false,
    parseResult,
    resampledSeries,
    alignmentResult: null,
  }
}

export interface AppState {
  files: FileEntry[]
  referenceFileId: string | null
  selectedMetric: MetricKey

  addFiles: (files: File[]) => Promise<void>
  removeFile: (id: string) => void
  clearAll: () => void
  setSelectedMetric: (metric: MetricKey) => void
  setReferenceFile: (id: string) => void
  setAlignmentResult: (id: string, result: FileEntry['alignmentResult']) => void
  recomputeAlignment: () => void
  nudgeOffset: (id: string, deltaSeconds: number) => void
  setSegmentOffset: (id: string, segmentIndex: number, offsetSeconds: number) => void
  nudgeAllOffsets: (deltaSeconds: number) => void
}

export const useStore = create<AppState>((set, get) => ({
  files: [],
  referenceFileId: null,
  selectedMetric: 'power',

  addFiles: async (files: File[]) => {
    const state = get()

    for (const file of files) {
      // Duplicate detection: compare name + size
      const currentFiles = get().files
      const isDuplicate = currentFiles.some(
        (f) => f.name === file.name && f.size === file.size,
      )
      if (isDuplicate) continue

      const id = String(nextId++)
      const colorIndex = currentFiles.length

      // Push a skeleton entry with loading: true immediately
      const skeleton: FileEntry = {
        id,
        name: file.name,
        size: file.size,
        file,
        colorIndex,
        loading: true,
        parseResult: null,
        resampledSeries: null,
        alignmentResult: null,
      }
      set({ files: [...currentFiles, skeleton] })

      // Parse and resample in background, then update the entry
      const done = await parseFileToEntry(file, id)
      done.colorIndex = colorIndex
      set((s) => ({ files: s.files.map((f) => (f.id === id ? done : f)) }))
    }

    // Set reference file to the one with the most records (if not already set)
    let refId = state.referenceFileId
    const currentFiles = get().files
    if (!refId && currentFiles.length > 0) {
      const okFiles = currentFiles.filter(
        (f) => f.parseResult?.status !== 'error' && f.parseResult?.session,
      )
      if (okFiles.length > 0) {
        refId = okFiles.reduce((best, f) =>
          (f.parseResult!.session!.records.length >
            okFiles.find((x) => x.id === best)!.parseResult!.session!.records.length)
            ? f.id
            : best,
        okFiles[0].id,
        )
      }
      else {
        refId = currentFiles[0].id
      }
    }

    set({ referenceFileId: refId })

    // Run auto-alignment
    get().recomputeAlignment()
  },

  removeFile: (id: string) => {
    const state = get()
    const files = state.files.filter((f) => f.id !== id)
    let refId = state.referenceFileId
    console.log('DEBUG removeFile:', { id, refId, filesLen: files.length, refIdEqId: refId === id })
    if (refId === id) {
      const okFiles = files.filter(
        (f) => f.parseResult?.status !== 'error' && f.parseResult?.session,
      )
      refId = okFiles.length > 0 ? okFiles[0].id : null
      console.log('DEBUG removeFile newRef:', refId, 'okFiles:', okFiles.map(f => f.id))
    }
    set({ files, referenceFileId: refId })
  },

  clearAll: () => set({ files: [], referenceFileId: null, selectedMetric: 'power' }),

  setSelectedMetric: (metric: MetricKey) => set({ selectedMetric: metric }),

  setReferenceFile: (id: string) => set({ referenceFileId: id }),

  setAlignmentResult: (id: string, result: FileEntry['alignmentResult']) => {
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id ? { ...f, alignmentResult: result } : f,
      ),
    }))
  },

  nudgeOffset: (id: string, deltaSeconds: number) => {
    set((state) => ({
      files: state.files.map((f) => {
        if (f.id !== id || !f.alignmentResult) return f
        return {
          ...f,
          alignmentResult: {
            ...f.alignmentResult,
            segments: f.alignmentResult.segments.map((s) => ({
              ...s,
              offsetSeconds: s.offsetSeconds + deltaSeconds,
            })),
          },
        }
      }),
    }))
  },

  setSegmentOffset: (id: string, segmentIndex: number, offsetSeconds: number) => {
    set((state) => ({
      files: state.files.map((f) => {
        if (f.id !== id || !f.alignmentResult) return f
        const segments = f.alignmentResult.segments.map((s, i) =>
          i === segmentIndex ? { ...s, offsetSeconds } : s,
        )
        return {
          ...f,
          alignmentResult: { ...f.alignmentResult, segments },
        }
      }),
    }))
  },

  nudgeAllOffsets: (deltaSeconds: number) => {
    set((state) => ({
      files: state.files.map((f) => {
        if (!f.alignmentResult) return f
        return {
          ...f,
          alignmentResult: {
            ...f.alignmentResult,
            segments: f.alignmentResult.segments.map((s) => ({
              ...s,
              offsetSeconds: s.offsetSeconds + deltaSeconds,
            })),
          },
        }
      }),
    }))
  },

  recomputeAlignment: () => {
    const state = get()
    const okFiles = state.files.filter(
      (f) => f.parseResult?.status !== 'error' && f.resampledSeries,
    )
    if (okFiles.length < 2) return

    // Find reference index
    let refIdx = 0
    if (state.referenceFileId) {
      const idx = okFiles.findIndex((f) => f.id === state.referenceFileId)
      if (idx !== -1) refIdx = idx
    }

    const series = okFiles.map((f) => f.resampledSeries!)
    const results = alignAll(series, refIdx)

    set((state) => ({
      files: state.files.map((f) => {
        const idx = okFiles.findIndex((of) => of.id === f.id)
        if (idx === -1 || !results.has(idx)) return f
        return { ...f, alignmentResult: results.get(idx)! }
      }),
    }))
  },
}))
