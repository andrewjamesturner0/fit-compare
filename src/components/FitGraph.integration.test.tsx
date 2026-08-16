import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type uPlot from 'uplot'
import { FitGraph } from './FitGraph'
import { useStore } from '../store'
import type { FileEntry, FitRecord } from '../types'

const trackedUPlot = vi.hoisted(() => ({
  latestInstance: null as uPlot | null,
}))

vi.mock('uplot', async (importOriginal) => {
  const realModule = await importOriginal()
  const RealUPlot = (realModule as { default: typeof uPlot }).default

  class TrackedUPlot extends RealUPlot {
    constructor(...args: ConstructorParameters<typeof RealUPlot>) {
      super(...args)
      trackedUPlot.latestInstance = this
    }
  }

  return { default: TrackedUPlot }
})

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

class Path2DMock {
  constructor() {
    return new Proxy(this, {
      get: (target, property) => (
        property in target
          ? target[property as keyof typeof target]
          : () => undefined
      ),
    })
  }
}

function makeCanvasContext(): CanvasRenderingContext2D {
  const context = new Proxy({}, {
    get(target, property) {
      if (property === 'measureText') return () => ({ width: 10 })
      if (property === 'canvas') return target
      return property in target
        ? target[property as keyof typeof target]
        : () => undefined
    },
    set(target, property, value) {
      Reflect.set(target, property, value)
      return true
    },
  })
  return context as unknown as CanvasRenderingContext2D
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

describe('FitGraph with real uPlot', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.stubGlobal('Path2D', Path2DMock)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(makeCanvasContext)
  })

  afterAll(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    trackedUPlot.latestInstance = null
    useStore.setState({
      files: [makeFileEntry()],
      referenceFileId: '0',
      selectedMetric: 'power',
      selection: null,
    })
  })

  it('stores the selection and zooms after a user drag', async () => {
    const { unmount } = render(<FitGraph />)
    await act(() => new Promise<void>(queueMicrotask))

    const plot = trackedUPlot.latestInstance!
    const width = plot.bbox.width / window.devicePixelRatio
    const height = plot.bbox.height / window.devicePixelRatio
    vi.spyOn(plot.over, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    })
    const expectedFromTime = plot.posToVal(30, 'x')
    const expectedToTime = plot.posToVal(130, 'x')

    await act(async () => {
      plot.over.dispatchEvent(new MouseEvent('mouseenter', {
        bubbles: true,
        clientX: 30,
        clientY: 50,
      }))
      plot.over.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        clientX: 30,
        clientY: 50,
      }))
      const move = new MouseEvent('mousemove', {
        bubbles: true,
        clientX: 130,
        clientY: 50,
      })
      Object.defineProperty(move, 'movementX', { value: 100 })
      plot.over.dispatchEvent(move)
      document.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
        clientX: 130,
        clientY: 50,
      }))
    })

    expect(useStore.getState().selection).toEqual({
      fromTime: expectedFromTime,
      toTime: expectedToTime,
    })
    expect(plot.scales.x.min).toBeCloseTo(expectedFromTime)
    expect(plot.scales.x.max).toBeCloseTo(expectedToTime)
    unmount()
  })
})
