import type { ComparisonStats, FileStats } from '../stats'
import { getFileColor } from '../types'
import type { FileEntry } from '../types'

export interface ComparisonRow {
  referenceFile: FileEntry
  comparisonFile: FileEntry
  referenceFileStats: FileStats
  comparisonFileStats: FileStats
  comparisonStats: ComparisonStats | null
  unavailableReason?: string
}

interface ComparisonViewProps {
  rows: ComparisonRow[]
  scopeLabel?: string
}

const VERDICT_COPY: Record<ComparisonStats['conclusion'], string> = {
  equivalent: 'Equivalent within tolerance',
  different: 'Difference exceeds tolerance',
  inconclusive: 'Inconclusive',
  'insufficient-data': 'Insufficient paired data',
}

function fmt(value: number | null, decimals = 1): string {
  return value === null ? '-' : value.toFixed(decimals)
}

function fmtSigned(value: number | null, decimals = 1): string {
  if (value === null) return '-'
  const formatted = value.toFixed(decimals)
  return value > 0 ? `+${formatted}` : formatted
}

function fmtUnit(value: number | null, unit: string, decimals = 1): string {
  if (value === null) return '-'
  const separator = unit === '%' ? '' : ' '
  return `${value.toFixed(decimals)}${separator}${unit}`
}

function fmtSignedUnit(value: number | null, unit: string, decimals = 1): string {
  return value === null ? '-' : `${fmtSigned(value, decimals)} ${unit}`
}

function effectLabel(value: number | null): string | null {
  if (value === null) return null
  const magnitude = Math.abs(value)
  if (magnitude < 0.2) return 'Negligible'
  if (magnitude < 0.5) return 'Small'
  if (magnitude < 0.8) return 'Medium'
  return 'Large'
}

function cccLabel(value: number | null): string | null {
  if (value === null) return null
  if (value > 0.99) return 'Almost perfect'
  if (value >= 0.95) return 'Substantial'
  if (value >= 0.9) return 'Moderate'
  return 'Poor'
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

export function ComparisonView({ rows, scopeLabel }: ComparisonViewProps) {
  if (rows.length === 0) return null

  return (
    <div aria-label="Power agreement comparisons" className="comparison-view">
      <div className="comparison-view-heading">
        Power agreement{scopeLabel ? ` ${scopeLabel}` : ''}
      </div>
      <div className="flex flex-col gap-5">
        {rows.map((row) => (
          <ComparisonGroup key={row.comparisonFile.id} row={row} />
        ))}
      </div>
      <p className="comparison-caveat">
        Confidence intervals and verdicts are approximate descriptive summaries. Adjacent 1 Hz readings are autocorrelated, so the interval can be narrower than the effective amount of independent data supports.
      </p>
    </div>
  )
}

function ComparisonGroup({ row }: { row: ComparisonRow }) {
  const stats = row.comparisonStats
  const conclusion = stats?.conclusion ?? 'insufficient-data'
  const verdict = VERDICT_COPY[conclusion]

  return (
    <section
      aria-label={`${row.referenceFile.name} compared with ${row.comparisonFile.name}`}
      className="comparison-group"
    >
      <div className="comparison-pair-heading">
        <FileDot file={row.referenceFile} />
        <span className="comparison-pair-name" title={row.referenceFile.name}>{row.referenceFile.name}</span>
        <span className="comparison-pair-vs">vs</span>
        <FileDot file={row.comparisonFile} />
        <span className="comparison-pair-name" title={row.comparisonFile.name}>{row.comparisonFile.name}</span>
      </div>

      <div className={`comparison-verdict comparison-verdict-${conclusion}`} role="status">
        <span className="comparison-verdict-dot" aria-hidden="true" />
        <strong>{verdict}</strong>
        <span className="comparison-verdict-meta">
          {stats && stats.ciLower !== null && stats.ciUpper !== null && stats.equivalenceMargin !== null
            ? `90% CI ${fmtSigned(stats.ciLower)} to ${fmtSigned(stats.ciUpper)} W; tolerance +/-${fmt(stats.equivalenceMargin)} W; paired N ${stats.n}`
            : `${row.unavailableReason ?? 'At least two paired samples are required.'} Paired N ${stats?.n ?? 0}`}
        </span>
      </div>

      <ToleranceSummary stats={stats} />

      <div className="comparison-cards">
        <FileCard file={row.referenceFile} stats={row.referenceFileStats} reference />
        <DeltaCard stats={stats} unavailableReason={row.unavailableReason} />
        <FileCard file={row.comparisonFile} stats={row.comparisonFileStats} />
      </div>

      <SupportingStats stats={stats} />
    </section>
  )
}

function FileDot({ file }: { file: FileEntry }) {
  return (
    <span
      className="comparison-file-dot"
      style={{ backgroundColor: getFileColor(file.colorIndex) }}
      aria-hidden="true"
    />
  )
}

function FileCard({
  file,
  stats,
  reference = false,
}: {
  file: FileEntry
  stats: FileStats
  reference?: boolean
}) {
  return (
    <div className="comparison-file-card">
      <div className="comparison-file-header">
        <FileDot file={file} />
        <div className="min-w-0">
          <div className="comparison-file-name" title={file.name}>{file.name}</div>
          <div className="comparison-file-meta">
            {reference ? 'Reference - ' : ''}{stats.n.toLocaleString()} scoped samples
          </div>
        </div>
      </div>
      <CardStat label="Mean power" value={fmtUnit(stats.mean, 'W')} />
      <CardStat label="Max power" value={fmtUnit(stats.max, 'W')} />
      <CardStat label="Std dev" value={fmtUnit(stats.stddev, 'W')} />
      <CardStat label="N" value={stats.n.toLocaleString()} />
    </div>
  )
}

function CardStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="comparison-card-stat">
      <span>{label}</span>
      <span className="comparison-number">{value}</span>
    </div>
  )
}

function ToleranceSummary({ stats }: { stats: ComparisonStats | null }) {
  if (!stats || stats.equivalenceMargin === null) {
    return <div className="comparison-tolerance-copy">Tolerance unavailable</div>
  }

  return (
    <div className="comparison-tolerance-copy">
      Tolerance: <span className="comparison-number">+/-{fmt(stats.equivalenceMargin)} W</span>
      {' '}(3% of the paired grand mean{stats.marginFloorApplied ? ', 5 W floor applied' : ''})
    </div>
  )
}

function DeltaCard({
  stats,
  unavailableReason,
}: {
  stats: ComparisonStats | null
  unavailableReason?: string
}) {
  return (
    <div className="comparison-delta-card">
      <div className="comparison-delta-label">Mean bias</div>
      <div className="comparison-delta-value">{fmtSignedUnit(stats?.bias ?? null, 'W')}</div>
      <div className="comparison-delta-sub">
        {stats?.biasPercent === null || stats?.biasPercent === undefined
          ? '-'
          : `${fmtSigned(stats.biasPercent)}% of mean`}
      </div>
      <div className="comparison-sign-copy">Comparison minus reference</div>
      {stats
        ? <TolerancePlot stats={stats} />
        : <div className="comparison-unavailable">{unavailableReason ?? 'Agreement unavailable'}</div>}
      <div className="comparison-delta-sub">
        Limits of agreement: {fmtSignedUnit(stats?.loaLower ?? null, 'W')} to {fmtSignedUnit(stats?.loaUpper ?? null, 'W')}
      </div>
    </div>
  )
}

function TolerancePlot({ stats }: { stats: ComparisonStats }) {
  const margin = stats.equivalenceMargin
  const ciLower = stats.ciLower
  const ciUpper = stats.ciUpper
  const bias = stats.bias

  if (margin === null || ciLower === null || ciUpper === null || bias === null) {
    return <div className="comparison-unavailable">Interval unavailable</div>
  }

  const scale = Math.max(margin, Math.abs(ciLower), Math.abs(ciUpper), Number.EPSILON)
  const position = (value: number) => clampPercent((value + scale) / (2 * scale) * 100)
  const bandStart = position(-margin)
  const bandEnd = position(margin)
  const ciStart = position(ciLower)
  const ciEnd = position(ciUpper)

  return (
    <div
      className="comparison-tolerance-visual"
      role="img"
      aria-label={`Tolerance from ${fmtSigned(-margin)} to ${fmtSigned(margin)} W; 90% confidence interval from ${fmtSigned(ciLower)} to ${fmtSigned(ciUpper)} W; bias ${fmtSigned(bias)} W`}
    >
      <div className="comparison-tolerance-track">
        <span
          className="comparison-tolerance-band"
          style={{ left: `${bandStart}%`, width: `${Math.max(0, bandEnd - bandStart)}%` }}
        />
        <span
          className="comparison-ci-line"
          style={{ left: `${ciStart}%`, width: `${Math.max(0, ciEnd - ciStart)}%` }}
        />
        <span className="comparison-bias-marker" style={{ left: `${position(bias)}%` }} />
      </div>
      <div className="comparison-tolerance-axis" aria-hidden="true">
        <span>{fmtSigned(-scale)}</span><span>0</span><span>{fmtSigned(scale)} W</span>
      </div>
    </div>
  )
}

function SupportingStats({ stats }: { stats: ComparisonStats | null }) {
  return (
    <div className="comparison-supporting" aria-label="Supporting agreement statistics">
      <MetricChip label="CCC" value={fmt(stats?.ccc ?? null, 3)} note={cccLabel(stats?.ccc ?? null)} />
      <MetricChip
        label="RMSE"
        value={fmtUnit(stats?.rmse ?? null, 'W')}
        note={stats?.rmsePercent === null || stats?.rmsePercent === undefined ? null : `${fmt(stats.rmsePercent)}% of mean`}
      />
      <MetricChip label="Cohen's dz" value={fmt(stats?.cohensDz ?? null, 3)} note={effectLabel(stats?.cohensDz ?? null)} />
      <MetricChip label="Pearson r" value={fmt(stats?.r ?? null, 3)} />
      <MetricChip label="CV of differences" value={fmtUnit(stats?.cvDiff ?? null, '%')} />
      <MetricChip label="MAE" value={fmtUnit(stats?.mae ?? null, 'W')} />
    </div>
  )
}

function MetricChip({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note?: string | null
}) {
  return (
    <div className="comparison-metric-chip">
      <span className="comparison-metric-label">{label}</span>
      <span className="comparison-number comparison-metric-value">{value}</span>
      {note && <span className="comparison-metric-note">{note}</span>}
    </div>
  )
}
