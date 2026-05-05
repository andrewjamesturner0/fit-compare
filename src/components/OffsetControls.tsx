import { useState } from 'react'
import { useStore } from '../store'
import { getFileColor } from '../types'

function formatElapsed(ms: number): string {
  if (!ms) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

export function OffsetControls() {
  const files = useStore((s) => s.files)
  const nudgeOffset = useStore((s) => s.nudgeOffset)
  const setSegmentOffset = useStore((s) => s.setSegmentOffset)
  const nudgeAllOffsets = useStore((s) => s.nudgeAllOffsets)
  const [isOpen, setIsOpen] = useState(false)
  const [linkedFiles, setLinkedFiles] = useState<Set<string>>(new Set())

  const activeFiles = files.filter(
    (f) => f.parseResult?.status !== 'error' && f.alignmentResult?.segments?.length,
  )

  if (activeFiles.length === 0) return null

  const toggleLink = (id: string) => {
    setLinkedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleNudge = (id: string, segmentIndex: number, delta: number) => {
    if (linkedFiles.has(id)) {
      // Linked: move all segments by the same delta, preserving inter-segment differences
      nudgeOffset(id, delta)
    }
    else {
      // Unlinked: move only the clicked segment
      const file = files.find((f) => f.id === id)
      if (!file?.alignmentResult) return
      const currentOffset = file.alignmentResult.segments[segmentIndex].offsetSeconds
      setSegmentOffset(id, segmentIndex, currentOffset + delta)
    }
  }

  return (
    <div className="border-t" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-subtle)' }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-2 text-left flex items-center justify-between transition-colors hover:bg-gray-100"
        style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-secondary)' }}
      >
        <span>Adjust Offsets</span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {isOpen && (
        <div className="px-4 pb-4 space-y-4">
          {/* Global nudge */}
          <div className="flex items-center gap-2 pt-2">
            <span className="text-xs text-gray-500">Nudge all files:</span>
            <button
              onClick={() => nudgeAllOffsets(-1)}
              className="px-2 py-0.5 text-xs bg-white border border-gray-300 rounded hover:bg-gray-100"
            >
              -1s
            </button>
            <button
              onClick={() => nudgeAllOffsets(1)}
              className="px-2 py-0.5 text-xs bg-white border border-gray-300 rounded hover:bg-gray-100"
            >
              +1s
            </button>
          </div>

          {/* Per-file segments */}
          {activeFiles.map((f) => {
            const segments = f.alignmentResult!.segments
            const linked = linkedFiles.has(f.id)
            return (
              <div
                key={f.id}
                className="bg-white border border-gray-200 rounded-lg p-3"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block w-3 h-3 rounded-full"
                      style={{ backgroundColor: getFileColor(f.colorIndex) }}
                    />
                    <span className="text-sm font-medium text-gray-700 truncate max-w-[150px]">
                      {f.name}
                    </span>
                  </div>
                  <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={linked}
                      onChange={() => toggleLink(f.id)}
                      className="rounded"
                    />
                    Link all
                  </label>
                </div>

                {segments.length === 1 ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 w-full">
                      {formatElapsed(segments[0].fromTime)} —{' '}
                      {formatElapsed(segments[0].toTime)}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleNudge(f.id, 0, -1)}
                        className="px-1.5 py-0.5 text-xs bg-gray-100 border border-gray-300 rounded hover:bg-gray-200"
                      >
                        -
                      </button>
                      <input
                        type="number"
                        value={segments[0].offsetSeconds}
                        onChange={(e) => {
                          const val = Number(e.target.value)
                          if (!Number.isNaN(val)) {
                            if (linked) {
                              nudgeOffset(
                                f.id,
                                val - segments[0].offsetSeconds,
                              )
                            }
                            else {
                              setSegmentOffset(f.id, 0, val)
                            }
                          }
                        }}
                        min={-300}
                        max={300}
                        className="w-16 text-center text-sm border border-gray-300 rounded py-0.5"
                      />
                      <button
                        onClick={() => handleNudge(f.id, 0, 1)}
                        className="px-1.5 py-0.5 text-xs bg-gray-100 border border-gray-300 rounded hover:bg-gray-200"
                      >
                        +
                      </button>
                      <span className="text-xs text-gray-400">s</span>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {segments.map((seg, si) => (
                      <div
                        key={si}
                        className="flex items-center gap-2"
                      >
                        <span className="text-xs text-gray-500 w-32 flex-shrink-0">
                          {formatElapsed(seg.fromTime)} —{' '}
                          {si === segments.length - 1
                            ? 'end'
                            : formatElapsed(seg.toTime)}
                        </span>
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            value={seg.offsetSeconds}
                            onChange={(e) => {
                              const val = Number(e.target.value)
                              if (Number.isNaN(val)) return
                              if (linked) {
                                const delta = val - seg.offsetSeconds
                                nudgeOffset(f.id, delta)
                              }
                              else {
                                setSegmentOffset(f.id, si, val)
                              }
                            }}
                            min={-300}
                            max={300}
                            className="w-16 text-center text-sm border border-gray-300 rounded py-0.5"
                          />
                          <span className="text-xs text-gray-400">s</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
