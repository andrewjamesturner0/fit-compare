# Statistical comparison of power-meter data

## Problem statement

We have two (or more) power files recording the same ride on different devices. After time-alignment we have paired second-by-second power values. We want to answer: **are these two power meters giving the same readings**, or are they meaningfully different? The expected measurement error for a typical power meter is 2-3%. This document surveys the appropriate statistical tools.

---

## What we already compute

`src/stats.ts` already produces:

- **Per-file descriptives**: mean, max, min, standard deviation, N.
- **Pairwise**: Pearson *r*, MAE (mean absolute error, in watts), MPE (mean percentage error, relative to the reference file).

Pearson *r* tells you whether the traces move together (shape agreement). It does not detect a consistent offset: if File B reads exactly 20 W higher than File A at every second, *r* is still 1.0. MAE gives the average magnitude of disagreement and MPE expresses it as a percentage of the reference value. These are useful but they do not, on their own, tell you whether the disagreement is **larger than you would expect from the instruments' known tolerance**.

---

## What is missing: a decision rule

The user question is fundamentally about **equivalence**: given that we know power meters are specified to +-2-3%, do the observed differences fall within that band, or do they exceed it? A p-value from a significance test ("is the mean difference different from zero?") is the wrong tool here because:

1. With thousands of paired observations, even a trivially small and practically irrelevant difference (e.g. 1 W mean bias) will produce a statistically significant p-value. The test becomes overpowered.
2. Failing to reject the null ("p > 0.05, therefore no difference") is not the same as demonstrating equivalence. Silence is not proof of agreement.

The right family of tools is **equivalence testing** combined with **agreement statistics**.

---

## Recommended tool 1: Bland-Altman (limits of agreement)

*Reference: Bland & Altman (1986), The Lancet.*

### What it is

Bland-Altman is the standard method for comparing two measurement techniques. For each pair of measurements (same timestamp, two files), you plot:

- x-axis: the mean of the two readings, (A + B) / 2
- y-axis: the difference, A - B

Three summary statistics are computed:

|Statistic|Formula|What it tells you|
|-|-|-|
|Bias (mean difference)|(1/n) * Sum(A_i - B_i)|Systematic offset. Is one meter consistently reading higher?|
|SD of differences|sqrt(variance of differences)|How much the differences scatter around the bias.|
|Limits of agreement|bias +- 1.96 * SD|The interval within which 95% of future differences should fall, assuming normality.|

### Interpretation

If the limits of agreement fall entirely within a pre-specified **clinical tolerance band** (e.g. +-3% or +-15 W, whichever is larger), you can conclude the two meters agree well enough to be used interchangeably. If they extend outside that band, the meters disagree by more than the acceptable margin.

A Bland-Altman plot also visually reveals **proportional bias** (does the difference grow with the magnitude? e.g. accurate at 100 W but 15 W high at 400 W) and **heteroscedasticity** (does the scatter change across the range?).

### Implementation notes

- The 1.96 multiplier assumes normally distributed differences. For power data this is usually reasonable after excluding zeros (coasting). A normality check (Shapiro-Wilk or a Q-Q plot) can confirm.
- If the differences are not normal, a non-parametric alternative uses the 2.5th and 97.5th percentiles of the observed differences instead of mean +- 1.96*SD.
- Bland-Altman typically uses the *average* of two measurements as the x-axis (not the reference value alone) because neither instrument is a gold standard. However, if one meter is known to be more accurate (e.g. a calibrated SRM vs. a consumer pedal-based meter), a modified version with the reference on the x-axis is also valid.

### What it would look like in code

```typescript
interface BlandAltmanResult {
  bias: number              // mean difference (watts)
  biasPercent: number       // bias as % of grand mean
  sdDiff: number            // SD of differences
  loaLower: number          // lower limit of agreement (watts)
  loaUpper: number          // upper limit of agreement (watts)
  loaLowerPercent: number   // LOA as % of grand mean
  loaUpperPercent: number
  n: number
}
```

This is straightforward: iterate the paired data, compute differences, then mean and SD of those differences.

---

## Recommended tool 2: TOST equivalence test

*Reference: Schuirmann (1987), Journal of Pharmacokinetics and Biopharmaceutics.*

### What it is

TOST (Two One-Sided Tests) flips the usual hypothesis-testing logic. Instead of testing "is there a difference?" it tests "are we confident there is **no meaningful difference**?"

You choose an **equivalence margin** (delta). For power meters, a reasonable delta might be 3% of the mean power, or +-10 W, or some combination.

Then you run two one-sided t-tests:

1. H0: mean difference <= -delta  vs. H1: mean difference > -delta
2. H0: mean difference >= +delta  vs. H1: mean difference < +delta

If **both** nulls are rejected at your chosen alpha (typically 0.05), you conclude the mean difference lies within (-delta, +delta) and the meters are **equivalent** at the chosen margin.

Equivalently, you construct a 90% confidence interval (not 95%) for the mean difference and check whether it falls entirely inside (-delta, +delta). This "90% CI inside the margin" formulation is easier to display in a UI.

### Why 90% CI, not 95%?

TOST at alpha = 0.05 uses a 90% confidence interval because each one-sided test has alpha = 0.05, and the overall procedure controls the Type I error rate at 0.05. This is a deliberate and well-established convention in equivalence testing.

### Interpretation

- If the 90% CI of the mean difference is entirely inside (+-delta): **equivalent** (green / "these meters agree within tolerance").
- If it extends outside the margin on one side: **non-equivalent** (red / "these meters disagree by more than the tolerance").
- If it straddles the margin boundary: **inconclusive** (amber / "more data needed, or the margin is too tight").

### What it would look like in code

```typescript
interface TostResult {
  equivalenceMargin: number        // delta, in watts
  equivalenceMarginPercent: number // delta as % of grand mean
  meanDiff: number                 // mean of paired differences
  ciLower: number                  // 90% CI lower bound (watts)
  ciUpper: number                  // 90% CI upper bound (watts)
  equivalent: boolean              // true if CI fully inside +-delta
  conclusion: 'equivalent' | 'non-equivalent' | 'inconclusive'
}
```

The key design choice is how to set delta. Options:

1. **Fixed wattage** (e.g. +-10 W): simple but does not scale with effort. 10 W is a big deal at 100 W (10%) but negligible at 400 W (2.5%).
2. **Percentage of mean** (e.g. 3%): scales naturally but is sensitive to the mean. At very low powers (coasting, soft-pedalling downhill at 50 W), 3% is 1.5 W -- tighter than most meters can achieve.
3. **Hybrid**: max(3% of mean, 5 W). This is what Garmin effectively does in their pedal-based power meter comparison tool. It provides a floor so the margin is never absurdly small.

---

## Recommended tool 3: Cohen's d (effect size)

### What it is

Cohen's d is the standardised mean difference:

```
d = (mean_A - mean_B) / SD_pooled
```

where SD_pooled is the pooled standard deviation across both samples. For paired data, a variant using the SD of the differences (dz) is more common:

```
dz = mean_diff / SD_diff
```

This gives you the mean difference in units of the natural variability of the differences.

### Interpretation (Cohen's conventions)

| |dz| |Interpretation|
|-|-|
| < 0.2 | Negligible |
| 0.2 - 0.5 | Small |
| 0.5 - 0.8 | Medium |
| > 0.8 | Large |

For power meter comparison, a dz below 0.2 strongly suggests the difference is trivial relative to the natural second-to-second variation in power. A dz above 0.8 says the bias is large enough that it stands out from the normal fluctuations of riding.

### Why it complements the others

TOST answers "are they equivalent within a hard margin?" Effect size answers "how practically meaningful is the difference, regardless of statistical significance?" A meter might fail TOST at a 2% margin but have dz = 0.15 (negligible effect size), which tells you the disagreement is systematic but small.

---

## Recommended tool 4: RMSE and normalised RMSE

### What it is

RMSE (root mean square error) penalises large errors more heavily than MAE:

```
RMSE = sqrt( (1/n) * Sum((A_i - B_i)^2) )
```

Normalised RMSE can be expressed as a percentage of the mean (CV-RMSE) or as a percentage of the range:

```
NRMSE_mean = RMSE / mean_power * 100
```

### Why it is useful

MAE (which we already have) gives the average error in watts. RMSE highlights whether there are occasional large spikes of disagreement. If MAE is 5 W but RMSE is 15 W, the difference is mostly in a few bad seconds (sprint spikes, dropouts). If MAE and RMSE are close, the error is consistent. The ratio RMSE/MAE is itself a useful diagnostic.

---

## Recommended tool 5: Concordance correlation coefficient (CCC)

*Reference: Lin (1989), Biometrics.*

### What it is

CCC measures agreement along the line of identity (y = x), not just any straight line. It decomposes into two components:

```
CCC = r * Cb
```

where:
- **r** = Pearson correlation (precision -- how tightly the points cluster around any line)
- **Cb** = bias correction factor (accuracy -- how close that line is to y = x)

Cb is computed from the means and variances of the two series. If the two meters have identical means and variances, Cb = 1 and CCC = r. Any difference in mean (bias) or variance (one meter being noisier) pulls Cb below 1.

### Interpretation

|CCC|Strength of agreement|
|-|-|
| > 0.99 | Almost perfect |
| 0.95 - 0.99 | Substantial |
| 0.90 - 0.95 | Moderate |
| < 0.90 | Poor |

CCC is a single number that captures both precision and bias. It is more honest than Pearson r alone: two meters that correlate at r = 0.98 but have a 20 W offset will have a noticeably lower CCC, correctly flagging the bias.

Note: the thresholds above are from Lin's original paper and are somewhat field-dependent. McBride (2005) suggests >0.95 for "acceptable agreement" in medical device comparison.

---

## Recommended tool 6: Coefficient of variation (CV) of the differences

### What it is

```
CV = (SD_diff / mean_power) * 100
```

This is the standard deviation of the paired differences expressed as a percentage of the overall mean power. It answers: "by what percentage do the two meters typically disagree from second to second?"

### Why it is useful

CV is intuitive and widely reported in power-meter reviews. DC Rainmaker and GP Lama regularly report "accuracy within +-1.5%" for power meters; this is essentially reporting the CV (sometimes the 95% limits). If your CV is 1.8% for a meter rated at +-2%, you are within spec. If CV is 4%, something is wrong.

---

## Putting it together: a summary dashboard

For the StatsPanel, I would suggest adding a summary row or callout that combines:

1. **Bland-Altman**: bias + limits of agreement, expressed both in watts and as % of mean.
2. **TOST equivalence**: a one-line verdict against a user-configurable tolerance margin (default 3%, with a 5 W floor).
3. **Effect size (dz)**: for context.

Example summary text:

```
Bias: -3.2 W (-1.4% of mean)
Limits of agreement: -18.1 W to +11.7 W (-7.8% to +5.0%)
Equivalence at ±3% margin: NOT EQUIVALENT (90% CI [-5.1, -1.3] W extends beyond margin)
Effect size dz: 0.23 (small)
```

The Bland-Altman plot itself is probably overkill for a stats panel (it is a whole graph), but a small inline sparkline or just the summary numbers would be powerful.

---

## Caveat: autocorrelation

All the methods above assume independent paired observations. Second-by-second power data during steady riding is **not independent** -- if you are pushing 250 W this second, you are probably pushing 245-255 W next second. This autocorrelation has two effects:

1. **Effective sample size is inflated.** A 1-hour ride with 3,600 paired observations might only contain the information of ~100-300 independent observations once you account for autocorrelation. The naive confidence intervals from a t-test will be too narrow.
2. **TOST and t-test CI widths are understated.** You might think you have overwhelming evidence for equivalence when you really do not.

### Mitigations

**Option A: Ignore it.** In practice, sports-science papers comparing power meters routinely use paired t-tests and Bland-Altman on the full second-by-second data without correcting for autocorrelation. The practical reasoning is that power varies naturally enough during a varied ride (climbs, descents, sprints, coasting) that the effective autocorrelation is lower than it would be during a steady-state lab test. For a tool aimed at cyclists comparing their own meters, this is probably acceptable.

**Option B: Downsample.** Average power into 10-second or 30-second blocks before comparing. This reduces autocorrelation and also better reflects how cyclists actually use power data (nobody analyses second-by-second power; they look at lap averages, interval averages, or 3-second/30-second smoothing). The downside is losing short-duration accuracy information (sprint spikes).

**Option C: Use a mixed-effects model or GEE.** This is the formally correct approach but is heavy to implement in TypeScript and hard to explain in a UI. Not recommended for this tool.

**Recommendation:** Implement the statistics on the full 1 Hz grid (Option A) but include a note in the UI that confidence intervals and equivalence verdicts are approximate and should be interpreted as descriptive summaries rather than formal hypothesis tests. If a user demands a formal verdict, suggest downsampling to 10-second or 30-second averages as a sensitivity check.

---

## What to implement, in priority order

|Priority|Method|Effort|Value|
|-|-|-|
|1 (essential)|Bland-Altman bias + LOA|Low. Iterate paired data, compute mean/SD of differences.|Directly answers "how different are these meters?" in interpretable units.|
|2 (essential)|TOST equivalence test|Low. Paired t-test CI, compare to margin.|Gives a clear yes/no verdict with a user-chosen tolerance.|
|3 (high)|Cohen's dz|Trivial. One division.|One extra number that contextualises the size of the bias.|
|4 (medium)|CCC|Medium. Needs mean, variance, Pearson r, then formula.|Single honest number combining precision + bias.|
|5 (medium)|RMSE and RMSE/MAE ratio|Trivial.|Highlights spiky vs. consistent error.|
|6 (lower)|Bland-Altman plot|High. Needs a whole new mini-chart.|Visual, but probably belongs in a separate tab or expandable section.|
|7 (lower)|Normality test (Shapiro-Wilk)|Medium.|Validates the 1.96 multiplier in LOA. Can be mentioned as a caveat.|

Items 1-3 together are maybe 60-80 lines of TypeScript and cover the core need: "are these the same or meaningfully different?" Items 4-5 are nice-to-have enrichment. Item 6 is a separate feature.

---

## Summary

For comparing power-meter files with ~2-3% expected error, the right statistical framework is **equivalence testing** (TOST) paired with **agreement statistics** (Bland-Altman). The existing MAE and MPE are useful supporting figures but do not on their own answer the user's question. Adding bias, limits of agreement, and a TOST verdict against a configurable margin would give the tool a solid, defensible statistical foundation -- and a clear outcome beyond "the traces look pretty close."

---

## UI decision

After reviewing five mockups (see `.agent-docs/comparison-mockups/`), the chosen direction is a hybrid of **Option 2 (side-by-side cards)** with the **verdict banner from Option 1** at the top.

### Chosen layout

1. **Verdict banner** (from Option 1). A coloured strip at the top of the pairwise section: green for "Equivalent at +-X%", amber for "Inconclusive", red for "Not equivalent". Shows the TOST 90% CI and the equivalence margin inline. This gives an immediate yes/no answer before the user reads any numbers.

2. **Side-by-side file cards** (from Option 2). Three columns:
   - Left card: the reference file's per-file descriptives (mean, max, SD).
   - Centre column: the delta summary -- mean bias in large type, a tolerance-bar visual showing where the bias sits relative to the margin, and the limits of agreement.
   - Right card: the other file's per-file descriptives.

3. **Supporting stat chips** below the cards: CCC, RMSE, Cohen's dz, Pearson r, CV of differences, MAE. Compact, read-only, no interaction needed.

### Rationale

- The verdict banner answers the one-sentence question ("are these the same?") immediately.
- The side-by-side cards treat both files as equals, which matches the use case (comparing two power meters, neither inherently a gold standard).
- The centre delta column isolates the comparison itself from the per-file descriptives.
- Stat chips keep the supporting numbers available without competing with the primary verdict and bias.

### What was rejected and why

- **Option 3 (accordion)**: hides detail. The whole point of adding these stats is that the current pairwise strip is too terse. Burying the new numbers behind a click defeats the purpose.
- **Option 4 (dense table)**: strong for 3+ files but feels like a CSV export. The typical session has 2-3 files and the user wants a readable summary, not a matrix.
- **Option 5 (narrative + sparkline)**: the histogram sparkline is a real chart and would require its own rendering infrastructure. Good idea for a future iteration but too much scope for the initial implementation. The narrative sentence works well as a caption but should accompany the numbers, not replace them.

### Mockup references

- `.agent-docs/comparison-mockups/01-verdict-banner.html` -- verdict banner style
- `.agent-docs/comparison-mockups/02-side-by-side-cards.html` -- card layout and delta column
- `.agent-docs/comparison-mockups/index.html` -- overview of all five options
