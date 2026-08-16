import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ComparisonConclusion, ComparisonStats, FileStats } from '../stats'
import type { FileEntry } from '../types'
import { ComparisonView } from './ComparisonView'
import type { ComparisonRow } from './ComparisonView'

const fileStats: FileStats = {
  mean: 200,
  max: 500,
  min: 0,
  stddev: 80,
  n: 120,
}

function makeFile(id: string, name: string, colorIndex: number): FileEntry {
  return {
    id,
    name,
    size: 1,
    file: new File([new Uint8Array(1)], name),
    colorIndex,
    loading: false,
    parseResult: { status: 'ok', warnings: [] },
    resampledSeries: null,
    alignmentResult: null,
  }
}

function makeStats(conclusion: ComparisonConclusion): ComparisonStats {
  if (conclusion === 'insufficient-data') {
    return {
      grandMean: null,
      bias: null,
      biasPercent: null,
      sdDiff: null,
      loaLower: null,
      loaUpper: null,
      loaLowerPercent: null,
      loaUpperPercent: null,
      equivalenceMargin: null,
      equivalenceMarginPercent: null,
      marginFloorApplied: null,
      ciLower: null,
      ciUpper: null,
      conclusion,
      cohensDz: null,
      ccc: null,
      rmse: null,
      rmsePercent: null,
      cvDiff: null,
      r: null,
      mae: null,
      mpe: null,
      n: 1,
    }
  }

  return {
    grandMean: 202,
    bias: 4,
    biasPercent: 1.98,
    sdDiff: 3,
    loaLower: -1.88,
    loaUpper: 9.88,
    loaLowerPercent: -0.93,
    loaUpperPercent: 4.89,
    equivalenceMargin: 6.06,
    equivalenceMarginPercent: 3,
    marginFloorApplied: false,
    ciLower: 3.55,
    ciUpper: 4.45,
    conclusion,
    cohensDz: 1.333,
    ccc: 0.96,
    rmse: 5,
    rmsePercent: 2.48,
    cvDiff: 1.49,
    r: 0.98,
    mae: 4.2,
    mpe: 2.1,
    n: 120,
  }
}

function makeRow(conclusion: ComparisonConclusion): ComparisonRow {
  return {
    referenceFile: makeFile('ref', 'Reference.fit', 0),
    comparisonFile: makeFile('other', 'Comparison.fit', 1),
    referenceFileStats: fileStats,
    comparisonFileStats: { ...fileStats, mean: 204, max: 510 },
    comparisonStats: makeStats(conclusion),
  }
}

describe('ComparisonView', () => {
  it.each([
    ['equivalent', 'Equivalent within tolerance'],
    ['different', 'Difference exceeds tolerance'],
    ['inconclusive', 'Inconclusive'],
    ['insufficient-data', 'Insufficient paired data'],
  ] as const)('renders the %s verdict in visible text', (conclusion, copy) => {
    render(<ComparisonView rows={[makeRow(conclusion)]} />)
    expect(screen.getByRole('status')).toHaveTextContent(copy)
  })

  it('renders file cards, paired N, sign convention, metrics, and the CI visual', () => {
    render(<ComparisonView rows={[makeRow('equivalent')]} scopeLabel="in selection" />)

    const group = screen.getByRole('region', { name: 'Reference.fit compared with Comparison.fit' })
    expect(within(group).getAllByText('Reference.fit').length).toBeGreaterThan(0)
    expect(within(group).getAllByText('Comparison.fit').length).toBeGreaterThan(0)
    expect(within(group).getByText('Reference - 120 scoped samples')).toBeInTheDocument()
    expect(within(group).getByText('Comparison minus reference')).toBeInTheDocument()
    expect(within(group).getByRole('status')).toHaveTextContent('paired N 120')
    expect(within(group).getByRole('img', { name: /90% confidence interval/ })).toBeInTheDocument()

    const supporting = within(group).getByLabelText('Supporting agreement statistics')
    for (const label of ['CCC', 'RMSE', "Cohen's dz", 'Pearson r', 'CV of differences', 'MAE']) {
      expect(within(supporting).getByText(label)).toBeInTheDocument()
    }
    expect(within(supporting).getByText('Substantial')).toBeInTheDocument()
    expect(within(supporting).getByText('Large')).toBeInTheDocument()
    expect(screen.getByText('Power agreement in selection')).toBeInTheDocument()
  })

  it('explains when the 5 W tolerance floor is applied', () => {
    const row = makeRow('equivalent')
    row.comparisonStats = {
      ...row.comparisonStats!,
      equivalenceMargin: 5,
      equivalenceMarginPercent: 4.2,
      marginFloorApplied: true,
    }

    render(<ComparisonView rows={[row]} />)
    expect(screen.getByText(/3% of the paired grand mean, 5 W floor applied/)).toBeInTheDocument()
  })

  it('formats unavailable values as a dash and shows the caveat once', () => {
    render(<ComparisonView rows={[makeRow('insufficient-data')]} />)

    const group = screen.getByRole('region', { name: /Reference.fit compared with Comparison.fit/ })
    expect(within(group).getAllByText('-').length).toBeGreaterThan(4)
    expect(within(group).getByRole('status')).toHaveTextContent('At least two paired samples are required')
    expect(screen.getAllByText(/Adjacent 1 Hz readings are autocorrelated/)).toHaveLength(1)
  })

  it('shows an explicit unavailable reason while retaining both file cards', () => {
    const row = makeRow('insufficient-data')
    row.comparisonStats = null
    row.unavailableReason = 'Agreement unavailable because alignment failed.'

    render(<ComparisonView rows={[row]} />)
    expect(screen.getAllByText('Agreement unavailable because alignment failed.').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Reference.fit').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Comparison.fit').length).toBeGreaterThan(0)
  })
})
