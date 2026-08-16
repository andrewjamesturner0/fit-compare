# Project lessons

## Segment boundaries are on the owning file's local timeline

`OffsetSegment.fromTime` / `toTime` are local, not aligned. All consumers must use the helpers in `src/alignmentTime.ts`. Never compare aligned timestamps directly with local segment boundaries — the old `timestampInPause` in stats.ts did this and was broken for non-zero offsets.

## Initial anchor: consecutive reliable windows, not whole-trace

Whole-trace correlation fails on multi-regime recordings. The initial offset comes from sliding a 180 s window at 60 s stride and requiring at least 2 consecutive windows to agree on the same offset with acceptable quality. Window-level scores gate acceptance; full-timeline scores are only for the bias-to-zero check (`>= 0.8 * zeroSSE`).

## Post-pause search: full +-300 s range, three gates

Pass 3 searches the full UI offset range against a bounded 180 s post-resume window. Accept a new offset only when: overlap >= 10 s, normalised SSE <= 0.5, and at least 5% improvement over the previous offset. A narrow +-30 s window cannot recover >2-minute effective-offset jumps.

## Pauses must be scanned iteratively under the current offset

One-shot `detectPauses` with the initial offset produces stale boundaries after an earlier re-anchor. Scan forward under the current offset, re-anchor if warranted, update the offset, then continue scanning. This is `buildSegmentsIteratively` in `src/align.ts`.

## Extent gaps are not pauses

Leading gaps (file B starts after file A) and trailing gaps (file B ends before file A) must not create segments. A gap is internal only if mutual overlap precedes it and resumed data follows it. Without this, later-starting files get 1-second artefact segments.

## Emit segments only on real offset changes; coalesce afterward

Same-offset pauses do not split segments. After building, merge adjacent segments with equal offsets. Keeps the OffsetControls panel clean — one row per alignment regime.

## Recorded-data pause-like sections hide offset changes

Not every offset jump has a null gap. After the first internal null-gap pause, scan for sustained short-window regime changes where a new offset materially beats the current one. Reject offset *decreases* from this detector (they are usually false matches from repeated workout shapes).

## Cutover boundary: use new offset, not old

When switching to a new offset, the next segment starts at `refTime - newOffset` (for both null-gap pauses and recorded-data changes). Using `refTime - oldOffset` cuts over too late and leaves the first part of the new shape in the old segment.

## No real files in CI

`examples/` is gitignored. Tests use synthetic fixtures that model the observed regression shapes.

## Decisions & deliberate behaviours

- **Treat the power agreement contract as one unit.** The comparison-minus-reference sign, sample SD, strict TOST boundaries, and fixed `max(3%, 5 W)` margin are coupled; changing one can reverse the verdict or make its copy false. Guarded by `src/stats.test.ts`. Rationale: `docs/walkthrough.md` and `.agent-docs/comparison-statistics.md`.
- **Keep the agreement verdict power-only and descriptive.** The 5 W floor has no useful meaning for other metrics, while autocorrelation in adjacent 1 Hz readings makes the confidence interval too optimistic for a formal claim. Guarded by `src/components/StatsPanel.test.tsx` and `src/components/ComparisonView.test.tsx`. Rationale: `docs/walkthrough.md` and `.agent-docs/comparison-statistics.md`.
