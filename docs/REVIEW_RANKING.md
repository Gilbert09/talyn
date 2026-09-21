# Review ranking — what the data says

An offline experiment on the Reviews tab's ordering, run 2026-09-21. It answers
one question with numbers: **is the ranking model any good, and would different
features or a different model class be better?**

The short version: **the shipped model is worth about +23 points of top-3 once
it is fitted, and the features it uses are mostly the wrong ones.** But a
trivial "most recently requested first" sort scores within 1.5 points of the
best model found, and recency is provably near its own ceiling — so the honest
conclusion is that the ranking is not earning most of its complexity.

---

## Why this was run

The production install gate compares a fit against our own hand-set prior, on
our own data, with no external reference. "It beat the prior" can equally mean
the prior is bad. Nothing had ever measured how often the ordering matches what
a person actually reviews next, and the feature set came from the literature
rather than from evidence about this repository.

## Method

**Subjects** — 7 heavy reviewers on `PostHog/posthog`, auto-selected by volume
but deliberately spread across areas (one each from data-warehouse, surveys,
insights, ux, flags, ci, oauth) so scope and team effects would be visible
rather than averaged away. 300–900 review events each over six months. Bot
reviewers were excluded on GitHub's own `__typename`; without that filter the
"top reviewers" list is seven robots (`coderabbitai`, `greptile-apps`,
`stamphog`, `posthog`, `graphite-app`, …), which review far more than any human.

**Windows** — train `T-6mo → T-2mo`, select the configuration on
`T-2mo → T-1mo`, and touch the final month exactly once. Split strictly by
time: a random split over a time series leaks the future into the past, and the
whole question is whether last month is predictable from the months before it.

**Label** — at each instant a subject submitted a review, the *choice set* is
every other PR open, requested of them, and still unreviewed. Rank the set; ask
where the PR they actually picked landed.

**Metrics** — top-1, top-3, MRR, against four baselines. The baselines are the
point: a model that beats random and loses to newest-first has told us something
important.

## The harness was verified before any number was believed

It had already produced two confident, plausible, wrong answers.

1. **Solver check** — the lab's dimension-generic IRLS is bit-identical to
   production's `fitReviewRank` at width 6.
2. **Leakage check** — the training window genuinely restricts what the profile
   sees (710 events vs 896 unwindowed).
3. **Null check** — with labels shuffled both models collapse (54%→28%,
   50%→15%). A harness that scores well on noise is measuring itself.

**Two bugs it caught, both silent:**

- A one-feature "age only" floor scored **100%**. Cause: `computeFeatureStats`
  and `fitReviewRank` hardcode `dim = REVIEW_RANK_DIM` (6). Correct in
  production, where the feature list is fixed — but it meant every feature past
  the sixth was zeroed, so feature sets of 7, 8 and 9 features printed numbers
  *identical* to the 6-feature set. That reads as "the new features add
  nothing", which is publishable and completely wrong.
- The evaluation truncated the choice set to 10 candidates when the real queue
  averages **24**. See the correction below.

## Results

Held-out test month, configuration fixed in advance on the validation month,
scored against the **full** choice set.

| model | top-1 | top-3 | MRR |
|---|---|---|---|
| best learned (logistic, 23 features, 30d decay) | 29.3% | **53.4%** | 0.447 |
| **newest-first** | 31.9% | **51.9%** | 0.467 |
| shipped model, fitted | 14.2% | 30.8% | 0.278 |
| shipped prior (what a cold user gets) | 7.5% | 24.1% | 0.207 |
| random | 5.3% | 18.8% | 0.190 |
| oldest-first | 1.1% | 3.9% | 0.095 |

### The correction that matters most

An earlier run scored the best model at **65.5%** against a choice set truncated
to the 10 most-recently-requested candidates. On the real 24-candidate queue it
is **53.4%**. Newest-first is unaffected by that truncation (if the pick is in
the top 3 overall it is also in the top 3 of the top 10), so the apparent
"+13.6 over newest-first" was almost entirely an artifact of measuring an easier
task than a reviewer actually faces.

Three independent signs confirm the full-set number is the honest one: random
fell from 31% to 19% (≈3/24), oldest-first collapsed to 3.9%, and newest-first
did not move at all — exactly what a larger candidate pool predicts.

### Recency is saturated

A perfect recency oracle reaches **50.4%** top-3. Newest-first achieves 51.9%.
There is essentially nothing left to extract from "when was it requested" — and
that is why a single model fighting recency head-on gains only 1.5 points.

## What the features are worth

Mean |standardised weight| across subjects, best configuration:

```
authorAffinity     0.699  ██████████████████████████████████
passOvers          0.506  █████████████████████████
reciprocity        0.503  ████████████████████████
scopeAffinity      0.459  ██████████████████████
isBotAuthor        0.330  ████████████████
ageQuantile        0.257  █████████████
sameAuthorAsLast   0.245  ████████████
…
teamAffinity       0.132  ██████
pathFamiliarity    0.123  ██████
queueDepth         0.000
inSession          0.000
```

**Pass-over count is the best new idea** — how many times the subject reviewed
*something else* while this PR sat there. Each one is an explicit decision to
skip it. It also explains why oldest-first scores *below random*: age does not
mean "most owed", it means "already declined, N times".

**Scope affinity** (the conventional-commit `fix(hogql):` prefix) ranks 4th,
above both the directory and team features that were meant to capture the same
idea.

**Three shipped features are near dead weight**: `pathFamiliarity` (0.123),
`teamAffinity` (0.132), and `repoAffinity`, which was dropped entirely — every
subject works in one repository, so it is effectively constant.

**Two features measure exactly nothing**, and the reason generalises: a feature
that is **constant within a choice set cannot rank anything**. `queueDepth` and
`inSession` are properties of the moment, identical for every candidate, so they
cancel. They are only useful crossed with a per-candidate feature.

## What this means for the product

1. **Adopt pass-over count and scope affinity.** They are the two strongest
   additions and both are computable from data already fetched.
2. **Drop `repoAffinity`, and review `pathFamiliarity` and `teamAffinity`.**
   They cost parameter budget and contribute little.
3. **Reconsider the age ramp entirely.** It was built to favour *older* PRs.
   Oldest-first scores 3.9% — worse than random by a factor of five. The sign is
   wrong.
4. **Do not expect a large win over a good recency sort.** The defensible claim
   is "+23 points over what ships today", not "better than sorting by newest".

## Things shipped the same week that the data does not support

Stated plainly because they were added on intuition and the experiment is the
first evidence either way:

- **The absence correction** (excluding requests that arrived while somebody was
  away) is worth **−0.0 points**. Within noise.
- **The recency half-life** barely matters: 42.6%–44.0% across 7 days to never.
  The 90-day default is as good as anything, which also means the careful
  argument for 90 days specifically was not load-bearing.
- **`teamAffinity`**, added the same morning, ranks 16th of 23.

## Open questions

- **A two-stage cascade** is the most promising untried idea, and follows
  directly from recency being saturated: stage 1 selects the fresh cohort,
  stage 2 re-ranks *within* it on affinity. A single model must fight recency;
  a cascade lets recency win where it should and affinity decide the rest.
- **Pooling across users.** 300–900 events each is thin. One model over all
  subjects with per-subject deviations (Gmail Priority Inbox's architecture)
  is the standard fix, and is unavailable today only because Talyn workspaces
  are effectively single-user.
- **This measures habit, not quality.** A model that perfectly predicted what
  somebody reviews next would score 100% and add nothing over the status quo.
  Some of the 53.4% is re-describing GitHub's own newest-first page ordering.
- **No live state** — checks, conflicts, approvals — appears anywhere here,
  because GitHub does not retain it historically. Production's deterministic
  half is therefore untested by this experiment.
- **One subject regressed** (−7.4 points). The gain is not uniform.

## Re-running it

The harness lives in `scripts/spikes/review-rank-lab/`, which is gitignored
(`.gitignore:58`) because the cache holds colleagues' review history. It is a
throwaway spike; this document is the durable artifact.

```
npx tsx scripts/spikes/review-rank-lab/run.ts --fetch     # ~350 GraphQL points
npx tsx scripts/spikes/review-rank-lab/verify.ts          # check before believing
npx tsx scripts/spikes/review-rank-lab/confirm.ts         # the honest number
```

It authenticates through `gh`, so it spends the running user's own rate budget
rather than the app's, and every raw response is cached — the entire feature and
model sweep after the first pull costs **zero** API calls. The full pull cost
345 points against a planned estimate of 3,300: GitHub prices a search by the
connection's `first:`, not by the depth of the sub-selection, so the
`files`/`reviews`/`timeline` selections are free. The production backfill's
header carries the wrong estimate.
