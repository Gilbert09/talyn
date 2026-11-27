# Review quality results

## Golden-case runs against PostHog Review (2026-11-27)

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

### Results

Recall of the golden problems, before and after the judge. Claude Opus 5.5 ran every unit. One row is one run.

PostHog/posthog#143292, 18 golden problems (`golden/posthog-143292.json`):

| Variant | Before judge | After judge |
| --- | --- | --- |
| Production prompts | 28% | 6% |
| Parts, generalist, new bar, refute-first judge | 56% | 56% |
| + rules step | 50%, 50% | 50%, 44% |
| + how-to-review method, consequence rule for the judge | 67%, 56% | 61%, 50% |
| + rules lens | 72%, 61% | 67%, 61% |
| + rule severity follows consequence, judge groups duplicates | 67% | 67% |

PostHog/posthog#139627, 13 golden problems, held out (`golden/posthog-139627.json`):

| Variant | Before judge | After judge |
| --- | --- | --- |
| Production prompts | 46%, 31% | 15%, 8% |
| Final prompts | 31%, 38%, 38% | 31%, 23%, (judge output did not parse) |

On both pull requests the old judge removed most of the real problems, and the new one keeps them.
On #143292 discovery also more than doubled. On the held-out #139627 it did not change: the misses there are memory-accounting bugs in Rust that no lens hunted for.
Each pull request ran only 1 to 3 times per variant, and one finding moves recall by 6 to 8 points.
The golden sets come mostly from other bots, so they favor what those bots find.
The id-only judge output came after the last runs. Unit tests cover it, but no eval run measured it.

A Standard review of a large change now runs about 12 units instead of 5.
On #143292 that was about $10.70 of model usage per review with Opus, against $3.41 before. On #139627 it was $9.29 against $3.56.

## Summary

Talyn's Standard review scores near the middle of the ReviewBench leaderboard on the 25-PR test set.
The production prompts are unchanged.

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
