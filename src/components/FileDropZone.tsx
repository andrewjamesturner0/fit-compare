import { useCallback, useRef, useState } from 'react'
import { useStore } from '../store'
import { getFileColor } from '../types'
import type { ParseStatus, AlignmentResult, FileEntry } from '../types'
import { isSupportedFile, SUPPORTED_EXTENSIONS } from '../parse'

const STATUS_BADGE: Record<ParseStatus, { label: string; cls: string }> = {
  ok: { label: 'OK', cls: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200' },
  warning: { label: 'Warn', cls: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200' },
  error: { label: 'Error', cls: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200' },
}

const ALIGN_BADGE_CLS: Record<'ok' | 'failed' | 'ref', string> = {
  ref: 'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200',
  ok: 'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200',
  failed: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200',
}

function formatTimestamp(ts: number): string {
  if (!ts) return '?'
  const d = new Date(ts)
  return d.toLocaleString()
}

function formatOffset(seconds: number): string {
  if (seconds === 0) return '+0s'
  const sign = seconds > 0 ? '+' : '-'
  const abs = Math.abs(seconds)
  if (abs < 60) return `${sign}${abs}s`
  const m = Math.floor(abs / 60)
  const s = abs % 60
  return s === 0 ? `${sign}${m}m` : `${sign}${m}m${s}s`
}

function alignmentLabel(file: FileEntry, isReference: boolean): { label: string; cls: string } | null {
  if (!file.alignmentResult) return null
  if (isReference) return { label: 'Ref', cls: ALIGN_BADGE_CLS.ref }

  const result: AlignmentResult = file.alignmentResult
  const offsets = result.segments.map((s) => s.offsetSeconds)
  const allSame = offsets.length > 0 && offsets.every((o) => o === offsets[0])
  const summary = offsets.length === 0
    ? '?'
    : allSame
      ? formatOffset(offsets[0])
      : 'varies'

  if (result.status === 'failed') {
    return { label: `Manual (${summary})`, cls: ALIGN_BADGE_CLS.failed }
  }
  return { label: `Aligned ${summary}`, cls: ALIGN_BADGE_CLS.ok }
}

export function FileDropZone() {
  const files = useStore((s) => s.files)
  const referenceFileId = useStore((s) => s.referenceFileId)
  const addFiles = useStore((s) => s.addFiles)
  const removeFile = useStore((s) => s.removeFile)
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const dropped = Array.from(e.dataTransfer.files).filter(
        (f) => isSupportedFile(f.name),
      )
      if (dropped.length > 0) {
        addFiles(dropped)
      }
    },
    [addFiles],
  )

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(e.target.files ?? [])
      if (selected.length > 0) {
        addFiles(selected)
        // Reset input so same file can be re-selected
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [addFiles],
  )

  return (
    <div className="border-b" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-subtle)' }}>
      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className="p-5 text-center cursor-pointer transition-colors border-2 border-dashed rounded-none"
        style={{
          borderColor: isDragging ? 'var(--accent)' : 'var(--border-default)',
          background: isDragging ? 'var(--accent-soft)' : undefined,
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={SUPPORTED_EXTENSIONS.join(',')}
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          Drop .fit or .tcx files here or click to browse
        </p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          Supports Garmin / Wahoo / Hammerhead FIT files and Garmin TCX exports (e.g. TrainerRoad)
        </p>
      </div>

      {/* File list */}
      {files.length > 0 && (
        <div className="p-3 flex flex-wrap gap-2">
          {files.map((f, i) => {
            const status = f.parseResult?.status ?? 'error'
            const badge = STATUS_BADGE[status]
            const session = f.parseResult?.session
            const align = alignmentLabel(f, f.id === referenceFileId)
            return (
              <div
                key={f.id}
                className="flex items-center gap-3 bg-white border border-gray-200 rounded-lg px-3 py-2 shadow-sm"
              >
                <span
                  className="inline-block w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: getFileColor(i) }}
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-700 truncate max-w-[180px]">
                    {f.name}
                  </div>
                  <div className="text-xs text-gray-400">
                    {session?.deviceName ?? '?'}
                    {' — '}
                    {session?.records.length ?? 0} records
                  </div>
                  {session && (
                    <div className="text-xs text-gray-400">
                      {formatTimestamp(session.startTime)}
                    </div>
                  )}
                  {f.parseResult?.warnings.map((w, wi) => (
                    <div
                      key={wi}
                      className="text-xs text-amber-600 truncate max-w-[180px]"
                    >
                      {w}
                    </div>
                  ))}
                </div>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${badge.cls}`}
                >
                  {badge.label}
                </span>
                {align && (
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${align.cls}`}
                    title={f.alignmentResult?.warning ?? undefined}
                  >
                    {align.label}
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeFile(f.id)
                  }}
                  className="text-gray-400 hover:text-red-500 text-lg leading-none ml-1"
                  title="Remove file"
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
