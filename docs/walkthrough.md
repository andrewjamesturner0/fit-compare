# SPNDAT: a walkthrough

## 1. What the project actually is

SPNDAT is a single-page web application that takes multiple .fit cycling files (from Garmin, Wahoo, or Hammerhead head units), aligns their timestamps so they share a common time axis, and overlays them on an interactive graph with descriptive statistics. The primary use case is comparing power meters: you ride with two devices recording simultaneously, then drop both files into the app to see how closely they agree.

The application runs entirely in the browser. There is no application server, database, user account, or file upload to any cloud. All parsing, alignment, and rendering happens on the client, in JavaScript. This constraint (zero back end, zero persistence) shapes every architectural choice. The production build is a static set of HTML, CSS, and JS files served over HTTP; `./serve.sh 8080` serves a fresh `dist` build locally.

A user drops one or more .fit or .tcx files onto the page. The app parses them, resamples their time-series data to a 1 Hz common grid, runs a three-pass cross-correlation algorithm to auto-align the time axes (handling different start times and mid-ride pause/resume events), then renders the overlaid power (or cadence, heart rate, speed, elevation, or temperature) traces on an interactive chart. For power, the statistics panel compares every non-reference file with the aligned reference and shows an agreement verdict, signed bias, confidence interval, limits of agreement, per-file figures, and supporting error measures. Other metrics keep the compact Pearson r, mean absolute error, and mean percentage error strip. Dragging on the graph creates a time-range selection on the aligned reference timebase. The graph immediately zooms to that exact range. A Selection / Overall toggle then appears at the top of the panel, defaulting to Selection so the figures recompute over the chosen range. If the auto-alignment gets something wrong, a collapsible offset-control panel lets the user manually adjust per-segment time offsets.

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
      +---> StatsPanel.tsx   -- selects reference, scope, and power/non-power stats view
      |       +---> ComparisonView.tsx -- power verdict, cards, interval, supporting metrics
      +---> OffsetControls.tsx -- per-segment offset editor, writes to store
      +---> FileDropZone.tsx -- drag-and-drop file ingestion, writes to store
      +---> MetricSelector.tsx -- toggles selectedMetric in store
```

There are two distinct data views. The graph renders raw (non-resampled) records with offset-adjusted timestamps for maximum fidelity. The stats panel and the alignment algorithm both use the 1 Hz resampled grid; uniform sampling prevents sampling-rate bias in correlation and statistical calculations. The two views can diverge slightly at peaks (a raw 4 Hz record might capture a 412 W spike that averaging rounds to 407 W in the 1 Hz grid), which is a known and accepted trade-off.

Every component reads from and writes to the same Zustand store. There is no prop drilling. The store is the single channel through which alignment results propagate to the graph and stats, and through which manual offset edits propagate back to rendering.

## 3. The alignment algorithm

The alignment engine (`src/align.ts`) is the largest algorithmic component of the application. Its job: given two time series that represent the same ride but were recorded on different devices with different start times and different pause behaviour, find the per-segment time offsets that make them line up.

### 3.1 Why three passes instead of one

The obvious approach is a single cross-correlation pass over the entire trace. This fails when one device pauses mid-ride while the other continues recording. After the pause, the two traces have a different relative offset; if device A pauses for 30 seconds at minute 20, then after minute 20 the traces are 30 seconds out of sync. A single global offset cannot fix this.

The three-pass approach separates concerns:

1. Find the initial pre-pause offset using consecutive reliable windows (Pass 1).
2. Detect where pauses occurred in either trace (Pass 2).
3. For each post-pause segment, search the full manual-offset range and recompute the offset independently (Pass 3).

### 3.2 Pass 1: Consecutive-window initial anchoring

A single whole-trace correlation fails when the recording contains multiple offset regimes (e.g. offset 0 before a pause and +133 s afterwards). The algorithm therefore slides a fixed-duration scoring window (180 s) across the reference timeline at a fixed stride (60 s). For each window it finds the best offset within +-1 minute. An offset is accepted as the initial anchor only when at least two consecutive windows agree on the same offset (within 1 s tolerance) and have acceptable quality (normalised SSE <= 0.5, overlap >= 30 s).

This approach finds the pre-pause regime first and requires sustained evidence (multiple windows) rather than a single accidental match. It is robust to a degrading correlation tail (e.g. zero power just before a device pause) because those windows simply fall below the quality threshold and are skipped by the consecutive-window requirement.

The same **bias-to-zero check** from the original algorithm still applies: if the agreed non-zero offset's full-timeline residual is not at least 20% smaller than the residual at offset 0, the function returns 0 instead.

### 3.3 Pass 2: Pause detection

Given the initial offset from Pass 1, `findNextInternalPause` walks both aligned traces in lockstep looking for contiguous null-runs longer than 10 seconds in one file where the other file has data. Leading gaps (file B starts later than file A) and trailing gaps (file B ends before file A) are explicitly ignored — only pauses bracketed by mutual overlap count as internal. The 10-second threshold (`PAUSE_GAP_THRESHOLD_SECONDS`) was chosen to distinguish real device pauses from brief sensor dropouts (a heart-rate monitor dropping out for 3 seconds is not a pause; it is a sensor glitch that the null-fill in resampling handles).

Pause detection runs under the current offset and is called again after each accepted re-anchor, so later pauses are always discovered under the correct offset, not the initial one. Each detected pause uses index-based boundaries (`startIdx`, `endIdxExclusive`) internal to the scanner, decoupling from either file's timeline until segment boundaries are derived.

### 3.4 Pass 3: Full-range post-pause re-anchoring

For each post-pause segment, the algorithm scores a 180-second window starting at the reference timeline's resume point against the **full** other-file timeline. It searches the entire +-300 second range (the same range available in the manual offset controls) rather than the old +-30-second narrow window. This handles real-world cases where a device power-off and restart shifts the effective alignment by over two minutes (a 30-second search could never recover those jumps).

A candidate post-pause offset is accepted only when it satisfies three gates:
- **Overlap**: at least 10 seconds of overlapping non-null data.
- **Quality**: normalised SSE <= 0.5.
- **Improvement**: the candidate's normalised SSE must be at least 5% lower than the score using the previous segment's offset (`IMPROVEMENT_MARGIN = 0.95`).

If no candidate clears all three gates, the previous offset is kept and no duplicate segment is emitted (the old segment is extended instead).
The bias-to-zero gate is not applied in Pass 3, since by this pass we have already accepted that the files align.

After the first internal null-gap pause has been seen, the scanner also watches for sustained short-window offset-regime changes that occur without a null gap (e.g. a device recording zero power instead of missing data). These recorded-data changes are accepted under the same three gates and with an additional guard: offset decreases are rejected because they usually indicate a false match from repeated workout shapes. The next segment then starts at `refWindowStart - newOffset` rather than the old offset's projection, preventing a late cutover.

### 3.5 The local-time segment contract

Every `OffsetSegment` has its `fromTime` and `toTime` on the **owning file's local timeline**, not the reference timeline. This is formalised in `src/alignmentTime.ts` with these helpers:

- `localToAligned(localTs, segments)` -- maps a local timestamp to the aligned display timebase by applying the matching segment's offset.
- `alignedToLocal(alignedTs, segments)` -- the inverse: maps a reference-grid timestamp back to the owning file's local clock.
- `segmentAlignedWindow(seg)` -- returns the segment's `[from, to]` range on the aligned timebase.
- `isInPause(alignedTs, segments)` -- tests whether an aligned timestamp falls inside a pause gap between two segments.
- `alignedRangeToLocalWindows(range, segments)` -- translates an aligned-time selection range into per-segment local-time windows, respecting each segment's offset.

All graph rendering (`FitGraph`), statistics (`computeFileStats`, `computePairwiseStats`), and store extent computation (`computeDataExtent`) use these shared helpers, eliminating inconsistent duplicate arithmetic.

### 3.6 Aligning more than two files

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

The most involved part is timestamp normalisation. The library emits `record.timestamp` as a `Date` object (`new Date(epochSeconds * 1000 + GarminTimeOffset)` in its `binary.js`); other producers may hand back ISO strings or numeric strings (FIT epoch seconds or Unix seconds). `parseTimeString` covers all of these by branching on the numeric magnitude after `Number(ts)` coercion (which also handles `Date` -> Unix ms automatically), and by falling back to `Date.parse` for ISO strings. The FIT epoch offset (631065600 seconds between 1989-12-31 and 1970-01-01) is hard-coded; this is a stable constant defined by the FIT specification.

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

The UI is a single-page React app with no routing. Seven components compose the page vertically:

|Component|Job|
|-|-|
|`App.tsx`|Top-level layout: header, file-drop zone, alignment-failure banner, metric selector, graph, stats, offset controls.|
|`FileDropZone.tsx`|Drag-and-drop zone + hidden file input. Filters drops to .fit and .tcx via `isSupportedFile`. Displays file cards with colour swatch, device name, record count, parse status, warnings, and remove button.|
|`MetricSelector.tsx`|Row of pill buttons for each of six metrics. Greys out metrics absent from all loaded files.|
|`FitGraph.tsx`|uPlot canvas. Builds a shared timeline from the union of all files' offset-adjusted timestamps. Handles resize via `ResizeObserver`. A horizontal drag creates a time-range selection and immediately zooms the x-axis to the selected range; the brush is two-way bound to the store's `selection` state.|
|`StatsPanel.tsx`|Resolves the store's aligned reference file, computes overall and selected-range stats, and chooses the power agreement view or the non-power legacy strip. One active file keeps the per-file figure grid. The Selection / Overall toggle and "Clear selection" action apply to every view.|
|`ComparisonView.tsx`|Presents one reference-versus-comparison group per non-reference power file: four-state verdict banner, file cards, signed bias and limits of agreement, 90% confidence interval plotted against tolerance, supporting metrics, and the autocorrelation caveat. It reads props and does not access the store.|
|`OffsetControls.tsx`|Collapsible panel with per-file, per-segment offset editors. Link-all-segments checkbox. Global nudge-all-files controls.|

### 6.1 Why uPlot

The graph renders 3,600-14,400 data points per file (1-4 Hz over an hour). At three files, that is up to 43,200 points. Most React charting libraries (Recharts, Chart.js, Nivo) struggle to handle more than a few thousand points smoothly.

uPlot is purpose-built for dense time-series. It uses a single Canvas element, bypasses the DOM for data rendering, and handles 100k+ points without frame drops. The trade-off is an imperative API; there are no React-style declarative props for data updates. The `FitGraph` component splits uPlot lifecycle into two effects: one keyed on `opts` (which changes only when files are added or removed) destroys and recreates the chart, while a second effect keyed on `data` calls uPlot's `setData()` to update traces in-place. This preserves zoom state and avoids chart flash when the user nudges offsets, a frequent operation that only changes data, not the number of series.

### 6.2 Why Zustand

The store holds all application state (files, parse results, alignment results, selected metric, reference file). Every component that reads from the store uses Zustand's selector API (`useStore(s => s.files)`) which triggers re-renders only when the selected slice changes.

Zustand was chosen over React Context. It does not require a provider wrapper. Selectors avoid unnecessary re-renders (Context forces re-render of all consumers when any part of the context changes). It supports reading state imperatively (`get()`) inside async actions, which matters for `addFiles` (parse a file, push it to the list, then run alignment on the new list, all within the same action). And it has zero boilerplate compared to Redux.

The store alone is about 270 lines. The actions are pure Zustand `set` calls; there is no middleware.

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

The graph and stats panel react to changes in `files[]` and `selectedMetric` via Zustand selectors. When the user changes a metric, only `selectedMetric` changes. `useMemo` in both components recomputes the derived data.

When the user edits an offset in `OffsetControls`, the store mutates the `alignmentResult.segments` array in place (via immutable spread in `nudgeOffset` or `setSegmentOffset`). The graph and stats panel re-render because their selectors depend on `files[]`, which changed. There is no explicit event bus or callback chain; the store is the channel.

The graph selection is a thin two-way binding over the store's `selection` field. Dragging fires uPlot's `setSelect` hook, which converts the pixel range to data coordinates, calls `setSelection`, and immediately sets the x-axis scale to those exact bounds. A guard ref prevents the reverse path (store -> chart re-apply via `u.setSelect`) from re-entering the hook. The selection itself is stored as `{ fromTime, toTime }` in milliseconds on the **reference (aligned) timebase**, which is the same unit the graph's x-axis displays.

Because each file's `ResampledSeries.timestamps` are on its own local timebase, `computeFileStats` translates the aligned range through that file's segment offsets before filtering (the reference file always has zero offsets, so its local and aligned timebases coincide). A private paired-data helper walks the reference file's timestamps, maps each aligned timestamp to the comparison file's local time, and excludes nulls and pause regions. `computePairwiseStats` and `computeComparisonStats` both use those exact pairs, so the legacy and power results cannot drift onto different sample sets.

For power, `computeComparisonStats` defines every signed difference as `comparison minus reference`. It uses the sample standard deviation of those paired differences for Bland-Altman limits, Cohen's dz, and the 90% confidence interval for mean bias. The effective tolerance is fixed at the larger of 3% of the paired grand mean and 5 W. A confidence interval wholly inside the open tolerance bounds is `equivalent`; one wholly beyond either bound is `different`; one that touches or crosses a bound is `inconclusive`; and fewer than two pairs is `insufficient-data`. The UI uses the clearer text "Difference exceeds tolerance" for the different state.

This verdict is deliberately limited to power because a 5 W floor has no useful meaning for cadence, heart rate, speed, elevation, or temperature. Those metrics continue to show Pearson r, MAE, MPE, and N. The full aligned 1 Hz grid is used and zeros are kept. Because adjacent readings are autocorrelated, the t interval can be too narrow; the UI describes the result as an approximate descriptive summary rather than formal proof of equivalence.

Selections are clamped to the combined data extent in `setSelection` and again in every store action that can shift extents (`removeFile`, `recomputeAlignment`, `nudgeOffset`, `setSegmentOffset`, `nudgeAllOffsets`); a clamped selection that collapses to zero width becomes `null`. Selections survive metric switches and small offset nudges, but disappear when files are removed in a way that pushes the selection entirely out of bounds.

## 8. Supporting scripts and tests

|File|What it tests|Tests|
|-|-|-|
|`src/parser.test.ts`|`parseFitFile` with mocked `fit-file-parser`: error, zero records, full records, missing power, optional fields, numeric timestamps, Date-object timestamps (the format the library actually emits).|7|
|`src/tcx.test.ts`|`parseTcxFile`: full trackpoint extraction, metadata (sport, device, startTime), missing-power-as-null, no-power warning, no-records warning, malformed XML, missing Activity, multi-Lap aggregation, fallback startTime.|9|
|`src/resample.test.ts`|`resample()` with synthetic `FitSession`: empty, evenly spaced, rounding, gaps, single record, irregular spacing, same-tick overwrite, multi-metric nulls.|8|
|`src/align.test.ts`|`alignPair` and `alignAll`: synthetic pause regression (+133s jump), known-offset detection, zero-offset files, single pause, no-pause, no-overlap failure, random-noise failure, empty series, multi-file align, mixed success/failure, unrelated-workout bias-to-zero, scale-invariance, single-pause coalescing, two-sequential-pause coalescing, >2-minute offset jump recovery, sensor-dropout rejection, leading/trailing extent-gap filtering, two true offset jumps, ref-pause-then-other-pause, same-offset no-split, recorded-data regime changes, and segment-boundary cutover assertions.|25|
|`src/stats.test.ts`|`computeFileStats`, `computePairwiseStats`, and `computeComparisonStats`: descriptives, shared-pair parity, sign, sample SD, limits of agreement, t-critical branches, all verdict boundaries, fixed tolerance, constant and zero-mean cases, CCC, RMSE, Cohen's dz, CV, Pearson r, MAE, MPE, nulls, zeros, selection ranges, offsets, pauses, and multi-segment alignment.|44|
|`src/alignmentTime.test.ts`|`localToAligned`, `alignedToLocal`, `segmentAlignedWindow`, `isInPause`, `offsetForLocalTs`, `alignedRangeToLocalWindows`: fallback behaviour, multi-segment, negative offsets, large offset gaps (>60 s), precision at segment boundaries.|25|
|`src/store.test.ts`|Zustand store with mocked parser and resampler: add/remove/clear, duplicate detection, reference selection, nudge, segment offset, metric switching, and selection lifecycle (clamping, out-of-bounds clearing, clearAll/removeFile cleanup).|18|
|`src/components/StatsPanel.test.tsx`|Single-file figures, power/non-power branching, stored reference choice, comparison sign, three-file order and mapping, selection recomputation, Clear selection, failed alignment, and insufficient paired data.|15|
|`src/components/ComparisonView.test.tsx`|All four verdict texts, file cards, effective margin and floor copy, null formatting, sign explanation, supporting metrics, paired N, alignment-unavailable copy, and the autocorrelation caveat.|8|
|`src/components/FitGraph.test.tsx`|Component mount smoke test, exact selection zoom, and no-zoom checks for cleared or invalid brushes.|4|
|`src/components/FitGraph.integration.test.tsx`|Real-uPlot drag integration: a user drag stores the accepted selection and zooms to the same bounds.|1|

All tests use Vitest with jsdom. The test setup file (`src/test-setup.ts`) provides a mock `window.matchMedia` (needed by uPlot at import time) and the `@testing-library/jest-dom` matchers. The parser and resample mocks in store tests prevent the store from calling real I/O.

The `test-data/` directory exists but has no committed fixtures yet. That is a known gap. The plan specifies synthetic FIT files should be generated and checked in. The current tests mock `fit-file-parser` entirely, so lack of real fixtures does not affect test coverage, but real-fixture tests would catch library API changes.

## 9. Tech choice summary

|Choice|Why|
|-|-|
|TypeScript|The data model has 20+ nullable fields across 6 metric types. Without types, field name typos and null-handling mistakes would be silent bugs. The alignment algorithm's cross-correlation operates on numeric arrays; `number | null` types catch missing null checks at compile time.|
|Zustand|The store needs to be readable imperatively inside async actions (parse-then-align pipeline) and subscribable by React components. Zustand supports both with zero provider boilerplate. Context would re-render the entire tree on every file parse. Redux would add ~40 lines of boilerplate for a single-state-tree app.|
|uPlot|Canvas-based rendering for 40k+ data points with range selection and selection-driven zoom. DOM-based charting libraries (Recharts, Chart.js) allocate a DOM node per data point and choke above ~5k points. uPlot's imperative API is a minor cost paid once in `FitGraph.tsx`.|
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

4. `src/align.ts` — the algorithmic core. Start at the exported `alignPair` function and trace through the three passes. The constants at the top are the tuning knobs.

5. `src/alignmentTime.ts` — shared timestamp-mapping helpers. `localToAligned`, `alignedToLocal`, `segmentAlignedWindow`, `isInPause`, and `alignedRangeToLocalWindows`. The single source of truth for the local-time segment contract; every consumer of `OffsetSegment` uses these.

6. `src/stats.ts` -- `computeFileStats`, `computePairwiseStats`, and `computeComparisonStats`. A private helper creates the shared aligned pairs. The power result adds bias, limits of agreement, a fixed-margin TOST summary, effect size, concordance, and error measures without adding a statistics dependency.

7. `src/store.ts` -- the Zustand store. Read `addFiles` to see how parse, resample, and align are chained. Read the offset mutation actions to see how manual edits propagate.

8. `src/components/FitGraph.tsx` -- the most involved UI component. `buildChartData` constructs uPlot's `AlignedData` from raw records with per-segment offset adjustment. The effects manage uPlot lifecycle, data updates, and selection synchronisation.

9. `src/components/StatsPanel.tsx` and `src/components/ComparisonView.tsx` -- the stats orchestration and the power-specific presentation boundary.

10. `src/App.tsx` -- the shell. Shows the vertical composition of all components and the alignment-failure banner condition.

That is the whole project.
