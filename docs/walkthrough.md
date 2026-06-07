# SPNDAT: a walkthrough

## 1. What the project actually is

SPNDAT is a single-page web application that takes multiple .fit cycling files (from Garmin, Wahoo, or Hammerhead head units), aligns their timestamps so they share a common time axis, and overlays them on an interactive graph with descriptive statistics. The primary use case is comparing power meters: you ride with two devices recording simultaneously, then drop both files into the app to see how closely they agree.

The application runs entirely in the browser. There is no server, no database, no user accounts, no file upload to any cloud. All parsing, alignment, and rendering happens on the client, in JavaScript. This constraint (zero server, zero persistence) shapes every architectural choice. The app is a static set of HTML, CSS, and JS files; it can be served from any HTTP server or opened from a `file://` URL in a pinch (though `file://` is not officially supported).

A user drops one or more .fit or .tcx files onto the page. The app parses them, resamples their time-series data to a 1 Hz common grid, runs a three-pass cross-correlation algorithm to auto-align the time axes (handling different start times and mid-ride pause/resume events), then renders the overlaid power (or cadence, heart rate, speed, elevation, or temperature) traces on an interactive chart with zoom, pan, and series toggling. A statistics panel below the chart shows per-file descriptive stats in a figure-grid layout, with pairwise comparisons (Pearson r, mean absolute error, mean percentage error) in a quieter strip beneath; dragging on the graph creates a time-range selection and a Selection / Overall toggle appears at the top of the panel, defaulting to Selection so the figures recompute over the chosen range. If the auto-alignment gets something wrong, a collapsible offset-control panel lets the user manually adjust per-segment time offsets.

## 2. The N-second architecture

```
  .fit / .tcx files dropped by user
      |
      v
  parse.ts           -- dispatch by extension
      |
      +-- parser.ts  -- binary FIT parse (fit-file-parser) -> FitSession + FitRecord[]
      +-- tcx.ts     -- XML TCX parse (DOMParser)        -> FitSession + FitRecord[]
      |
      v
  resample.ts        -- 1 Hz null-filled grid -> ResampledSeries
      |
      v
  align.ts           -- three-pass cross-correlation -> OffsetSegment[] per file
      |
      v
  store.ts (Zustand) -- single state tree: files[], referenceFileId, selectedMetric,
      |                 per-file ParseResult, ResampledSeries, AlignmentResult
      +---> FitGraph.tsx     -- uPlot canvas, reads raw records + offsets
      +---> StatsPanel.tsx   -- figure grid + pairwise strip, reads resampled grid + offsets
      +---> OffsetControls.tsx -- per-segment offset editor, writes to store
      +---> FileDropZone.tsx -- drag-and-drop file ingestion, writes to store
      +---> MetricSelector.tsx -- toggles selectedMetric in store
```

There are two distinct data views. The graph renders raw (non-resampled) records with offset-adjusted timestamps for maximum fidelity. The stats panel and the alignment algorithm both use the 1 Hz resampled grid; uniform sampling prevents sampling-rate bias in correlation and statistical calculations. The two views can diverge slightly at peaks (a raw 4 Hz record might capture a 412 W spike that averaging rounds to 407 W in the 1 Hz grid), which is a known and accepted trade-off.

Every component reads from and writes to the same Zustand store. There is no prop drilling. The store is the single channel through which alignment results propagate to the graph and stats, and through which manual offset edits propagate back to rendering.

## 3. The alignment algorithm

The alignment engine (`src/align.ts`, 434 lines) is the most complex piece of the application. Its job: given two time series that represent the same ride but were recorded on different devices with different start times and different pause behaviour, find the per-segment time offsets that make them line up.

### 3.1 Why three passes instead of one

The obvious approach is a single cross-correlation pass over the entire trace. This fails when one device pauses mid-ride while the other continues recording. After the pause, the two traces have a different relative offset; if device A pauses for 30 seconds at minute 20, then after minute 20 the traces are 30 seconds out of sync. A single global offset cannot fix this.

The three-pass approach separates concerns:

1. Find the global offset (Pass 1).
2. Detect where pauses occurred in either trace (Pass 2).
3. For each post-pause segment, recompute the offset independently (Pass 3).

This is the Option A from the design document's trade-off analysis. The alternative (iterative segment matching) was rejected because its behaviour is harder to inspect and debug at each intermediate stage. The three-pass approach produces inspectable output at every pass.

### 3.2 Pass 1: Global cross-correlation

The function `findGlobalOffset` slides one file's trace across the other at 1-second steps over a +-1 minute search window. At each offset it computes a normalised SSE: the residual sum of squares between the aligned traces divided by the reference signal's variance about its own mean over the overlap. The result is dimensionless and scale-free (it is `1 - R^2` of `other` against `ref`), so a single threshold works across metrics with very different units (W, bpm, m/s). It returns the offset that minimises normalised SSE.

The search window of +-1 minute (down from an earlier +-5 minutes) was chosen because real clock drift between two devices recording the same ride is sub-minute, and a wider window invites spurious local minima when the two files share little common signal. A spurious 60-second offset on unrelated files was the symptom that motivated the tightening.

To further protect against spurious minima the scan evaluates offset 0 alongside every other candidate, and applies a **bias-to-zero check**: if the best non-zero offset's residual is not at least 20% smaller than the residual at offset 0 (i.e. `bestSSE < 0.8 * zeroSSE`), the function returns offset 0 instead. The intuition is that if shifting the file barely improves the fit, the "best" offset is almost certainly a coincidence; pinning to 0 keeps the answer safe and predictable. The margin (`ZERO_OFFSET_MARGIN = 0.8`) is a tunable constant.

The metric used for alignment is power by default, falling back to heart rate, then speed. This fallback chain exists because not all devices record power. If none of the three are available in both files, alignment fails and the file reverts to clock-time alignment (zero offsets).

The algorithm rejects an alignment if the normalised SSE exceeds 0.5 or the overlap is less than 30 seconds. The SSE threshold of 0.5 is a starting point that needs tuning against real paired recordings; it is a configurable constant (`SSE_FAILURE_THRESHOLD`). The minimum overlap of 30 seconds prevents accidental "good" correlations on tiny data slices. On rejection the file does not vanish from the UI: `alignPair` returns a single zero-offset segment spanning the file's local time range, with status `failed` and a warning describing why. This keeps the file visible on the graph (at clock-time) and gives the manual offset controls a segment to attach to, so the user can nudge it themselves.

### 3.3 Pass 2: Pause detection

Given the global offset from Pass 1, `detectPauses` walks both aligned traces in lockstep looking for contiguous null-runs longer than 10 seconds in one file where the other file has data. The 10-second threshold (`PAUSE_GAP_THRESHOLD_SECONDS`) was chosen to distinguish real device pauses from brief sensor dropouts (a heart-rate monitor dropping out for 3 seconds is not a pause; it is a sensor glitch that the null-fill in resampling handles).

The function tracks which file has the gap and flushes detected pauses when the gap ends. It handles alternating gaps (a gap in file A, then a gap in file B) by flushing the first pause before starting the second. A trailing pause (gap at the end of the trace) is also captured.

### 3.4 Pass 3: Segment re-anchoring

`reanchorSegments` takes the detected pauses and builds a list of time segments bracketed by them. For each post-pause segment, it cross-correlates the relevant slice of both traces (with a narrower +-30 second window, since post-pause drift is small) to find a per-segment correction offset. If the segment is too short (< 10 seconds of overlap) or the correlation is too weak, it keeps the previous segment's offset rather than guessing.

The bias-to-zero gate from Pass 1 is disabled here (`findGlobalOffset` is called with `biasToZero: false`). The gate exists to guard against spurious minima when two files share little common signal, but by Pass 3 we have already accepted that the files align; the only question is per-segment drift. A real post-pause correction of a few seconds may not clear the 20% improvement bar, so leaving the gate on would silently drop legitimate corrections.

The output is an array of `OffsetSegment` objects, each specifying a time range and an offset in whole seconds. A file with no pauses gets a single segment covering its entire duration. A file with two pauses gets three segments with potentially three different offsets.

### 3.5 Aligning more than two files

`alignAll` pairs every non-reference file against the reference file (the one with the most records, chosen automatically). The reference file itself gets a single segment with offset 0. Each pair is aligned independently via `alignPair`. This means the alignment is a star topology, not a full pairwise mesh. A star topology is simpler, costs O(n) instead of O(n^2), and in practice works well because the reference file typically contains the most data (longest recording, fewest gaps).

## 4. The data model

There is no database. All data lives in the Zustand store as plain TypeScript objects. The store is rebuilt from scratch on every page load; when the user drops files, they are parsed into memory, and when the user closes the tab, everything is discarded.

### 4.1 `FitRecord` and `FitSession`

Every field is nullable because FIT files are sparse by design; a speed sensor records speed but not power, a heart-rate strap records HR but not cadence. The data model preserves this: `power: number | null` everywhere. Downstream code checks for null before computing.

|Type|Purpose|
|-|-|
|`FitRecord`|A single timestamped observation: power, cadence, heart rate, speed, distance, elevation, temperature. All nullable.|
|`FitSession`|Container for a parsed file: start time, device name, manufacturer, sport, laps, and all records.|
|`Lap`|Start time, elapsed time, distance. Extracted for metadata display; not used in alignment or stats.|

### 4.2 `ResampledSeries`

|Column|Purpose|
|-|-|
|`timestamps`|Array of Unix-millisecond timestamps at 1-second intervals, from `min(timestamps)` to `max(timestamps)`.|
|`values`|`Record<MetricKey, (number \| null)[]>`. For each metric, a parallel array the same length as `timestamps`. Each cell is the last record's value at that second tick, or null if no record mapped to that tick.|

The separation of raw `FitRecord[]` from `ResampledSeries` is by design. Raw records are stored on `FitSession`; the resampled grid is stored independently on the store's `FileEntry`. This keeps the resampling logic out of the parser and allows the graph to render raw data while stats and alignment consume the resampled grid. The resampled grid is computed once on parse and cached in the store.

### 4.3 `OffsetSegment` and `AlignmentResult`

|Type|Purpose|
|-|-|
|`OffsetSegment`|A time range (`fromTime` to `toTime`, in Unix ms) and an `offsetSeconds` that applies to timestamps within that range.|
|`AlignmentResult`|Status (`ok`, `warning`, `failed`), array of `OffsetSegment[]`, and an optional `warning` string for failure details.|

The segment-based model is what allows the UI to display and edit per-pause offsets. A file with three segments corresponds to three rows in the OffsetControls panel, each with its own time range label and editable offset.

### 4.4 Design calls worth noting

The app has no `localStorage`, no `IndexedDB`, no server-sent state. The primary use case is loading two or three files, comparing them, and closing the tab. Adding persistence would require a serialisation story for binary FIT file data, version migration, and stale-state detection; none of that pays for itself in a comparison tool.

All timestamps are stored as Unix epoch milliseconds. The raw FIT timestamps arrive as `Date` objects (the library builds them from FIT-epoch seconds), and TCX timestamps arrive as ISO 8601 strings; both parsers normalise to Unix ms before handing the records downstream. Two files recorded in different time zones still compare correctly because the alignment algorithm operates on absolute timestamps.

`ResampledSeries.values` is `Record<MetricKey, (number | null)[]>`, not `Array<{ timestamp: number, power: number, ... }>`. The column-oriented layout is what the alignment algorithm needs (it extracts a single metric's array and cross-correlates on it). Row-oriented data would require an extra projection step on every correlation attempt.

Coasting power on a bike is zero watts; it is real data, not a missing sensor reading. The stats module does not filter zeros from mean, max, min, stddev, or pairwise comparisons. MPE excludes near-zero reference values (threshold 0.01) to avoid division blow-up, but this is an MPE-specific rule, not a general zero-stripping policy.

## 5. Parsing FIT and TCX

`src/parse.ts` is a thin dispatcher: it inspects the file extension and routes to either `src/parser.ts` (FIT, binary) or `src/tcx.ts` (TCX, XML). Both parsers return the same `ParseResult` containing a `FitSession`, so every downstream module is format-agnostic.

### 5.1 FIT parsing

`src/parser.ts` wraps the `fit-file-parser` library, which handles the binary FIT format. The library requires an `ArrayBuffer`, so the parser first reads the dropped `File` into an `ArrayBuffer` via `file.arrayBuffer()`. It configures the parser with `force: true` (continue on errors, don't abort on malformed records), metric units (metres, m/s, Celsius), and `mode: 'both'` (records available both inside laps and at the root level).

The most finicky part is timestamp normalisation. The library emits `record.timestamp` as a `Date` object (`new Date(epochSeconds * 1000 + GarminTimeOffset)` in its `binary.js`); other producers may hand back ISO strings or numeric strings (FIT epoch seconds or Unix seconds). `parseTimeString` covers all of these by branching on the numeric magnitude after `Number(ts)` coercion (which also handles `Date` -> Unix ms automatically), and by falling back to `Date.parse` for ISO strings. The FIT epoch offset (631065600 seconds between 1989-12-31 and 1970-01-01) is hard-coded; this is a stable constant defined by the FIT specification.

### 5.2 TCX parsing

`src/tcx.ts` parses the XML using the browser's `DOMParser`. TCX is a Garmin format used by software exporters like TrainerRoad. The parser walks `<Activity>/<Lap>/<Track>/<Trackpoint>` elements directly (matching by local name so any namespace prefix works) and pulls:

- `<Time>` -> ISO 8601, normalised via `Date.parse`
- `<HeartRateBpm><Value>` -> `heartRate`
- direct `<Cadence>` -> `cadence`
- `<DistanceMeters>` -> `distance`
- `<AltitudeMeters>` -> `elevation`
- `<Extensions>/<TPX>/<Watts>` -> `power` (Garmin ActivityExtension v2 namespace; commonly seen with prefix `ns3:`)
- `<Extensions>/<TPX>/<Speed>` -> `speed`

TCX has no temperature field, so `temperature` is always null. The parser also extracts `Activity[Sport]`, `Activity/Id` (start time), and `Activity/Creator/Name` (device name; e.g. "TrainerRoad" for an exported indoor session).

Both parsers return `ParseResult` with status `ok`, `warning`, or `error`. Errors are always caught (the try/catch wraps the entire operation) so a corrupt file never crashes the app. Warnings are generated for files with zero records or files where no record contains power data (the latter is important because it degrades alignment quality). The status propagates to the file card in the UI as a coloured badge.

## 6. The UI layer

The UI is a single-page React app with no routing. Six components compose the page vertically:

|Component|Job|
|-|-|
|`App.tsx`|Top-level layout: header, file-drop zone, alignment-failure banner, metric selector, graph, stats, offset controls.|
|`FileDropZone.tsx`|Drag-and-drop zone + hidden file input. Filters drops to .fit and .tcx via `isSupportedFile`. Displays file cards with colour swatch, device name, record count, parse status, warnings, and remove button.|
|`MetricSelector.tsx`|Row of pill buttons for each of six metrics. Greys out metrics absent from all loaded files.|
|`FitGraph.tsx`|uPlot canvas. Builds shared timeline from union of all files' offset-adjusted timestamps. Handles resize via `ResizeObserver`. Drag = time-range selection (zoom-on-drag is disabled); the brush is two-way bound to the store's `selection` state.|
|`StatsPanel.tsx`|Per-file descriptive stats rendered as a figure-grid (large Mean on the left, supporting Max/Min/SD/N on the right per file). Pairwise comparisons against the first file appear in a demoted strip below. When `selection` is set, a Selection / Overall toggle appears in the panel header (defaulting to Selection); the same figure-grid recomputes over the selected range, alongside a "Clear selection" button.|
|`OffsetControls.tsx`|Collapsible panel with per-file, per-segment offset editors. Link-all-segments checkbox. Global nudge-all-files controls.|

### 6.1 Why uPlot

The graph renders 3,600-14,400 data points per file (1-4 Hz over an hour). At three files, that is up to 43,200 points. Most React charting libraries (Recharts, Chart.js, Nivo) struggle beyond a few thousand points with smooth zoom and pan.

uPlot is purpose-built for dense time-series. It uses a single Canvas element, bypasses the DOM for data rendering, and handles 100k+ points without frame drops. The trade-off is an imperative API; there are no React-style declarative props for data updates. The `FitGraph` component splits uPlot lifecycle into two effects: one keyed on `opts` (which changes only when files are added or removed) destroys and recreates the chart, while a second effect keyed on `data` calls uPlot's `setData()` to update traces in-place. This preserves zoom state and avoids chart flash when the user nudges offsets, a frequent operation that only changes data, not the number of series.

### 6.2 Why Zustand

The store holds all application state (files, parse results, alignment results, selected metric, reference file). Every component that reads from the store uses Zustand's selector API (`useStore(s => s.files)`) which triggers re-renders only when the selected slice changes.

Zustand was chosen over React Context. It does not require a provider wrapper. Selectors avoid unnecessary re-renders (Context forces re-render of all consumers when any part of the context changes). It supports reading state imperatively (`get()`) inside async actions, which matters for `addFiles` (parse a file, push it to the list, then run alignment on the new list, all within the same action). And it has zero boilerplate compared to Redux.

The store alone is 269 lines. The actions are pure Zustand `set` calls; there is no middleware.

### 6.3 Duplicate detection

`addFiles` checks for duplicates by comparing file name and size before parsing. This is a rough heuristic (same name and size on the same machine implies the same file), chosen over content hashing because hashing requires reading the full `ArrayBuffer`, which would double the I/O cost. The .fit file is already being read for parsing immediately after duplicate detection, so a content hash would require reading it twice. Name + size is fast and catches the common case of dragging the same file twice.

### 6.4 Offset editing UX

The OffsetControls component implements the Link-all-segments pattern from the design document. When the "Link all" checkbox is checked for a file, editing any segment's offset adjusts all segments of that file by the same delta, preserving the relative offsets between segments. This is the most common correction scenario: alignment got the pauses wrong, but the segments themselves are proportionally correct, so a global nudge fixes everything. When unlinked, each segment is independently editable for fine-tuning.

The global "Nudge all files" controls add or subtract 1 second from every segment of every file. This handles the case where the reference clock is slightly off; all files shift together.

## 7. How the pieces talk to each other

The integration point between the algorithmic modules and the UI is the `addFiles` action in the store. When files are dropped:

1. `addFiles` calls `parseFile` (the dispatcher) for each file (sequential, not parallel; the fit-file-parser is not thread-safe). The dispatcher routes to `parseFitFile` or `parseTcxFile` based on the file's extension.
2. If parsing succeeds, `resample()` produces a 1 Hz grid from the raw records.
3. After all files are parsed and resampled, `recomputeAlignment()` runs `alignAll` against the reference file.
4. Results are stored on each `FileEntry` in the `files[]` array.

The graph and stats panel react to changes in `files[]` and `selectedMetric` via Zustand selectors. When the user changes a metric, only `selectedMetric` changes; `useMemo` in both components recomputes the derived data.

When the user edits an offset in `OffsetControls`, the store mutates the `alignmentResult.segments` array in place (via immutable spread in `nudgeOffset` or `setSegmentOffset`). The graph and stats panel re-render because their selectors depend on `files[]`, which changed. There is no explicit event bus or callback chain; the store is the channel.

The graph selection is a thin two-way binding over the store's `selection` field. Dragging fires uPlot's `setSelect` hook, which converts the pixel range to data coordinates and calls `setSelection`. A guard ref prevents the reverse path (store -> chart re-apply via `u.setSelect`) from re-entering the hook. The selection itself is stored as `{ fromTime, toTime }` in milliseconds on the **reference (aligned) timebase** -- the same units the graph's x-axis displays. Because each file's `ResampledSeries.timestamps` are on its own local timebase, `computeFileStats` translates the aligned range through that file's segment offsets before filtering (the reference file always has zero offsets, so its local and aligned timebases coincide). `computePairwiseStats` walks the reference file's timestamps and so can short-circuit on the range directly. Selections are clamped to the combined data extent in `setSelection` and again in every store action that can shift extents (`removeFile`, `recomputeAlignment`, `nudgeOffset`, `setSegmentOffset`, `nudgeAllOffsets`); a clamped selection that collapses to zero width becomes `null`. This means selections survive metric switches and small offset nudges, but disappear when files are removed in a way that pushes the selection entirely out of bounds.

## 8. Supporting scripts and tests

|File|What it tests|Tests|
|-|-|-|
|`src/parser.test.ts`|`parseFitFile` with mocked `fit-file-parser`: error, zero records, full records, missing power, optional fields, numeric timestamps, Date-object timestamps (the format the library actually emits).|7|
|`src/tcx.test.ts`|`parseTcxFile`: full trackpoint extraction, metadata (sport, device, startTime), missing-power-as-null, no-power warning, no-records warning, malformed XML, missing Activity, multi-Lap aggregation, fallback startTime.|9|
|`src/resample.test.ts`|`resample()` with synthetic `FitSession`: empty, evenly spaced, rounding, gaps, single record, irregular spacing, same-tick overwrite, multi-metric nulls.|8|
|`src/align.test.ts`|`alignPair` and `alignAll`: known offset, zero offset, single pause, no pauses, no overlap, random noise, empty series, multi-file, mixed success/failure, the failed-alignment fallback (single zero-offset segment when one file has data), and bias-to-zero on unrelated workouts.|12|
|`src/stats.test.ts`|`computeFileStats` and `computePairwiseStats`: mean/max/min/stddev, nulls, all nulls, zeros, single value, perfect correlation, negative correlation, pairwise null exclusion, MAE, MPE epsilon, insufficient pairs, and the selection-range translations (reference file, non-reference file with non-zero offset, zero-sample range, multi-segment ranges across pause gaps).|18|
|`src/store.test.ts`|Zustand store with mocked parser and resampler: add/remove/clear, duplicate detection, reference selection, nudge, segment offset, metric switching, and selection lifecycle (clamping, out-of-bounds clearing, clearAll/removeFile cleanup).|17|
|`src/components/StatsPanel.test.tsx`|`StatsPanel` renders overall stats with no toggle when there is no selection; uses the selected metric's unit; defaults to Selection scope and hides Overall numbers when a selection is active; switches scope on toggle click; the "Clear selection" button dismisses the selection; pairwise comparisons render only in the demoted strip and only with 2+ files.|8|
|`src/components/FitGraph.test.tsx`|Smoke test that the component mounts without crashing.|1|

All tests use Vitest with jsdom. The test setup file (`src/test-setup.ts`) provides a mock `window.matchMedia` (needed by uPlot at import time) and the `@testing-library/jest-dom` matchers. The parser and resample mocks in store tests prevent the store from calling real I/O.

The `test-data/` directory exists but has no committed fixtures yet. That is a known gap. The plan specifies synthetic FIT files should be generated and checked in. The current tests mock `fit-file-parser` entirely, so lack of real fixtures does not affect test coverage, but real-fixture tests would catch library API changes.

## 9. Tech choice summary

|Choice|Why|
|-|-|
|TypeScript|The data model has 20+ nullable fields across 6 metric types. Without types, field name typos and null-handling mistakes would be silent bugs. The alignment algorithm's cross-correlation operates on numeric arrays; `number | null` types catch missing null checks at compile time.|
|Zustand|The store needs to be readable imperatively inside async actions (parse-then-align pipeline) and subscribable by React components. Zustand supports both with zero provider boilerplate. Context would re-render the entire tree on every file parse. Redux would add ~40 lines of boilerplate for a single-state-tree app.|
|uPlot|Canvas-based rendering for 40k+ data points with zoom/pan. DOM-based charting libraries (Recharts, Chart.js) allocate a DOM node per data point and choke above ~5k points. uPlot's imperative API is a minor cost paid once in `FitGraph.tsx`.|
|fit-file-parser|The only maintained npm package for parsing the Garmin FIT binary format. Lightly maintained (last release several years ago) but the FIT spec is stable. Uses a caret version range (^2.3.3) with a known-working minor version.|
|Tailwind CSS v4|Utility-first CSS for a project with ~10 components. No design system, no Figma, no designer. Tailwind lets components carry their own styling without naming conventions or cascade conflicts. Version 4 uses the Vite plugin rather than PostCSS, eliminating a build step.|
|Vite|Zero-config dev server with HMR. The `@tailwindcss/vite` and `@vitejs/plugin-react` plugins cover the entire build pipeline. webpack would require ~50 lines of config for the same result.|
|Vitest|Shares Vite's transform pipeline, so test and production code see identical module resolution. jsdom provides a DOM environment for component smoke tests. No Jest configuration migration needed.|
|No routing|The app has one view (files -> graph -> stats). Adding react-router for a single page would add a dependency and mental overhead for no benefit.|
|No persistence|The comparison session is ephemeral by design. Adding local storage would require serialising binary file blobs and managing stale-state detection. The complexity budget was better spent on alignment and stats accuracy.|

## 10. How to orient yourself in the repo

Read the files in this order:

1. `src/types.ts` (117 lines). The entire data vocabulary: `FitRecord`, `FitSession`, `ResampledSeries`, `OffsetSegment`, `AlignmentResult`, `ParseResult`, the metric list, units, and colour palette. Everything else references these types. Read it first and keep it open.

2. `src/parse.ts`, `src/parser.ts`, `src/tcx.ts`. Entry points for external data. `parse.ts` is a tiny dispatcher; `parser.ts` covers the binary FIT format; `tcx.ts` covers the XML TCX format via DOMParser. Both produce the same `FitSession` shape so the rest of the pipeline does not care which format the user dropped.

3. `src/resample.ts` (64 lines). Short and self-contained. Converts a `FitSession`'s irregular records into a uniform 1 Hz grid. The rounding and null-fill logic is the only non-trivial part.

4. `src/align.ts` (434 lines). The algorithmic core. Start at the exported `alignPair` function and trace through the three passes. The constants at the top are the tuning knobs.

5. `src/stats.ts` (272 lines). `computeFileStats` and `computePairwiseStats`. Shows how alignment offsets are applied to look up values in the resampled grid, how pause regions and nulls are excluded from comparisons, and how an aligned-timebase selection range is translated through per-segment offsets into per-file local windows.

6. `src/store.ts` (269 lines). The Zustand store. Read `addFiles` to see how parse, resample, and align are chained. Read the offset mutation actions to see how manual edits propagate.

7. `src/components/FitGraph.tsx` (307 lines). The hardest UI component. `buildChartData` constructs uPlot's `AlignedData` from raw records with per-segment offset adjustment. The effects manage uPlot lifecycle, data updates, and selection synchronisation.

8. `src/App.tsx` (67 lines). The shell. Shows the vertical composition of all components and the alignment-failure banner condition.

That is the whole project.
