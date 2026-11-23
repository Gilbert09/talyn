# ReviewBench results (2026-11-13)

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
