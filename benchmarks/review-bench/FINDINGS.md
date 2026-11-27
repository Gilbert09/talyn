# Review quality results

## Golden-case runs against PostHog Review (2026-11-27)

### Repeated runs with the final scorer

The v7 reliability method stays in this change. We keep Opus for this review configuration.
Across four cases, v7 raises mean recall after the judge from 48.2% to 50.7%.
This small gain needs more runs before we can call it reliable.
Recall at the default threshold for display rises only from 47.5% to 48.2%.

The [saved results](./results/golden-2026-11-27.csv) list all 20 runs, including two invalid runs.
Recall values in that file are fractions. Costs exclude the scorer and include all review units.

v6 already has parts, the rules lens and the judge that returns ids.
v7 adds a method to audit limits.
It checks what each limit measures, finds paths that bypass it, and compares estimates with the real work.
Both variants use Standard, concurrency 3, and Claude Opus 5.5 for every unit and the scorer.
Each variant ran twice per case. All 16 runs have no recorded unit errors.
#143292 and #139627 were tuning cases. #127796 and #139201 were held out during prompt changes.

Each cell lists two runs. Recall includes findings at every severity.

| Case | v6 before judge | v6 after judge | v7 before judge | v7 after judge |
| --- | --- | --- | --- | --- |
| #143292, 18 issues | 72%, 67% | 72%, 56% | 61%, 61% | 56%, 61% |
| #139627, 13 issues | 23%, 46% | 23%, 46% | 46%, 38% | 46%, 31% |
| #127796, 14 issues | 50%, 50% | 50%, 50% | 64%, 71% | 64%, 71% |
| #139201, 17 issues | 41%, 59% | 35%, 53% | 41%, 53% | 29%, 47% |

These means give each run equal weight. Each case has two runs.

| Measure | v6 | v7 |
| --- | --- | --- |
| Recall before judge | 51.0% | 54.6% |
| Recall after judge | 48.2% | 50.7% |
| Recall after judge, minor and above | 47.5% | 48.2% |
| High-severity recall after judge | 46.9% | 56.3% |
| Mean review cost | $7.22 | $7.11 |
| Visible findings the scorer called wrong | 0 | 0 |

The largest gain is on #127796: mean recall after the judge rises by 17.9 percentage points.
On #139627, v7 finds the high-severity issue in one of two runs. v6 finds it in neither run.
On #143292, mean recall after the judge falls by 5.6 points. On #139201, it falls by 5.9 points.
Two runs per case cannot separate a small gain from sampling noise.
The scorer also labels some extra findings as doubtful. Zero findings called wrong does not prove perfect precision.

### Scoring fixes and remaining limits

Every v6 and v7 run uses the same revised scorer prompt and the same scorer model.
The final run, `v7-139201-b`, was also scored with this prompt.
One scorer call matches all candidates to golden issues.
The final score uses that same reply, with references moved to the findings that survive the judge.
This prevents two independent scorer calls from producing an apparent recall gain after filtering.
The scorer lists every restatement of a golden issue, so removing one copy does not remove all credit.
A finding can still match only one golden issue.

That last rule can undercount a finding that describes several related defects.
For example, `v7-139201-a` keeps a finding about token access that also describes the missing query throttles.
It also keeps an admission finding that describes cache-only batches with no concurrency bound.
The scorer credits those findings to other golden issues, so G5 and G11 appear lost after deduplication.
In `v7-139201-b`, the judge groups repeated cache results with the broader finding about memory before admission.
That broader finding does not state every detail of G10. We do not restore credit by hand.
These examples limit what the measured loss through the judge can tell us.

### Sonnet for parts and sweeps

The v8s experiment uses v7 prompts and Sonnet 5.5 for security, reliability and sweep units.
The whole-PR correctness lens, rules lens, judge and scorer still use Opus 5.5.
Only two cases completed. Each ran once.

| Case | v7 Opus mean before / after | v8s before / after | Opus mean cost | v8s cost |
| --- | --- | --- | --- | --- |
| #127796 | 68% / 68% | 71% / 64% | $5.83 | $3.34 |
| #139627 | 42% / 38% | 23% / 23% | $7.45 | $3.00 |
| #143292 | 61% / 58% | Invalid: rate limit | $8.89 | Incomplete |
| #139201 | 47% / 38% | Invalid: rate limit | $6.28 | Incomplete |

Sonnet cuts total review cost by 43% on #127796 and 60% on #139627.
The Sonnet lenses on those cases make only 1–4 tool calls each.
Five of their six sweeps make no tool calls. The other sweep makes one.
Few tool calls alone do not prove poor review quality, but this differs from the intended code inspection.
The large recall loss on #139627 does not support a cheaper production tier with these prompts.
We did not start repeat runs.

Both failed runs contain explicit 429 rate-limit errors.
On #143292, all three sweeps, the judge and the scorer fail.
On #139201, the judge and the scorer fail.
The harness saves unjudged findings when the judge fails. Those saved files do not make a run valid.
Neither failed run has a score in the comparison or the saved results.
All Claude accounts remain at their usage limits, so we did not retry them on the same accounts.
Those two experiments need fresh complete runs when Claude usage is available.
`--score-only` cannot replace their failed review units.

### Why this run

On PostHog/posthog#143292 (a new warehouse source, 1,755 lines), PostHog Review, Veria, Parameter and a human reviewer raised about 18 distinct real problems.
Talyn's review raised 8 of them over several cycles. Its judge then rejected 5 of those 8.
We read PostHog Review's source (`products/review_hog`) and ran Talyn's real prompts against the pull request with Claude Code (`src/golden.ts`).

### What was wrong

1. **The judge dropped real problems.** Its bar was "precision over recall" and "on the fence: drop".
   Every reason it gave was a guess about the data, never a line of code: "writers rarely produce this", "catalogs are usually small".
   PostHog measured the same failure in its own strict validator, and its Standard review has no validator.
2. **The lenses read the whole change at once.** Three lenses each held all 1,755 lines and made 4 to 17 tool calls.
   PostHog's Standard reads a large change as one whole-PR generalist plus two lenses per part of about 600 lines.
3. **No reviewer read the repository's rules.** PostHog's prompt makes every session read `AGENTS.md`, `CLAUDE.md`, the `.agents` guides and the skills those files route a change to.
   On this pull request the warehouse-source skill states the resume contract, the sample-redaction rule and the primary-key rule. The code-style guide states the dataclass rule.
4. **The bar told a lens to stop early.** "Report the ones that matter, not everything you noticed." PostHog's rubric says to keep going until every problem the author would fix is listed.
5. **The judge copied every kept finding back as JSON.** One typo in an 18 KB copy failed the parse and left a whole review unchecked.

### What changed

- Standard splits a change into parts of about 600 lines, by directory, at most 4 (`planCodeReviewParts`). Deep allows 8.
- The generalist (`correctness`) and a new `rules` lens read the whole pull request once. `security` and `reliability` read one part each.
- Every prompt has a repository-rules step: read the rule files at the base branch, open the routed guides in full, and list what was read.
- The bar follows the Codex rubric: problems this change introduces, a named trigger and consequence, no discount for an unusual input, and keep going.
- The judge refutes instead of weighing. It drops a candidate only with evidence: a wrong premise, an impossible trigger, an older problem, a style preference or a duplicate. Rarity is not a reason. A real but smaller problem gets a lower severity.
- The judge names its keeps by id and severity, and copies nothing else.

### Earlier exploratory results

Recall of the golden problems, before and after the judge. Claude Opus 5.5 ran every unit. One row is one run.
These exploratory runs used earlier scorer prompts. Their scores are not directly comparable with the repeated runs above.

PostHog/posthog#143292, 18 golden problems (`golden/posthog-143292.json`):

| Variant | Before judge | After judge |
| --- | --- | --- |
| Production prompts | 28% | 6% |
| Parts, generalist, new bar, refute-first judge | 56% | 56% |
| + rules step | 50%, 50% | 50%, 44% |
| + how-to-review method, consequence rule for the judge | 67%, 56% | 61%, 50% |
| + rules lens | 72%, 61% | 67%, 61% |
| + rule severity follows consequence, judge groups duplicates | 67% | 67% |

PostHog/posthog#139627, 13 golden problems, initially held out (`golden/posthog-139627.json`):

| Variant | Before judge | After judge |
| --- | --- | --- |
| Production prompts | 46%, 31% | 15%, 8% |
| Final prompts | 31%, 38%, 38% | 31%, 23%, (judge output did not parse) |

On both pull requests the old judge removed most of the real problems, and the new one keeps them.
On #143292 discovery also more than doubled. On the held-out #139627 it did not change: the misses there are memory-accounting bugs in Rust that no lens hunted for.
Each pull request ran only 1 to 3 times per variant, and one finding moves recall by 6 to 8 points.
The golden sets come mostly from other bots, so they favor what those bots find.
The judge that returns ids came after these exploratory runs. The repeated v6 and v7 runs above measure it.

A Standard review of a large change now runs about 12 units instead of 5.
On #143292 that was about $10.70 of model usage per review with Opus, against $3.41 before. On #139627 it was $9.29 against $3.56.

## Summary

Talyn's Standard review scores near the middle of the ReviewBench leaderboard on the 25-PR test set.
These older ReviewBench results used the production prompts from before this change.

| Measure (25 PRs, micro) | Talyn Standard | Leaderboard middle row |
| --- | --- | --- |
| High-severity grounded precision | 100% | 97.2% |
| High-severity grounded recall | 50.0% | 51.4% |
| High-severity grounded F1 | 66.7% | 67.2% |
| All-severity grounded precision / recall | 91.2% / 25.9% | — |
| All-severity augmented precision / recall | 95.1% / 37.1% | — |
| Findings | 143 | — |

These are local scores, not leaderboard scores.
The leaderboard judge is Claude Sonnet 5. Our judge was `openai-codex/gpt-6.1-sol` through a ChatGPT subscription.
The reviewer used `gpt-6.1-terra` for lenses, sweep and judge, with default effort.
Each PR ran once. Model sampling and semantic matching change scores between runs.

## The harness bug that caused the first 0% score

The first PR 0 run scored 0% precision and 0% recall.
Codex's `read-only` sandbox uses bubblewrap. Docker does not let bubblewrap make a namespace.
Every agent command failed with `bwrap: No permissions to create a new namespace`.
Thus the reviewers could not read the checkout, and they reviewed only the inline diff.

The fix: the adapter starts `codex exec` with `--dangerously-bypass-approvals-and-sandbox`.
The ReviewBench container is the isolation boundary. This flag is only in the container.
A guard now fails a unit when its agent commands fail for an environment reason.
Thus a blind review cannot count as a clean review again.
The guard is strict. A unit whose last optional command fails (for example `command -v jq`) also fails, and ReviewBench retries it.

## Where recall goes

1. **Discovery misses.** On PR 0, no unit reported 8 of the 9 golden true positives.
   The judge did not drop any golden true positive in any measured PR 0 run.
2. **One defect, many golden entries.** The golden set lists some defects once for each caller location.
   Talyn reports one root cause once, on purpose. Four high-severity misses in dev PR 3 are of this type.
3. **Low-severity golden findings.** Dev PRs 0–9 have 63 low, 60 medium and 24 high golden true positives.
   Many low findings are about maintenance, tests or docs. The product does not show these on purpose.
   We did not lower the reporting bar to get them.
4. **Inherited false-positive labels.** A finding that matches a rejected golden finding counts as a false positive.
   On PR 0, both kept findings matched generic golden warnings that experts rejected.
   Our findings gave a more specific runtime claim, but the score cannot see that difference.

## Prompt experiments

Dev set: test indices 0–9 (24 high-severity golden true positives).
Held-out set: indices 10–24 (12 high-severity golden true positives).
No prompt contains a benchmark repository, file or golden example.

| Variant | Change | Dev high P / R / F1 | Findings | Result |
| --- | --- | --- | --- | --- |
| Baseline | Production prompts | 100% / 45.8% / 62.9% | 70 | — |
| Coverage | Inspect each change, its callers and tests | 100% / 45.8% / 62.9% | 76 | More noise, no gain |
| Context | Read manifests, config and contracts first | 100% / 41.7% / 58.8% | 73 | Recall fell |
| Counterexample | Try to falsify each assumption with a real input | 100% / 50.0% / 66.7% | 72 | Dev gain |
| + Workflows | Sweep looks for a second defect in each reviewed workflow | 100% / 54.2% / 70.3% | 80 | Dev gain |

The best dev variant did not generalize:

| Set | Baseline high P / R / F1 | Best variant high P / R / F1 |
| --- | --- | --- |
| Held-out (15 PRs) | 100% / 58.3% / 73.7% | 100% / 41.7% / 58.8% |
| All 25 PRs | 100% / 50.0% / 66.7% | 100% / 50.0% / 66.7% |

On all 25 PRs the variant adds 10 findings and lowers all-severity grounded precision from 91.2% to 88.5%.
Thus we kept the production prompts. The variant diff is in `experiments/counterexample-workflows.diff` for a later, larger test.
With 36 high-severity golden findings, one finding moves F1 by about 2 points. A real gain needs repeated runs or the full 219-PR corpus.

## Next steps

- Run Deep on the test set. The chunked judge prompt describes only the first chunk. Test whether this costs recall.
- Run the full corpus (`--set full`) or repeat the 25-PR run three times before a prompt change goes to production.
- Submit through the ReviewBench portal for an official score. Replace the image digest in `manifest.json` first.
