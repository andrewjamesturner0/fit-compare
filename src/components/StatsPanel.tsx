import { useMemo } from 'react'
import { useStore } from '../store'
import { computeFileStats, computePairwiseStats } from '../stats'
import { getFileColor, METRIC_LABELS } from '../types'

function fmt(val: number | null, decimals: number): string {
  if (val === null) return '-'
  return val.toFixed(decimals)
}

export function StatsPanel() {
  const files = useStore((s) => s.files)
  const selectedMetric = useStore((s) => s.selectedMetric)

  const activeFiles = files.filter(
    (f) =>
      f.parseResult?.status !== 'error'
      && f.resampledSeries
      && f.resampledSeries.timestamps.length > 0,
  )

  const fileStats = useMemo(
    () =>
      activeFiles.map((f) =>
        computeFileStats(f.resampledSeries!, selectedMetric),
      ),
    [activeFiles, selectedMetric],
  )

  const pairwiseStats = useMemo(() => {
    if (activeFiles.length < 2) return []
    const ref = activeFiles[0]
    const results = []
    for (let i = 1; i < activeFiles.length; i++) {
      results.push(
        computePairwiseStats(
          ref.resampledSeries!,
          activeFiles[i].resampledSeries!,
          selectedMetric,
          ref.alignmentResult,
          activeFiles[i].alignmentResult,
        ),
      )
    }
    return results
  }, [activeFiles, selectedMetric])

  if (activeFiles.length === 0) {
    return null
  }

  const metricLabel = METRIC_LABELS[selectedMetric]

  return (
    <div className="bg-white border-t p-4" style={{ borderColor: 'var(--border-subtle)' }}>
      <h3 className="text-xs font-semibold mb-3 tracking-wide uppercase" style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
        Statistics — {metricLabel}
      </h3>

      {/* Per-file stats */}
      <table className="w-full text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>
        <thead>
          <tr className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
            <th className="text-left py-1.5 pr-4 font-medium" style={{ color: 'var(--text-muted)' }}>File</th>
            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>Mean</th>
            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>Max</th>
            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>Min</th>
            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>StdDev</th>
            <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>N</th>
          </tr>
        </thead>
        <tbody>
          {activeFiles.map((f, i) => (
            <tr key={f.id} className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              <td className="py-1.5 pr-4 flex items-center gap-1.5">
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: getFileColor(f.colorIndex) }}
                />
                <span className="truncate max-w-[150px]">{f.name}</span>
              </td>
              <td className="text-right py-1.5 px-2 data-num">
                {fmt(fileStats[i].mean, 1)}
              </td>
              <td className="text-right py-1.5 px-2 data-num">
                {fmt(fileStats[i].max, 1)}
              </td>
              <td className="text-right py-1.5 px-2 data-num">
                {fmt(fileStats[i].min, 1)}
              </td>
              <td className="text-right py-1.5 px-2 data-num">
                {fmt(fileStats[i].stddev, 1)}
              </td>
              <td className="text-right py-1.5 px-2 data-num">{fileStats[i].n}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Pairwise comparisons */}
      {activeFiles.length >= 2 && (
        <div>
          <h4 className="text-xs font-semibold mb-2 tracking-wide uppercase" style={{ color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
            Pairwise vs. {activeFiles[0].name}
          </h4>
          <table className="w-full text-xs" style={{ color: 'var(--text-secondary)' }}>
            <thead>
              <tr className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <th className="text-left py-1.5 pr-4 font-medium" style={{ color: 'var(--text-muted)' }}>Comparison</th>
                <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>Pearson r</th>
                <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>MAE</th>
                <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>MPE (%)</th>
                <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-muted)' }}>N</th>
              </tr>
            </thead>
            <tbody>
              {activeFiles.slice(1).map((f, pi) => (
                <tr key={f.id} className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                  <td className="py-1.5 pr-4">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle"
                      style={{ backgroundColor: getFileColor(activeFiles[0].colorIndex) }}
                    />
                    vs
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-full mx-1.5 align-middle"
                      style={{ backgroundColor: getFileColor(f.colorIndex) }}
                    />
                    <span className="truncate max-w-[100px] inline-block align-middle">
                      {f.name}
                    </span>
                  </td>
                  <td className="text-right py-1.5 px-2 data-num">
                    {fmt(pairwiseStats[pi]?.r ?? null, 4)}
                  </td>
                  <td className="text-right py-1.5 px-2 data-num">
                    {fmt(pairwiseStats[pi]?.mae ?? null, 2)}
                  </td>
                  <td className="text-right py-1.5 px-2 data-num">
                    {fmt(pairwiseStats[pi]?.mpe ?? null, 2)}
                  </td>
                  <td className="text-right py-1.5 px-2 data-num">
                    {pairwiseStats[pi]?.n ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
