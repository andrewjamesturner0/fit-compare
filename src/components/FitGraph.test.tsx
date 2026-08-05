import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { FitGraph } from './FitGraph'
import { useStore } from '../store'
import type { FileEntry, FitRecord } from '../types'

const uPlotMock = vi.hoisted(() => {
  class MockUPlot {
    static latestInstance: MockUPlot | null = null
    static latestOptions: Record<string, unknown> | null = null

    select = { left: 0, top: 0, width: 0, height: 0 }
    bbox = { height: 200 }
    scale = { min: 0, max: 10_000 }
    pendingScale: { min: number; max: number } | null = null
    posToVal = vi.fn((position: number) => (
      this.scale.min + (position / 100) * (this.scale.max - this.scale.min)
    ))
    valToPos = vi.fn((value: number) => (
      ((value - this.scale.min) / (this.scale.max - this.scale.min)) * 100
    ))
    setScale = vi.fn((_key: string, limits: { min: number; max: number }) => {
      this.pendingScale = limits
      queueMicrotask(() => this.commitScale())
    })
    batch = vi.fn((transaction: () => void) => {
      transaction()
      this.commitScale()
    })
    setSelect = vi.fn()
    setData = vi.fn()
    setSize = vi.fn()
    destroy = vi.fn()

    constructor(options: Record<string, unknown>) {
      MockUPlot.latestInstance = this
      MockUPlot.latestOptions = options
    }

    private commitScale() {
      if (this.pendingScale) {
        this.scale = this.pendingScale
        this.pendingScale = null
      }
    }
  }

  return { MockUPlot }
})

vi.mock('uplot', () => ({ default: uPlotMock.MockUPlot }))

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

function makeRecord(timestamp: number, power: number): FitRecord {
  return {
    timestamp,
    power,
    cadence: null,
    heartRate: null,
    speed: null,
    distance: null,
    elevation: null,
    temperature: null,
  }
}

function makeFileEntry(): FileEntry {
  return {
    id: '0',
    name: 'ride.fit',
    size: 1,
    file: new File([new Uint8Array(1)], 'ride.fit'),
    colorIndex: 0,
    loading: false,
    parseResult: {
      status: 'ok',
      warnings: [],
      session: {
        startTime: 0,
        deviceName: 'Test device',
        manufacturer: 'Test',
        sport: 'cycling',
        laps: [],
        records: [makeRecord(0, 100), makeRecord(10_000, 200)],
      },
    },
    resampledSeries: {
      timestamps: [0, 10_000],
      values: {
        power: [100, 200],
        cadence: [null, null],
        heartRate: [null, null],
        speed: [null, null],
        elevation: [null, null],
        temperature: [null, null],
      },
    },
    alignmentResult: null,
  }
}

function getSetSelectHook() {
  const options = uPlotMock.MockUPlot.latestOptions as {
    hooks: { setSelect: Array<(instance: InstanceType<typeof uPlotMock.MockUPlot>) => void> }
  }
  return options.hooks.setSelect[0]
}

describe('FitGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    uPlotMock.MockUPlot.latestInstance = null
    uPlotMock.MockUPlot.latestOptions = null
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    useStore.setState({
      files: [],
      referenceFileId: null,
      selectedMetric: 'power',
      selection: null,
    })
  })

  it('renders without crashing with empty state', () => {
    const { container } = render(<FitGraph />)
    expect(container).toBeTruthy()
  })

  it('stores a valid graph selection and zooms to its exact bounds', () => {
    useStore.setState({ files: [makeFileEntry()], referenceFileId: '0' })
    render(<FitGraph />)
    const instance = uPlotMock.MockUPlot.latestInstance!
    instance.setSelect.mockClear()
    instance.select = { left: 20, top: 0, width: 30, height: 200 }

    act(() => getSetSelectHook()(instance))

    expect(useStore.getState().selection).toEqual({
      fromTime: 2_000,
      toTime: 5_000,
    })
    expect(instance.setScale).toHaveBeenCalledOnce()
    expect(instance.setScale).toHaveBeenCalledWith('x', {
      min: 2_000,
      max: 5_000,
    })
    expect(instance.setSelect).toHaveBeenLastCalledWith(
      { left: 0, top: 0, width: 100, height: 200 },
      false,
    )
  })

  it.each([
    { name: 'a cleared brush', width: 0, toTime: 2_000 },
    { name: 'an invalid range', width: 10, toTime: 1_000 },
  ])('does not zoom for $name', ({ width, toTime }) => {
    useStore.setState({ files: [makeFileEntry()], referenceFileId: '0' })
    render(<FitGraph />)
    const instance = uPlotMock.MockUPlot.latestInstance!
    instance.select = { left: 20, top: 0, width, height: 200 }
    instance.posToVal.mockImplementation((position) => (
      position === 20 + width ? toTime : position * 100
    ))

    act(() => getSetSelectHook()(instance))

    expect(useStore.getState().selection).toBeNull()
    expect(instance.setScale).not.toHaveBeenCalled()
  })
})
