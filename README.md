# FIT Compare

A client-side single-page webapp that parses multiple .fit cycling files, auto-aligns their timestamps, overlays them on an interactive graph, and computes descriptive statistics to assess how closely the recordings match.

Primary use case: comparing power meters on the same ride.

## Usage

1. Open the app in a browser
2. Drop one or more `.fit` files onto the drop zone (or click to browse)
3. Files are automatically parsed and aligned
4. Use the metric selector to switch between power, cadence, heart rate, speed, elevation, and temperature
5. Zoom by scrolling; pan by click-dragging
6. Drag horizontally on the graph to select a time range. The stats panel adds a "Selection" block showing stats restricted to that range, alongside the full-file stats. Click "Clear selection" (or click the graph) to dismiss
7. The stats panel below the graph shows descriptive statistics and pairwise comparisons
8. Expand "Adjust Offsets" to manually correct alignment if auto-alignment gets it wrong

## Build and run

```bash
npm install
npm run dev      # development server
npm run build    # production build
npm run preview  # preview production build
```

## How it works

### Data pipeline

`File -> parser.ts -> FitSession -> resample.ts -> 1 Hz ResampledSeries -> align.ts -> OffsetSegment[] -> graph + stats`

### Alignment

The three-pass auto-alignment algorithm:

1. **Global offset** -- cross-correlates power traces (falling back to HR, then speed) over +-5 minutes to find the best global time offset
2. **Pause detection** -- walks aligned traces and detects contiguous gaps > 10 seconds where one file has data but the other doesn't
3. **Segment re-anchoring** -- for each post-pause segment, cross-correlates again to find a per-segment correction offset

If correlation confidence is too low, the file falls back to clock-time alignment and a warning is shown.

### Stats

- **Per-file:** mean, max, min, standard deviation (computed on the 1 Hz resampled grid, nulls excluded)
- **Pairwise:** Pearson r, MAE, MPE (first uploaded file is used as reference for MPE; values near zero are excluded to avoid division blow-up)
- Pause regions and nulls are excluded pairwise from all comparisons
- Zeros are kept (coasting power is real data)
- **Selection scope:** when a time range is selected on the graph, the stats panel adds a second block recomputed over only that range. Selections are stored on the reference (aligned) timebase; for non-reference files the range is translated through their alignment offsets before filtering, so the right slice of each file is included regardless of per-file offset. Selections are clamped to the visible data extent and survive metric switches and offset nudges; they are cleared when all files are removed or when nudges push them out of bounds

### Graph vs stats

The graph renders raw (non-resampled) records for fidelity, while the stats panel uses the 1 Hz resampled grid. Minor peak discrepancies (e.g. graph showing 412 W but stats reporting max 407 W) are expected and normal.

## Tech stack

- React 19 + TypeScript + Vite
- [Zustand](https://github.com/pmndrs/zustand) for state management
- [uPlot](https://github.com/leeoniya/uPlot) for chart rendering
- [fit-file-parser](https://github.com/jimmykane/fit-file-parser) for FIT file parsing
- Tailwind CSS v4 for styling

## Browser support

Tested on modern Chrome, Firefox, and Edge. Optimised for 13" laptop screens. Mobile is not a target at this stage.

## Test data

See `test-data/README.md` for how to obtain or generate test fixtures.
