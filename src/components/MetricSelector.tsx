import { useStore } from '../store'
import { METRIC_KEYS, METRIC_LABELS } from '../types'

export function MetricSelector() {
  const selectedMetric = useStore((s) => s.selectedMetric)
  const setSelectedMetric = useStore((s) => s.setSelectedMetric)
  const files = useStore((s) => s.files)

  // Determine which metrics are present in at least one file
  const availableMetrics = METRIC_KEYS.filter((key) =>
    files.some((f) => f.resampledSeries?.values[key]?.some((v) => v !== null)),
  )

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 bg-white border-b border-gray-200">
      <span className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Metric</span>
      <div className="flex gap-1 flex-wrap">
        {METRIC_KEYS.map((key) => {
          const available = availableMetrics.includes(key)
          const isActive = key === selectedMetric
          return (
            <button
              key={key}
              onClick={() => available && setSelectedMetric(key)}
              disabled={!available}
              className="px-2.5 py-1 text-xs rounded-full border transition-colors"
              style={
                !available
                  ? { background: 'var(--bg-subtle)', color: 'var(--text-muted)', borderColor: 'var(--border-subtle)', cursor: 'not-allowed', opacity: 0.5 }
                  : isActive
                    ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'rgba(11,107,203,0.35)', fontWeight: 500 }
                    : { background: 'var(--bg-surface)', color: 'var(--text-secondary)', borderColor: 'var(--border-default)' }
              }
            >
              {METRIC_LABELS[key]}
            </button>
          )
        })}
      </div>
    </div>
  )
}
