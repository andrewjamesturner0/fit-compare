import { useStore } from './store'
import { FileDropZone } from './components/FileDropZone'
import { MetricSelector } from './components/MetricSelector'
import { FitGraph } from './components/FitGraph'
import { StatsPanel } from './components/StatsPanel'
import { OffsetControls } from './components/OffsetControls'

function App() {
  const clearAll = useStore((s) => s.clearAll)
  const files = useStore((s) => s.files)

  const hasAlignmentFailure = files.some(
    (f) => f.alignmentResult?.status === 'failed',
  )

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2.5 bg-white border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-4 rounded-sm" style={{ backgroundColor: '#0072B2' }} />
          <h1 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>FIT Compare</h1>
        </div>
        {files.length > 0 && (
          <button
            onClick={clearAll}
            className="px-3 py-1 text-xs rounded-md border transition-colors"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-default)', background: 'var(--bg-surface)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-subtle)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-surface)')}
          >
            Clear all
          </button>
        )}
      </header>

      {/* File drop zone */}
      <FileDropZone />

      {/* Alignment failure warning */}
      {hasAlignmentFailure && (
        <div className="px-4 py-2 text-sm border-b" style={{ background: 'var(--warn-bg)', borderColor: 'var(--warn-border)', color: 'var(--warn-text)' }}>
          Could not auto-align one or more files. Clock-time alignment in use.
          Try adjusting offsets manually.
        </div>
      )}

      {/* Metric selector */}
      <MetricSelector />

      {/* Main content: graph + stats + offset controls */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Graph fills available space */}
        <FitGraph />

        {/* Stats panel */}
        <div className="overflow-y-auto min-h-0 max-h-[50vh]">
          <StatsPanel />

          {/* Offset controls */}
          <OffsetControls />
        </div>
      </div>
    </div>
  )
}

export default App
