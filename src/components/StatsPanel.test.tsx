import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatsPanel } from './StatsPanel'
import { useStore } from '../store'
import type { FileEntry, MetricKey, ResampledSeries } from '../types'

const M: MetricKey[] = ['power', 'cadence', 'heartRate', 'speed', 'elevation', 'temperature']

function makeSeries(values: (number | null)[], startMs = 0): ResampledSeries {
  const timestamps = values.map((_, i) => startMs + i * 1000)
  const v = {} as Record<MetricKey, (number | null)[]>
  for (const key of M) {
    v[key] = key === 'power' ? values : Array(values.length).fill(null)
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

  it('shows full-file stats and no selection block when selection is null', () => {
    const file = makeFileEntry('0', 'a.fit', makeSeries([100, 200, 300, 400, 500]))
    useStore.setState({ files: [file], referenceFileId: '0' })

    render(<StatsPanel />)
    expect(screen.queryByText(/Selection:/)).toBeNull()
    expect(screen.queryByText(/Clear selection/)).toBeNull()
    // Full-file mean of [100..500] = 300.0
    expect(screen.getByText('300.0')).toBeTruthy()
  })

  it('renders a selection block whose stats differ from the full-file stats', () => {
    const file = makeFileEntry('0', 'a.fit', makeSeries([100, 200, 300, 400, 500]))
    useStore.setState({ files: [file], referenceFileId: '0' })
    // Range covers timestamps 1000, 2000 -> values 200, 300 -> mean 250
    useStore.getState().setSelection({ fromTime: 1000, toTime: 2000 })

    render(<StatsPanel />)
    expect(screen.getByText(/Selection:/)).toBeTruthy()
    expect(screen.getByText(/Clear selection/)).toBeTruthy()
    // Full-file mean (300) is also the selection's max, so the value appears twice
    expect(screen.getAllByText('300.0').length).toBeGreaterThanOrEqual(2)
    // Selection mean (250) appears only in the selection block
    expect(screen.getByText('250.0')).toBeTruthy()
    // Full-file max (500) only appears in the full-file block
    expect(screen.getByText('500.0')).toBeTruthy()
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
})
