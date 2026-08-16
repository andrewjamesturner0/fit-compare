import { useMemo, useState } from 'react'
import { useStore } from '../store'
import {
  computeComparisonStats,
  computeFileStats,
  computePairwiseStats,
} from '../stats'
import type { FileStats, PairwiseStats } from '../stats'
import { getFileColor, METRIC_LABELS, METRIC_UNITS } from '../types'
import type { FileEntry } from '../types'
import { ComparisonView } from './ComparisonView'
import type { ComparisonRow } from './ComparisonView'

type Scope = 'selection' | 'overall'

function fmt(val: number | null, decimals: number): string {
  if (val === null) return '-'
  return val.toFixed(decimals)
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function StatsPanel() {
  const files = useStore((s) => s.files)
  const referenceFileId = useStore((s) => s.referenceFileId)
  const selectedMetric = useStore((s) => s.selectedMetric)
  const selection = useStore((s) => s.selection)
  const setSelection = useStore((s) => s.setSelection)

  const [scope, setScope] = useState<Scope>('selection')
  const [prevSelection, setPrevSelection] = useState(selection)
  // When a new selection appears (or the selection identity changes), focus
  // the Selection scope so the user sees it first.
  if (selection !== prevSelection) {
    setPrevSelection(selection)
    if (selection !== null) setScope('selection')
  }

  const activeFiles = useMemo(
    () => files.filter(
      (f) =>
        f.parseResult?.status !== 'error'
        && f.resampledSeries
        && f.resampledSeries.timestamps.length > 0,
    ),
    [files],
  )

  const referenceFile = useMemo(
    () => activeFiles.find((file) => file.id === referenceFileId) ?? activeFiles[0],
    [activeFiles, referenceFileId],
  )
  const comparisonFiles = useMemo(
    () => activeFiles.filter((file) => file.id !== referenceFile?.id),
    [activeFiles, referenceFile],
  )

  const fileStatsOverall = useMemo(
    () => new Map(activeFiles.map((file) => [
      file.id,
      computeFileStats(file.resampledSeries!, selectedMetric, file.alignmentResult),
    ])),
    [activeFiles, selectedMetric],
  )

  const fileStatsSelection = useMemo(
    () =>
      selection
        ? new Map(activeFiles.map((file) => [
            file.id,
            computeFileStats(file.resampledSeries!, selectedMetric, file.alignmentResult, selection),
          ]))
        : null,
    [activeFiles, selectedMetric, selection],
  )

  const pairwiseStatsOverall = useMemo(() => {
    if (!referenceFile || selectedMetric === 'power') return []
    return comparisonFiles.map((file) => computePairwiseStats(
      referenceFile.resampledSeries!,
      file.resampledSeries!,
      selectedMetric,
      referenceFile.alignmentResult,
      file.alignmentResult,
    ))
  }, [comparisonFiles, referenceFile, selectedMetric])

  const pairwiseStatsSelection = useMemo(() => {
    if (!selection || !referenceFile || selectedMetric === 'power') return null
    return comparisonFiles.map((file) => computePairwiseStats(
      referenceFile.resampledSeries!,
      file.resampledSeries!,
      selectedMetric,
      referenceFile.alignmentResult,
      file.alignmentResult,
      selection,
    ))
  }, [comparisonFiles, referenceFile, selectedMetric, selection])

  const comparisonRowsOverall = useMemo(
    () => selectedMetric === 'power'
      ? buildComparisonRows(
          referenceFile,
          comparisonFiles,
          fileStatsOverall,
        )
      : [],
    [comparisonFiles, fileStatsOverall, referenceFile, selectedMetric],
  )

  const comparisonRowsSelection = useMemo(
    () => selectedMetric === 'power' && selection && fileStatsSelection
      ? buildComparisonRows(
          referenceFile,
          comparisonFiles,
          fileStatsSelection,
          selection,
        )
      : null,
    [comparisonFiles, fileStatsSelection, referenceFile, selectedMetric, selection],
  )

  if (activeFiles.length === 0) {
    return null
  }

  const metricLabel = METRIC_LABELS[selectedMetric]
  const metricUnit = METRIC_UNITS[selectedMetric]
  const showSelection = selection !== null && fileStatsSelection !== null
  const activeScope: Scope = showSelection ? scope : 'overall'

  const fileStats = activeScope === 'selection' && fileStatsSelection ? fileStatsSelection : fileStatsOverall
  const pairwiseStats = activeScope === 'selection' && pairwiseStatsSelection ? pairwiseStatsSelection : pairwiseStatsOverall
  const comparisonRows = activeScope === 'selection' && comparisonRowsSelection
    ? comparisonRowsSelection
    : comparisonRowsOverall
  const showPowerComparison = selectedMetric === 'power' && activeFiles.length >= 2

  return (
    <div className="bg-white border-t p-4" style={{ borderColor: 'var(--border-subtle)' }}>
      {/* Header row: metric + scope toggle (when a selection is active) */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <h3 className="text-base font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>
          {metricLabel}
        </h3>

        {showSelection && (
          <div className="flex items-center gap-3 flex-wrap">
            <ScopeToggle value={activeScope} onChange={setScope} />
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {formatClock(selection.fromTime)} - {formatClock(selection.toTime)} ({formatDuration(selection.toTime - selection.fromTime)})
            </span>
            <button
              type="button"
              onClick={() => setSelection(null)}
              className="text-xs underline"
              style={{ color: 'var(--text-muted)' }}
            >
              Clear selection
            </button>
          </div>
        )}
      </div>

      {showPowerComparison
        ? (
            <ComparisonView
              rows={comparisonRows}
              scopeLabel={activeScope === 'selection' ? 'in selection' : undefined}
            />
          )
        : <PrimaryStats activeFiles={activeFiles} stats={fileStats} unit={metricUnit} />}

      {!showPowerComparison && pairwiseStats.length > 0 && referenceFile && (
        <PairwiseStrip
          referenceFile={referenceFile}
          comparisonFiles={comparisonFiles}
          stats={pairwiseStats}
          scopeLabel={activeScope === 'selection' ? 'in selection' : null}
        />
      )}
    </div>
  )
}

function buildComparisonRows(
  referenceFile: FileEntry | undefined,
  comparisonFiles: FileEntry[],
  fileStats: Map<string, FileStats>,
  range?: { fromTime: number; toTime: number },
): ComparisonRow[] {
  if (!referenceFile) return []
  const referenceFileStats = fileStats.get(referenceFile.id)
  if (!referenceFileStats) return []

  return comparisonFiles.map((comparisonFile) => {
    const comparisonFileStats = fileStats.get(comparisonFile.id)!

    const alignmentFailed = referenceFile.alignmentResult?.status === 'failed'
      || comparisonFile.alignmentResult?.status === 'failed'

    return {
      referenceFile,
      comparisonFile,
      referenceFileStats,
      comparisonFileStats,
      comparisonStats: alignmentFailed
        ? null
        : computeComparisonStats(
            referenceFile.resampledSeries!,
            comparisonFile.resampledSeries!,
            'power',
            referenceFile.alignmentResult,
            comparisonFile.alignmentResult,
            { range, marginPercent: 3, marginFloor: 5 },
          ),
      unavailableReason: alignmentFailed ? 'Agreement unavailable because alignment failed.' : undefined,
    }
  })
}

function ScopeToggle({
  value,
  onChange,
}: {
  value: Scope
  onChange: (scope: Scope) => void
}) {
  const baseBtn: React.CSSProperties = {
    fontSize: '12px',
    fontWeight: 500,
    padding: '4px 12px',
    borderRadius: '999px',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-muted)',
    cursor: 'pointer',
  }
  const activeBtn: React.CSSProperties = {
    ...baseBtn,
    background: 'var(--bg-surface)',
    color: 'var(--accent)',
    boxShadow: 'var(--shadow-sm)',
  }
  return (
    <div
      role="tablist"
      aria-label="Stats scope"
      className="inline-flex"
      style={{
        background: 'var(--bg-subtle)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '999px',
        padding: '3px',
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={value === 'selection'}
        style={value === 'selection' ? activeBtn : baseBtn}
        onClick={() => onChange('selection')}
      >
        Selection
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'overall'}
        style={value === 'overall' ? activeBtn : baseBtn}
        onClick={() => onChange('overall')}
      >
        Overall
      </button>
    </div>
  )
}

function PrimaryStats({
  activeFiles,
  stats,
  unit,
}: {
  activeFiles: FileEntry[]
  stats: Map<string, FileStats>
  unit: string
}) {
  return (
    <div className="flex flex-col gap-2" aria-label="Per-file statistics">
      {activeFiles.map((f) => (
        <FigureRow key={f.id} file={f} stats={stats.get(f.id)!} unit={unit} />
      ))}
    </div>
  )
}

function FigureRow({
  file,
  stats,
  unit,
}: {
  file: FileEntry
  stats: FileStats
  unit: string
}) {
  return (
    <div
      className="stat-row grid items-center gap-x-6 gap-y-3 px-4 py-3 rounded-md border"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--bg-surface)',
      }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: getFileColor(file.colorIndex) }}
          />
          <span
            className="text-xs font-medium truncate"
            style={{ color: 'var(--text-secondary)' }}
            title={file.name}
          >
            {file.name}
          </span>
        </div>
        <div className="flex items-baseline">
          <span className="stat-figure">{fmt(stats.mean, 1)}</span>
          <span className="stat-figure-unit">{unit} mean</span>
        </div>
      </div>
      <div className="stat-support-grid grid gap-3">
        <SuppStat label="Max" value={fmt(stats.max, 1)} />
        <SuppStat label="Min" value={fmt(stats.min, 1)} />
        <SuppStat label="SD" value={fmt(stats.stddev, 1)} />
        <SuppStat label="N" value={String(stats.n)} />
      </div>
    </div>
  )
}

function SuppStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="stat-supp-label">{label}</span>
      <span className="stat-supp-num">{value}</span>
    </div>
  )
}

function PairwiseStrip({
  referenceFile,
  comparisonFiles,
  stats,
  scopeLabel,
}: {
  referenceFile: FileEntry
  comparisonFiles: FileEntry[]
  stats: PairwiseStats[]
  scopeLabel: string | null
}) {
  if (comparisonFiles.length === 0) return null
  return (
    <div
      className="mt-4 rounded-md px-4 py-3"
      aria-label="Pairwise comparisons"
      style={{ background: 'var(--stats-secondary-bg)', border: '1px solid var(--border-subtle)' }}
    >
      <div
        className="text-[10px] font-medium uppercase mb-2"
        style={{ color: 'var(--text-muted)', letterSpacing: '0.08em' }}
      >
        Pairwise vs {referenceFile.name}{scopeLabel ? ` (${scopeLabel})` : ''}
      </div>
      <div className="flex flex-col gap-1.5">
        {comparisonFiles.map((f, pi) => {
          const s = stats[pi]
          return (
            <div key={f.id} className="flex items-center gap-2 flex-wrap text-xs" style={{ color: 'var(--text-secondary)' }}>
              <span className="inline-flex items-center gap-1.5 min-w-0" style={{ minWidth: 240 }}>
                <span
                  className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: getFileColor(referenceFile.colorIndex) }}
                />
                <span style={{ color: 'var(--text-muted)' }}>vs</span>
                <span
                  className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: getFileColor(f.colorIndex) }}
                />
                <span className="truncate" title={f.name}>{f.name}</span>
              </span>
              <PairStat label="r" value={fmt(s?.r ?? null, 4)} />
              <PairStat label="MAE" value={fmt(s?.mae ?? null, 2)} />
              <PairStat label="MPE %" value={fmt(s?.mpe ?? null, 2)} />
              <PairStat label="N" value={String(s?.n ?? 0)} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PairStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="pairwise-strip-num">{value}</span>
    </span>
  )
}
