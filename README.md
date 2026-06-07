# SPNDAT

**SP**NDAT is **N**ot the **D**cr **A**nalyser **T**ool.

A client-side single-page webapp that parses multiple .fit and .tcx cycling files, auto-aligns their timestamps, overlays them on an interactive graph, and computes descriptive statistics to assess how closely the recordings match.

Primary use case: comparing power meters on the same ride. Mixing formats is supported - e.g. comparing a head unit's .fit recording against the matching TrainerRoad .tcx export.

## Usage

1. Open the app in a browser
2. Drop one or more `.fit` or `.tcx` files onto the drop zone (or click to browse)
3. Files are automatically parsed and aligned
4. Use the metric selector to switch between power, cadence, heart rate, speed, elevation, and temperature
5. Zoom by scrolling; pan by click-dragging
6. Drag horizontally on the graph to select a time range. A Selection / Overall toggle appears at the top of the stats panel; the panel defaults to Selection so the per-file figures show stats restricted to that range. Click Overall to switch back, or "Clear selection" to dismiss the range
7. The stats panel below the graph shows descriptive statistics for each file in a figure-grid layout, with pairwise comparisons in a quieter strip beneath
8. Expand "Adjust Offsets" to manually correct alignment if auto-alignment gets it wrong

## Build and run

```bash
npm install
npm run dev      # development server
npm test         # test suite
npm run lint     # lint checks
npm run build    # production build
npm run preview  # preview production build
```

## How it works

### Data pipeline

`File -> parse.ts (dispatch by extension to parser.ts for .fit or tcx.ts for .tcx) -> FitSession -> resample.ts -> 1 Hz ResampledSeries -> align.ts -> OffsetSegment[] -> graph + stats`

Both parsers produce the same `FitSession` shape, so every downstream stage is format-agnostic. .tcx parsing reads <Trackpoint> elements via DOMParser and pulls power and speed from the Garmin ActivityExtension v2 namespace (typically prefixed `ns3:`).

### Alignment

The three-pass auto-alignment algorithm:

1. **Global offset** -- cross-correlates power traces (falling back to HR, then speed) over +-1 minute to find the best global time offset. Clock drift between devices recording the same ride is sub-minute; a wider window picks up spurious local minima when the two files share little common signal. The scan also evaluates offset 0 and pins to it unless the chosen non-zero offset's residual is at least 20% smaller
2. **Pause detection** -- walks aligned traces and detects contiguous gaps > 10 seconds where one file has data but the other doesn't
3. **Segment re-anchoring** -- for each post-pause segment, cross-correlates again to find a per-segment correction offset

If correlation confidence is too low, the file falls back to a single zero-offset segment (raw clock-time alignment) and a warning is shown. "Adjust Offsets" still lets the user nudge the offset manually.

### Stats

- **Per-file:** mean, max, min, standard deviation (computed on the 1 Hz resampled grid, nulls excluded)
- **Pairwise:** Pearson r, MAE, MPE (first uploaded file is used as reference for MPE; values near zero are excluded to avoid division blow-up)
- Pause regions and nulls are excluded pairwise from all comparisons
- Zeros are kept (coasting power is real data)
- **Selection scope:** when a time range is selected on the graph, the panel defaults to Selection and recomputes the same per-file figures and pairwise strip over that range. The Selection / Overall toggle switches between the two scopes. Selections are stored on the reference (aligned) timebase; for non-reference files the range is translated through their alignment offsets before filtering, so the correct slice of each file is included regardless of its offset. Selections are clamped to the visible data extent and survive metric switches and offset nudges; they are cleared when all files are removed or when nudges push them out of bounds

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
