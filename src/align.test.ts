import { describe, it, expect } from 'vitest'
import { alignPair, alignAll } from './align'
import type { ResampledSeries, MetricKey } from './types'

const M: MetricKey[] = ['power', 'cadence', 'heartRate', 'speed', 'elevation', 'temperature']

function makeSeries(
  length: number,
  startTime: number,
  powerValues: (number | null)[],
): ResampledSeries {
  const timestamps: number[] = []
  for (let i = 0; i < length; i++) {
    timestamps.push(startTime + i * 1000)
  }
  const values = {} as Record<MetricKey, (number | null)[]>
  for (const key of M) {
    if (key === 'power') {
      values[key] = powerValues.slice(0, length)
    }
    else {
      values[key] = Array(length).fill(null)
    }
  }
  return { timestamps, values }
}

/** Sinusoidal power pattern for cross-correlation distinctiveness. */
function powerPattern(length: number, phase: number): (number | null)[] {
  const values: (number | null)[] = []
  for (let i = 0; i < length; i++) {
    values.push(150 + 50 * Math.sin((i + phase) * 0.1))
  }
  return values
}

// ─── Synthetic regression: screenshot-shaped pause ────────────────────────
//
// Acceptance criteria (T1.4):
//  (a) A pair shaped like the observed regression returns a non-failed
//      result with two contiguous local-time segments near 0 s and +133 s.
//  (b) An unchanged, single-offset recording retains one segment.
//  (c) Unrelated workouts must still fail or pin to zero.
//
// The regression shape:
//   - Pre-pause:  300 s of matching data at offset 0 (strong correlation).
//   - Degradation: ~35 s of zero power in the reference to simulate the
//                  pre-null-gap tail that corrupted the whole-trace score.
//   - Null gap:    98 s of nulls in the reference (simulated device pause).
//   - Post-pause:  200 s where the reference data matches the other file
//                  at an effective +133 s offset.

describe('alignPair — pause-aware regression', () => {
  it('recovers two segments across a +133s pause (screenshot analogue)', () => {
    const prePauseLen = 300
    const degradeLen = 35
    const gapLen = 98
    const postPauseLen = 250
    const totalRefLen = prePauseLen + degradeLen + gapLen + postPauseLen

    // Build the other file first with a continuous sinusoidal pattern.
    const otherLen = totalRefLen - 50
    const otherPower = powerPattern(otherLen, 0)
    const other = makeSeries(otherLen, 0, otherPower)

    // Reference matches other at offset 0 for t < prePauseLen, degrades to
    // zeros, has a null gap, then matches other at offset +133 for t >= 433.
    // i.e. ref[i] = other[i] for i < 300, ref[i] = other[i-133] for i >= 433.
    const refPower: (number | null)[] = []
    const degradeStart = prePauseLen
    const gapStart = prePauseLen + degradeLen
    const gapEnd = prePauseLen + degradeLen + gapLen

    for (let i = 0; i < totalRefLen; i++) {
      if (i < degradeStart) {
        refPower.push(otherPower[i])
      }
      else if (i < gapStart) {
        refPower.push(0)
      }
      else if (i < gapEnd) {
        refPower.push(null)
      }
      else {
        const otherIdx = i - 133
        if (otherIdx >= 0 && otherIdx < otherLen) {
          refPower.push(otherPower[otherIdx])
        }
        else {
          refPower.push(null)
        }
      }
    }
    const ref = makeSeries(totalRefLen, 0, refPower)

    const result = alignPair(ref, other)

    // Must not fail
    expect(result.status).not.toBe('failed')
    expect(result.segments.length).toBeGreaterThanOrEqual(2)

    // First segment should be near offset 0
    expect(Math.abs(result.segments[0].offsetSeconds)).toBeLessThanOrEqual(2)

    // Last segment should be near offset +133
    const lastSeg = result.segments[result.segments.length - 1]
    expect(lastSeg.offsetSeconds).toBeGreaterThanOrEqual(100)
    expect(lastSeg.offsetSeconds).toBeLessThanOrEqual(166) // ±33s tolerance
    // Null-gap offset changes must start the new local segment at
    // resumeRefTime - newOffset.  For this fixture: gapEnd 433s - 133s = 300s.
    expect(result.segments[1].fromTime).toBeLessThanOrEqual(301_000)

    // Segment boundaries must be on the other file's local timeline:
    // fromTime ≥ other.timestamps[0], toTime ≤ other.timestamps[last]
    for (const seg of result.segments) {
      expect(seg.fromTime).toBeGreaterThanOrEqual(other.timestamps[0])
      expect(seg.toTime).toBeLessThanOrEqual(
        other.timestamps[other.timestamps.length - 1],
      )
    }

    // Segments must cover the full other-file range
    expect(result.segments[0].fromTime).toBe(other.timestamps[0])
    expect(
      result.segments[result.segments.length - 1].toTime,
    ).toBe(other.timestamps[other.timestamps.length - 1])
  })

  it('returns a single segment for unchanged recordings (no pause)', () => {
    const ref = makeSeries(100, 0, powerPattern(100, 5))
    const other = makeSeries(100, 0, powerPattern(100, 5))

    const result = alignPair(ref, other)
    expect(result.status).toBe('ok')
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].offsetSeconds).toBe(0)
    // Local-time bounds: must cover the other file's range
    expect(result.segments[0].fromTime).toBe(other.timestamps[0])
    expect(result.segments[0].toTime).toBe(
      other.timestamps[other.timestamps.length - 1],
    )
  })

  it('fails or pins to zero for unrelated workouts', () => {
    // Two completely different signals
    const ramp: (number | null)[] = []
    for (let i = 0; i < 600; i++) ramp.push(100 + i * 0.5)
    const ref = makeSeries(600, 0, ramp)
    const steady: (number | null)[] = []
    for (let i = 0; i < 600; i++) steady.push(150)
    const other = makeSeries(600, 0, steady)

    const result = alignPair(ref, other)
    // Must either fail or pin to offset 0
    if (result.status === 'failed') {
      expect(result.segments[0].offsetSeconds).toBe(0)
    }
    else {
      expect(result.segments[0].offsetSeconds).toBe(0)
    }
  })
})

// ─── Core alignment ───────────────────────────────────────────────────────

describe('alignPair', () => {
  it('finds known global offset (Pass 1)', () => {
    const ref = makeSeries(600, 0, powerPattern(600, 0))
    // other's pattern is phase-shifted ahead: other[0] matches ref[10]
    const other = makeSeries(600, 0, powerPattern(600, 10))

    const result = alignPair(ref, other)
    expect(result.status).toBe('ok')
    expect(result.segments.length).toBeGreaterThan(0)
    expect(result.segments[0].offsetSeconds).toBe(10)
  })

  it('handles files with no offset (same start time)', () => {
    const ref = makeSeries(600, 0, powerPattern(600, 0))
    const other = makeSeries(600, 0, powerPattern(600, 0))

    const result = alignPair(ref, other)
    expect(result.status).toBe('ok')
    expect(result.segments.length).toBeGreaterThan(0)
    expect(result.segments[0].offsetSeconds).toBe(0)
  })

  it('handles a single pause where one file has a gap', () => {
    // ref: continuous 600 seconds
    const refPower = powerPattern(600, 0)
    const ref = makeSeries(600, 0, refPower)

    // other: 200 seconds matching ref, then 20-second gap, then 380 seconds
    // also matching ref (same offset throughout). Same offset -> coalesced.
    const otherPowerFirst = refPower.slice(0, 200)
    const otherPowerSecond = refPower.slice(220, 600)
    const otherPower = [...otherPowerFirst, ...Array(20).fill(null), ...otherPowerSecond]

    const other = makeSeries(600, 0, otherPower)

    const result = alignPair(ref, other)
    // Same offset throughout — coalesced into one segment, no warning needed.
    expect(result.status).toBe('ok')
    expect(result.segments.length).toBe(1)
  })

  it('handles files with no pauses', () => {
    const ref = makeSeries(100, 0, powerPattern(100, 5))
    const other = makeSeries(100, 0, powerPattern(100, 5))

    const result = alignPair(ref, other)
    expect(result.status).toBe('ok')
    expect(result.segments.length).toBe(1)
  })

  it('returns failed-with-zero-offset segment when no overlap exists', () => {
    const ref = makeSeries(300, 0, powerPattern(300, 0))
    const other: ResampledSeries = {
      timestamps: ref.timestamps.slice(),
      values: Object.fromEntries(M.map((k) => [k, Array(300).fill(null)])) as unknown as Record<MetricKey, (number | null)[]>,
    }

    const result = alignPair(ref, other)
    expect(result.status).toBe('failed')
    expect(result.warning).toBeDefined()
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].offsetSeconds).toBe(0)
  })

  it('returns failed when traces are too short for reliable correlation', () => {
    const ref = makeSeries(60, 0, powerPattern(60, 0))
    const otherPower = Array(60).fill(0).map(() => Math.random() * 200 + 50)
    const other2 = makeSeries(60, 0, otherPower)

    const result2 = alignPair(ref, other2)
    expect(result2.status).toBe('failed')
    expect(result2.segments).toHaveLength(1)
    expect(result2.segments[0].offsetSeconds).toBe(0)
  })

  it('handles empty series', () => {
    const empty: ResampledSeries = {
      timestamps: [],
      values: Object.fromEntries(M.map((k) => [k, []])) as unknown as Record<MetricKey, (number | null)[]>,
    }
    const ref = makeSeries(100, 0, powerPattern(100, 0))

    expect(alignPair(empty, ref).status).toBe('failed')
    expect(alignPair(empty, ref).segments).toHaveLength(1)
    expect(alignPair(ref, empty).status).toBe('failed')
    expect(alignPair(ref, empty).segments).toHaveLength(0)
  })

  it('does not drift to a spurious offset when files share little signal', () => {
    const ramp: (number | null)[] = []
    for (let i = 0; i < 600; i++) ramp.push(100 + i * 0.5)
    const ref = makeSeries(600, 0, ramp)
    const steady: (number | null)[] = []
    for (let i = 0; i < 600; i++) steady.push(150)
    const other = makeSeries(600, 0, steady)

    const result = alignPair(ref, other)
    expect(result.segments[0].offsetSeconds).toBe(0)
  })

  it('passes alignment when residuals are realistic for two power meters', () => {
    const ref = makeSeries(600, 0, powerPattern(600, 0))
    let seed = 1
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280
      return seed / 233280
    }
    const noisy = (ref.values.power as number[]).map((v) => v + (rand() - 0.5) * 30)
    const other = makeSeries(600, 0, noisy)

    const result = alignPair(ref, other)
    expect(result.status).not.toBe('failed')
    expect(result.segments.length).toBeGreaterThan(0)
    expect(result.segments[0].offsetSeconds).toBe(0)
  })

  it('residual metric is scale-invariant', () => {
    const refSmall = makeSeries(600, 0, powerPattern(600, 0))
    const refLarge = makeSeries(
      600,
      0,
      (refSmall.values.power as number[]).map((v) => v * 1000),
    )
    const otherSmall = makeSeries(600, 0, powerPattern(600, 5))
    const otherLarge = makeSeries(
      600,
      0,
      (otherSmall.values.power as number[]).map((v) => v * 1000),
    )

    const small = alignPair(refSmall, otherSmall)
    const large = alignPair(refLarge, otherLarge)
    expect(small.status).toBe(large.status)
    expect(small.segments[0].offsetSeconds).toBe(large.segments[0].offsetSeconds)
  })
})

// ─── Pause edge cases (T4.2) ──────────────────────────────────────────────

describe('pause edge cases', () => {
  it('handles a pause in the non-reference file (other file has gap)', () => {
    // Other file has a 30 s gap mid-ride; same offset throughout.
    const refPower = powerPattern(500, 0)
    const ref = makeSeries(500, 0, refPower)

    const otherPower = [
      ...refPower.slice(0, 200),
      ...Array(30).fill(null),
      ...refPower.slice(230, 500),
    ]
    const other = makeSeries(500, 0, otherPower)

    const result = alignPair(ref, other)
    // Same offset — coalesced into one segment.
    expect(result.status).toBe('ok')
    expect(result.segments.length).toBe(1)
  })

  it('handles two sequential pause regions in the same file', () => {
    // Reference has two gaps; other file is continuous with the same offset.
    const otherPower = powerPattern(700, 0)
    const other = makeSeries(700, 0, otherPower)

    // Ref: 200 s data, 15 s gap, 200 s data, 20 s gap, 200 s data
    const refPower: (number | null)[] = [
      ...otherPower.slice(0, 200),
      ...Array(15).fill(null),
      ...otherPower.slice(215, 415),
      ...Array(20).fill(null),
      ...otherPower.slice(435, 635),
    ]
    const ref = makeSeries(655, 0, refPower)

    const result = alignPair(ref, other)
    // Same offset throughout — coalesced into one segment.
    expect(result.status).toBe('ok')
    expect(result.segments.length).toBe(1)
  })

  it('handles a pause longer than the old ±30 s Pass 3 window', () => {
    // The offset jump after the pause is +200 s (well beyond the old ±30 s limit).
    const preLen = 300
    const gapLen = 60
    const postLen = 250
    const totalRefLen = preLen + gapLen + postLen

    // Build the other file first with a continuous pattern.
    const otherLen = totalRefLen - 30
    const otherPower = powerPattern(otherLen, 0)
    const other = makeSeries(otherLen, 0, otherPower)

    // Reference: matches other at offset 0 for t < preLen, null gap for
    // [preLen, preLen+gapLen), then matches other at offset +200 for t >= preLen+gapLen.
    const refPower: (number | null)[] = []
    const gapStart = preLen
    const gapEnd = preLen + gapLen
    const offsetJump = 200

    for (let i = 0; i < totalRefLen; i++) {
      if (i < gapStart) {
        refPower.push(otherPower[i])
      }
      else if (i < gapEnd) {
        refPower.push(null)
      }
      else {
        const otherIdx = i - offsetJump
        if (otherIdx >= 0 && otherIdx < otherLen) {
          refPower.push(otherPower[otherIdx])
        }
        else {
          refPower.push(null)
        }
      }
    }
    const ref = makeSeries(totalRefLen, 0, refPower)

    const result = alignPair(ref, other)
    expect(result.status).not.toBe('failed')
    expect(result.segments.length).toBeGreaterThanOrEqual(2)

    // Last segment should have a large positive offset (near +200)
    const lastOffset = result.segments[result.segments.length - 1].offsetSeconds
    expect(lastOffset).toBeGreaterThanOrEqual(150)
    expect(lastOffset).toBeLessThanOrEqual(250)
  })

  it('does not create false segments from sensor dropouts (short nulls)', () => {
    // A 3-second dropout should NOT be treated as a pause
    const refPower = powerPattern(600, 0)
    const ref = makeSeries(600, 0, refPower)

    const otherPower = [
      ...refPower.slice(0, 150),
      null, null, null, // 3-second dropout
      ...refPower.slice(153, 600),
    ]
    const other = makeSeries(600, 0, otherPower)

    const result = alignPair(ref, other)
    // Short dropout: should not produce multiple segments
    expect(result.segments.length).toBe(1)
  })

  // ── T8.1: leading non-overlap + real pause + trailing non-overlap ─────
  it('filters leading and trailing extent gaps, keeps only the internal pause', () => {
    // Other file starts later, has a real offset-jump pause, and ends earlier.
    const otherLen = 500
    const otherPower = powerPattern(otherLen, 0)
    const otherLead = 60 // other starts 60 s after ref
    const other = makeSeries(otherLen, otherLead * 1000, otherPower)

    // Ref: 0..60 (pre-other), 60..360 (matches other at offset 0),
    // 360..458 (null gap = 98s pause), 458..658 (matches other at offset +133)
    const refLen = 700
    const gapStart = 360
    const gapLen = 98
    const gapEnd = gapStart + gapLen
    const refPower: (number | null)[] = []
    for (let i = 0; i < refLen; i++) {
      const otherIdx = i - otherLead
      if (i < gapStart) {
        refPower.push(otherIdx >= 0 && otherIdx < otherLen ? otherPower[otherIdx] : powerPattern(1, i)[0])
      }
      else if (i < gapEnd) {
        refPower.push(null)
      }
      else {
        // offset +133: ref[i] matches other[i - otherLead - 133]
        const oi2 = i - otherLead - 133
        refPower.push(oi2 >= 0 && oi2 < otherLen ? otherPower[oi2] : powerPattern(1, i)[0])
      }
    }
    const ref = makeSeries(refLen, 0, refPower)

    const result = alignPair(ref, other)
    expect(result.status).toBe('warning')
    expect(result.segments.length).toBe(2)
    expect(Math.abs(result.segments[0].offsetSeconds)).toBeLessThanOrEqual(2)
    expect(result.segments[1].offsetSeconds).toBeGreaterThanOrEqual(100)
    // No leading 1s artefact segment
    expect(result.segments[0].fromTime).toBe(other.timestamps[0])
    // Full local coverage
    expect(result.segments[result.segments.length - 1].toTime).toBe(
      other.timestamps[other.timestamps.length - 1],
    )
  })

  // ── T8.2: two true offset jumps ───────────────────────────────────────
  it('handles two true offset jumps producing exactly 3 segments', () => {
    const otherLen = 900
    const otherPower = powerPattern(otherLen, 0)
    const other = makeSeries(otherLen, 0, otherPower)

    // Ref: gap1 at 300..360 (60s), then offset changes from 0 to +50
    //      gap2 at 600..670 (70s), then offset changes from +50 to +180
    const refPower: (number | null)[] = []
    let currentJump = 0
    const jumps = [
      { start: 300, len: 60, newOffset: 50 },
      { start: 600, len: 70, newOffset: 180 },
      { start: 1000, len: 0, newOffset: 180 }, // sentinel: end
    ]
    let jumpIdx = 0
    for (let i = 0; i < 950; i++) {
      const j = jumps[jumpIdx]
      if (i >= j.start && i < j.start + j.len) {
        refPower.push(null)
      }
      else {
        if (i >= j.start + j.len && jumpIdx < jumps.length - 1) {
          currentJump = j.newOffset
          jumpIdx++
        }
        const oi = i - currentJump
        refPower.push(oi >= 0 && oi < otherLen ? otherPower[oi] : powerPattern(1, i)[0])
      }
    }
    const refLen = refPower.length
    const ref = makeSeries(refLen, 0, refPower)

    const result = alignPair(ref, other)
    expect(result.status).toBe('warning')
    expect(result.segments.length).toBe(3)
    expect(Math.abs(result.segments[0].offsetSeconds)).toBeLessThanOrEqual(2)
    expect(Math.abs(result.segments[1].offsetSeconds - 50)).toBeLessThanOrEqual(5)
    expect(Math.abs(result.segments[2].offsetSeconds - 180)).toBeLessThanOrEqual(10)
    // Full local coverage
    expect(result.segments[0].fromTime).toBe(other.timestamps[0])
    expect(result.segments[2].toTime).toBe(other.timestamps[otherLen - 1])
  })

  // ── T8.3: pause in ref then pause in other ────────────────────────────
  it('handles a ref pause followed by an other pause, each with its own offset', () => {
    const otherLen = 800
    const otherPower: (number | null)[] = []
    // Other: 0..300 normal, 300..330 null gap (pause in other),
    // 330..800 at offset +80 relative to ref
    for (let i = 0; i < otherLen; i++) {
      if (i >= 300 && i < 330) {
        otherPower.push(null)
      }
      else {
        otherPower.push(powerPattern(1, i)[0])
      }
    }
    const other = makeSeries(otherLen, 0, otherPower)

    // Ref: 0..200 matches other at offset 0,
    // 200..250 null gap (pause in ref),
    // 250..500 matches other at offset +40 (after ref pause alone),
    // then after other's pause (ref 600..) matches at offset +120
    const refPower: (number | null)[] = []
    for (let i = 0; i < 900; i++) {
      if (i >= 200 && i < 250) {
        refPower.push(null) // first gap (ref)
      }
      else if (i < 250) {
        // pre-gap: offset 0
        refPower.push(i < otherLen && otherPower[i] !== null ? otherPower[i]! : powerPattern(1, i)[0])
      }
      else if (i < 600) {
        // after ref gap: offset +40, other[i-40]
        const oi = i - 40
        refPower.push(oi >= 0 && oi < otherLen && otherPower[oi] !== null ? otherPower[oi]! : powerPattern(1, i)[0])
      }
      else {
        // after both gaps: offset +120, other[i-120]
        const oi = i - 120
        refPower.push(oi >= 0 && oi < otherLen && otherPower[oi] !== null ? otherPower[oi]! : powerPattern(1, i)[0])
      }
    }
    const refLen = refPower.length
    const ref = makeSeries(refLen, 0, refPower)

    const result = alignPair(ref, other)
    expect(result.status).toBe('warning')
    expect(result.segments.length).toBeGreaterThanOrEqual(2)
    // Each segment should have a different offset
    const offsets = new Set(result.segments.map((s) => s.offsetSeconds))
    expect(offsets.size).toBe(result.segments.length)
    // Full local coverage
    expect(result.segments[0].fromTime).toBe(other.timestamps[0])
    expect(
      result.segments[result.segments.length - 1].toTime,
    ).toBe(other.timestamps[otherLen - 1])
  })

  // ── T8.4: same-offset pause — no duplicate segment ───────────────────
  it('does not split on same-offset pauses', () => {
    const otherPower = powerPattern(600, 0)
    const other = makeSeries(600, 0, otherPower)

    // Ref has a 30 s null gap, but the best offset before and after is 0.
    const refPower: (number | null)[] = []
    for (let i = 0; i < 600; i++) {
      if (i >= 200 && i < 230) {
        refPower.push(null)
      }
      else {
        refPower.push(otherPower[i])
      }
    }
    const ref = makeSeries(600, 0, refPower)

    const result = alignPair(ref, other)
    expect(result.status).toBe('ok')
    expect(result.segments.length).toBe(1)
    expect(result.segments[0].offsetSeconds).toBe(0)
  })

  it('detects a recorded pause-like regime change after an initial real pause', () => {
    const otherLen = 900
    const otherPower = powerPattern(otherLen, 0)
    const other = makeSeries(otherLen, 0, otherPower)

    // First transition is a null gap, enabling recorded-regime detection.
    // Second transition is a 30 s zero-power run, not a null gap.
    const refPower: (number | null)[] = []
    for (let i = 0; i < 850; i++) {
      if (i < 300) {
        refPower.push(otherPower[i]) // offset 0
      }
      else if (i < 398) {
        refPower.push(null) // first real pause
      }
      else if (i < 550) {
        refPower.push(otherPower[i - 100]) // offset +100
      }
      else if (i < 580) {
        refPower.push(0) // recorded pause-like section, no null gap
      }
      else {
        refPower.push(otherPower[i - 160]) // offset +160
      }
    }
    const ref = makeSeries(refPower.length, 0, refPower)

    const result = alignPair(ref, other)
    expect(result.status).toBe('warning')
    expect(result.segments.length).toBe(3)
    expect(Math.abs(result.segments[0].offsetSeconds)).toBeLessThanOrEqual(2)
    expect(Math.abs(result.segments[1].offsetSeconds - 100)).toBeLessThanOrEqual(10)
    expect(Math.abs(result.segments[2].offsetSeconds - 160)).toBeLessThanOrEqual(10)
    // Recorded-data regime changes must split using the new offset's local
    // start, not the old offset's local projection.  Otherwise the first
    // part of the newly matched shape remains visibly late in the old segment.
    expect(result.segments[2].fromTime).toBeLessThanOrEqual(430_000)
  })

  // ── T8.5: exact segment count and coverage assertions ─────────────────
  it('no adjacent equal offsets in any result', () => {
    // Use the screenshot analogue test data and verify no adjacent equal offsets.
    const prePauseLen = 300
    const degradeLen = 35
    const gapLen = 98
    const postPauseLen = 250
    const totalRefLen = prePauseLen + degradeLen + gapLen + postPauseLen
    const otherLen = totalRefLen - 50
    const otherPower = powerPattern(otherLen, 0)
    const other = makeSeries(otherLen, 0, otherPower)

    const refPower: (number | null)[] = []
    const degradeStart = prePauseLen
    const gapStart = prePauseLen + degradeLen
    const gapEnd = prePauseLen + degradeLen + gapLen
    for (let i = 0; i < totalRefLen; i++) {
      if (i < degradeStart) {
        refPower.push(otherPower[i])
      }
      else if (i < gapStart) {
        refPower.push(0)
      }
      else if (i < gapEnd) {
        refPower.push(null)
      }
      else {
        const otherIdx = i - 133
        refPower.push(otherIdx >= 0 && otherIdx < otherLen ? otherPower[otherIdx] : null)
      }
    }
    const ref = makeSeries(totalRefLen, 0, refPower)

    const result = alignPair(ref, other)

    // No adjacent equal offsets
    for (let i = 1; i < result.segments.length; i++) {
      expect(result.segments[i].offsetSeconds).not.toBe(
        result.segments[i - 1].offsetSeconds,
      )
    }

    // Each segment's local bounds are strictly increasing
    for (let i = 1; i < result.segments.length; i++) {
      expect(result.segments[i].fromTime).toBeGreaterThan(
        result.segments[i - 1].toTime,
      )
    }
  })
})

// ─── alignAll ─────────────────────────────────────────────────────────────

describe('alignAll', () => {
  it('aligns multiple files against a reference', () => {
    const series: ResampledSeries[] = [
      makeSeries(600, 0, powerPattern(600, 0)), // ref (index 0)
      makeSeries(600, 0, powerPattern(600, 10)), // shifted by 10s
      makeSeries(600, 0, powerPattern(600, 0)), // same as ref
    ]

    const results = alignAll(series, 0)
    expect(results.size).toBe(3)
    expect(results.get(0)!.segments[0].offsetSeconds).toBe(0) // reference always 0
    expect(results.get(1)!.status).toBe('ok') // 10s offset detected, no pause
  })

  it('handles mixed success/failure across files', () => {
    const series: ResampledSeries[] = [
      makeSeries(600, 0, powerPattern(600, 0)),
      makeSeries(600, 0, powerPattern(600, 5)), // good
      {
        // no power data at all
        timestamps: [1000, 2000, 3000],
        values: Object.fromEntries(M.map((k) => [k, [null, null, null]])) as unknown as Record<MetricKey, (number | null)[]>,
      },
    ]

    const results = alignAll(series, 0)
    expect(results.get(0)!.status).toBe('ok')
    expect(results.get(1)!.status).toBe('ok')
    expect(results.get(2)!.status).toBe('failed')
  })
})
