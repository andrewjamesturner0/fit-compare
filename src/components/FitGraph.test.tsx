import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { FitGraph } from './FitGraph'
import { useStore } from '../store'

describe('FitGraph', () => {
  it('renders without crashing with empty state', () => {
    useStore.setState({
      files: [],
      referenceFileId: null,
      selectedMetric: 'power',
    })

    const { container } = render(<FitGraph />)
    expect(container).toBeTruthy()
  })
})
