import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { StatsPanel } from './StatsPanel'
import { useStore } from '../store'
import type { FileEntry, MetricKey, ResampledSeries } from '../types'

const M: MetricKey[] = ['power', 'cadence', 'heartRate', 'speed', 'elevation', 'temperature']

function makeSeries(
  values: (number | null)[],
  startMs = 0,
  metric: MetricKey = 'power',
): ResampledSeries {
  const timestamps = values.map((_, i) => startMs + i * 1000)
  const v = {} as Record<MetricKey, (number | null)[]>
  for (const key of M) {
    v[key] = key === metric ? values : Array(values.length).fill(null)
  }
  return { timestamps, values: v }
}

function makeFileEntry(id: string, name: string, series: ResampledSeries, offsetSeconds = 0): FileEntry {
  return {
    id,
    name,
    size: 1,
    file: new File([new Uint8Array(1)], name),
    colorIndex: Number(id),
    loading: false,
    parseResult: { status: 'ok', warnings: [] },
    resampledSeries: series,
    alignmentResult: {
      status: 'ok',
      segments: [
        {
          fromTime: series.timestamps[0],
          toTime: series.timestamps[series.timestamps.length - 1],
          offsetSeconds,
        },
      ],
    },
  }
}

describe('StatsPanel', () => {
  beforeEach(() => {
    useStore.setState({
      files: [],
      referenceFileId: null,
      selectedMetric: 'power',
      selection: null,
    })
  })

  it('renders nothing with no files', () => {
    const { container } = render(<StatsPanel />)
    expect(container.firstChild).toBeNull()
  })

  it('shows overall stats and no scope toggle when there is no selection', () => {
    const file = makeFileEntry('0', 'a.fit', makeSeries([100, 200, 300, 400, 500]))
    useStore.setState({ files: [file], referenceFileId: '0' })

    render(<StatsPanel />)
    // No scope toggle when there is no selection
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByText('Clear selection')).toBeNull()
    // Full-file mean of [100..500] = 300.0
    expect(screen.getByText('300.0')).toBeTruthy()
    // Full-file max = 500.0
    expect(screen.getByText('500.0')).toBeTruthy()
    expect(screen.getByText('W mean')).toBeTruthy()
  })

  it('labels the mean with the selected metric unit', () => {
    const file = makeFileEntry('0', 'a.fit', makeSeries([80, 90, 100], 0, 'cadence'))
    useStore.setState({
      files: [file],
      referenceFileId: '0',
      selectedMetric: 'cadence',
    })

    render(<StatsPanel />)
    expect(screen.getByText('Cadence (rpm)')).toBeTruthy()
    expect(screen.getByText('rpm mean')).toBeTruthy()
    expect(screen.queryByText('W mean')).toBeNull()
  })

  it('defaults to selection scope when a selection is active', () => {
    const file = makeFileEntry('0', 'a.fit', makeSeries([100, 200, 300, 400, 500]))
    useStore.setState({ files: [file], referenceFileId: '0' })
    // Range covers timestamps 1000, 2000 -> values 200, 300 -> mean 250
    useStore.getState().setSelection({ fromTime: 1000, toTime: 2000 })

    render(<StatsPanel />)
    // Toggle exists, with both options visible
    const tablist = screen.getByRole('tablist')
    expect(within(tablist).getByText('Selection')).toBeTruthy()
    expect(within(tablist).getByText('Overall')).toBeTruthy()
    // Selection mean (250) is shown by default
    expect(screen.getByText('250.0')).toBeTruthy()
    // Selection max (300) is shown
    expect(screen.getByText('300.0')).toBeTruthy()
    // Full-ride max (500) is NOT shown - we are in selection scope
    expect(screen.queryByText('500.0')).toBeNull()
  })

  it('switches to overall scope when the Overall toggle is clicked', () => {
    const file = makeFileEntry('0', 'a.fit', makeSeries([100, 200, 300, 400, 500]))
    useStore.setState({ files: [file], referenceFileId: '0' })
    useStore.getState().setSelection({ fromTime: 1000, toTime: 2000 })

    render(<StatsPanel />)
    const tablist = screen.getByRole('tablist')
    fireEvent.click(within(tablist).getByText('Overall'))

    // Now showing full-ride numbers: mean 300, max 500
    expect(screen.getByText('300.0')).toBeTruthy()
    expect(screen.getByText('500.0')).toBeTruthy()
    // The selection-only mean (250) is no longer rendered
    expect(screen.queryByText('250.0')).toBeNull()
  })

  it('Clear selection button resets the store selection', () => {
    const file = makeFileEntry('0', 'a.fit', makeSeries([100, 200, 300]))
    useStore.setState({ files: [file], referenceFileId: '0' })
    useStore.getState().setSelection({ fromTime: 0, toTime: 1000 })

    render(<StatsPanel />)
    expect(useStore.getState().selection).not.toBeNull()
    screen.getByText('Clear selection').click()
    expect(useStore.getState().selection).toBeNull()
  })

  it('renders pairwise comparisons in the demoted strip when there are 2+ files', () => {
    const f1 = makeFileEntry('0', 'ref.fit', makeSeries([100, 200, 300, 400, 500]))
    const f2 = makeFileEntry('1', 'other.fit', makeSeries([110, 210, 310, 410, 510]))
    useStore.setState({ files: [f1, f2], referenceFileId: '0' })

    render(<StatsPanel />)
    const primary = screen.getByLabelText('Per-file statistics')
    const strip = screen.getByLabelText('Pairwise comparisons')
    // The non-reference file name appears in the strip
    expect(within(strip).getByText('other.fit')).toBeTruthy()
    expect(within(primary).queryByText(/Pairwise vs/)).toBeNull()
  })

  it('does not render the pairwise strip when only one file is loaded', () => {
    const file = makeFileEntry('0', 'a.fit', makeSeries([100, 200, 300]))
    useStore.setState({ files: [file], referenceFileId: '0' })

    render(<StatsPanel />)
    expect(screen.queryByText(/Pairwise vs/)).toBeNull()
  })
})
