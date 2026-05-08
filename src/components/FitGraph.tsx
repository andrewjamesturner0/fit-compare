import { useEffect, useRef, useMemo } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { useStore } from '../store'
import { getFileColor } from '../types'
import type { MetricKey, FileEntry, OffsetSegment } from '../types'

const MIN_CHART_HEIGHT = 200

/**
 * Apply per-segment offsets to a record timestamp.
 * Returns the adjusted timestamp, or null if within a gap region.
 */
function adjustTimestamp(
  timestamp: number,
  segments: OffsetSegment[],
): number | null {
  for (const seg of segments) {
    if (timestamp >= seg.fromTime && timestamp <= seg.toTime) {
      return timestamp + seg.offsetSeconds * 1000
    }
  }
  // Fall back to first offset if timestamp is before first segment
  if (segments.length > 0) {
    return timestamp + segments[0].offsetSeconds * 1000
  }
  return timestamp
}

/**
 * Build uPlot AlignedData for the given files and metric.
 * Creates a shared time axis from the union of all files' adjusted timestamps.
 *
 * DESIGN DECISION: This function reads raw records from parseResult.session.records
 * rather than the 1 Hz resampled series used by the stats panel. Raw records are
 * intentional: they preserve sub-second peak fidelity (e.g. a 412 W spike visible in
 * the graph that the stats panel reports as 407 W from the downsampled grid). The
 * stats panel uses resampled data because its pairwise correlation and MAE/MPE
 * computations require a common 1 Hz grid across files. These two data paths are
 * deliberately different - do not "fix" the graph to use resampled data.
 */
function buildChartData(
  files: FileEntry[],
  metric: MetricKey,
): uPlot.AlignedData {
  const activeFiles = files.filter(
    (f) => f.parseResult?.status !== 'error' && f.parseResult?.session,
  )
  if (activeFiles.length === 0) {
    return [[], []]
  }

  // Build per-file (adjustedTimestamp, value) pairs
  const fileData: { ts: number; val: number | null }[][] = []

  for (const file of activeFiles) {
    const records = file.parseResult!.session!.records
    const segments = file.alignmentResult?.segments ?? []

    const pairs: { ts: number; val: number | null }[] = []
    for (const r of records) {
      const val = r[metric]
      if (val === null || val === undefined) continue
      const adjustedTs = adjustTimestamp(r.timestamp, segments)
      if (adjustedTs !== null) {
        pairs.push({ ts: adjustedTs, val })
      }
    }
    fileData.push(pairs)
  }

  // Union of all timestamps, sorted
  const allTs = new Set<number>()
  for (const fd of fileData) {
    for (const p of fd) allTs.add(p.ts)
  }
  const xValues = [...allTs].sort((a, b) => a - b)

  // Build a map: ts -> file index -> value
  const tsMap = new Map<number, Map<number, number>>()
  for (let fi = 0; fi < fileData.length; fi++) {
    for (const p of fileData[fi]) {
      if (p.val !== null) {
        let inner = tsMap.get(p.ts)
        if (!inner) {
          inner = new Map()
          tsMap.set(p.ts, inner)
        }
        // Last record at this timestamp wins
        inner.set(fi, p.val)
      }
    }
  }

  // Build y arrays
  const yArrays: (number | null)[][] = fileData.map(() => [])
  for (const ts of xValues) {
    const inner = tsMap.get(ts)
    for (let fi = 0; fi < fileData.length; fi++) {
      yArrays[fi].push(inner?.get(fi) ?? null)
    }
  }

  return [xValues, ...yArrays]
}

export function FitGraph() {
  const chartRef = useRef<HTMLDivElement>(null)
  const uplotRef = useRef<uPlot | null>(null)
  const files = useStore((s) => s.files)
  const selectedMetric = useStore((s) => s.selectedMetric)
  const selection = useStore((s) => s.selection)
  const setSelection = useStore((s) => s.setSelection)
  const settingFromStore = useRef(false)

  const activeFiles = useMemo(
    () => files.filter(
      (f) => f.parseResult?.status !== 'error' && f.parseResult?.session,
    ),
    [files],
  )

  const hasMetricData = activeFiles.some(
    (f) => f.parseResult?.session?.records.some((r) => r[selectedMetric] !== null),
  )

  const data = useMemo(
    () => buildChartData(files, selectedMetric),
    [files, selectedMetric],
  )

  const opts = useMemo(() => {
    const series: uPlot.Series[] = [
      {
        label: 'Time',
      },
      ...activeFiles.map((f) => ({
        label: f.name,
        stroke: getFileColor(f.colorIndex),
        width: 1.5,
        points: { show: false },
        spanGaps: false,
        scale: 'y',
      })),
    ]

    const axisFont = '11px "IBM Plex Mono", monospace'
    return {
      title: '',
      width: 0,
      series,
      axes: [
        {
          stroke: '#5b6470',
          grid: { stroke: '#eef0f2', dash: [2, 3] },
          font: axisFont,
          ticks: { stroke: '#d4d7dc' },
        },
        {
          stroke: '#5b6470',
          grid: { stroke: '#eef0f2', dash: [2, 3] },
          font: axisFont,
          ticks: { stroke: '#d4d7dc' },
        },
      ],
      cursor: {
        drag: { x: true, y: false, setScale: false },
        points: { size: 6 },
        x: true,
        y: false,
      },
      select: {
        show: true,
        over: true,
      },
      hooks: {
        setSelect: [
          (u: uPlot) => {
            if (settingFromStore.current) return
            const { left, width } = u.select
            if (width <= 0) {
              setSelection(null)
              return
            }
            const fromTime = u.posToVal(left, 'x')
            const toTime = u.posToVal(left + width, 'x')
            if (!isFinite(fromTime) || !isFinite(toTime) || fromTime >= toTime) {
              setSelection(null)
              return
            }
            setSelection({ fromTime, toTime })
          },
        ],
      },
      legend: {
        show: false,
      },
    } as uPlot.Options
  }, [activeFiles, setSelection])

  // Reconstruct chart only when opts change (files added/removed/changed).
  // opts changes when activeFiles changes, which changes when files change.
  useEffect(() => {
    if (!chartRef.current) return

    if (uplotRef.current) {
      uplotRef.current.destroy()
      uplotRef.current = null
    }

    if (data[0].length === 0) return

    const containerWidth = chartRef.current.clientWidth
    const containerHeight = chartRef.current.clientHeight
    const plotOpts = {
      ...opts,
      width: Math.max(containerWidth, 300),
      height: Math.max(containerHeight, MIN_CHART_HEIGHT),
    }

    uplotRef.current = new uPlot(plotOpts, data, chartRef.current)
    ;(chartRef.current as any).__uplot = uplotRef.current

    // Observe resize
    const observer = new ResizeObserver(() => {
      if (chartRef.current && uplotRef.current) {
        uplotRef.current.setSize({
          width: chartRef.current.clientWidth,
          height: Math.max(chartRef.current.clientHeight, MIN_CHART_HEIGHT),
        })
      }
    })
    observer.observe(chartRef.current)

    return () => {
      observer.disconnect()
      if (uplotRef.current) {
        uplotRef.current.destroy()
        uplotRef.current = null
      }
    }
  }, [opts])

  // Update data in-place when only data changes (e.g. after offset nudge),
  // preserving zoom state and avoiding chart flash.
  useEffect(() => {
    if (uplotRef.current && data[0].length > 0) {
      uplotRef.current.setData(data)
    }
  }, [data])

  // Reflect store-side selection changes (cleared from panel, clamped after
  // file removal, etc.) back onto the uPlot brush. The settingFromStore guard
  // prevents the setSelect hook from re-entering setSelection.
  useEffect(() => {
    const u = uplotRef.current
    if (!u) return
    settingFromStore.current = true
    try {
      if (!selection) {
        u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
        return
      }
      const left = u.valToPos(selection.fromTime, 'x')
      const right = u.valToPos(selection.toTime, 'x')
      const top = 0
      const height = u.bbox.height / window.devicePixelRatio
      u.setSelect({ left, top, width: Math.max(right - left, 0), height }, false)
    }
    finally {
      settingFromStore.current = false
    }
  }, [selection, data])

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ minHeight: MIN_CHART_HEIGHT + 32 }}>
      {!hasMetricData && activeFiles.length > 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
          No data for {selectedMetric === 'heartRate' ? 'Heart Rate' : selectedMetric.charAt(0).toUpperCase() + selectedMetric.slice(1)}
        </div>
      ) : (
        <div ref={chartRef} className="flex-1 w-full min-h-0" />
      )}
      {activeFiles.length > 0 && (
        <div className="flex gap-4 px-4 py-2 flex-wrap border-t bg-white flex-shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
          {activeFiles.map((f) => (
            <div key={f.id} className="flex items-center gap-1.5">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                style={{ backgroundColor: getFileColor(f.colorIndex) }}
              />
              <span className="text-xs truncate max-w-[200px]" style={{ color: 'var(--text-secondary)' }}>{f.name}</span>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                ({f.parseResult?.session?.deviceName ?? '?'})
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
