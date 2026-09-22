# Repository history experiment — 21 September 2026

The larger replay shows a useful signal in long queues. It does not establish a production improvement.
More history alone does not consistently improve the model.
The next candidate combines a shared model with a fallback selected from earlier personal results.

**Qualification added on 22 September:** a live direct request remained active after three comment-only reviews, without another recorded request.
The replay below ends a request after every submission. That rule does not reproduce all GitHub request states.
These figures remain reproducible under that restricted policy, but cannot establish complete production candidate coverage.
Future promotion must use observed queues. Do not interpret these figures as verified gains on the complete pending queue.

## Data and checks

The collector enumerated PRs without selecting them through reviewer searches.
The fixed period runs from 25 March through 21 September 2026, exclusive of the end.
It collected 51,765 PR histories, 150,309 review records, and 166,455 timeline events from one repository.
All review and filtered timeline connections were paginated.

Twenty inconsistent histories received a separate read. Three retained uncertain lifecycle state.
The replay excludes a whole decision if any pending candidate has uncertain eligibility.
All title histories passed the consistency check. The local encoder produced 56,092 distinct title vectors.
Verified rename events reconstruct earlier titles. Current bodies and diffs cannot enter earlier examples.

Thirty sampled queues matched a separate reconstruction from raw events.
Thirty sampled PR histories also matched fresh, separate API reads before the fixed cutoff.
Half of that API sample had an unfulfilled direct request.
These checks verify source handling. They cannot recover deleted records or establish what a human saw.

The primary replay contains 3,647 choices from 95 reviewers. Of these, 2,349 have more than three candidates.
Most submitted review records cannot supply a new direct-request choice.
The audit identifies 32,495 reviews after an earlier review and 25,729 without an earlier direct request.
Team requests remain outside this cohort. These exclusions are not evidence of 58,000 missing queue alternatives.

## Fixed comparison

Twelve candidates compare pooled and personal logistic models, boosted trees, and shared neural models.
Seven use 24 numeric features. Five add 15 features derived from historical titles and earlier completed reviews.
The shared networks have 32 hidden units. Title vectors have 384 values, but models receive derived similarities.
The personal prior scales with reviewer count and each reviewer's training examples.

Four successive evaluation windows each span 14 days. Their preceding selection windows also span 14 days.
Training expands from a common start after a 30-day history period.
Labels must finish inside their assigned window. No model refits on selection data.
Selection uses equal-reviewer Hit@3 on queues larger than three. Request recency wins all four baseline selections.

The combined evaluation has 997 informative choices from 32 reviewers. The largest reviewer supplies 17.4% of choices.
All percentages below exclude queues with three or fewer candidates.

| Policy | Hits | Decision-average Hit@3 | Reviewer-average Hit@3 |
|---|---:|---:|---:|
| Newest request first | 658 / 997 | 66.00% | 82.47% |
| Model selected on each earlier window | 719 / 997 | 72.12% | 83.20% |
| Exploratory personal fallback | 678 / 997 | 68.00% | 83.06% |

The selected models gain 116 hits and lose 55 against recency.
The primary reviewer-average gain is 0.73 percentage points. Its descriptive 95% interval spans −3.60 to +4.29 points.
The interval resamples reviewers, then weeks within reviewers. It does not fully model dependencies between reviewers of the same PR.

| Queue size | Model hits | Recency hits | Decision-average gain |
|---|---:|---:|---:|
| 4–5 | 182 / 193 | 183 / 193 | −0.52 points |
| 6–10 | 260 / 325 | 248 / 325 | +3.69 points |
| 11+ | 277 / 479 | 227 / 479 | +10.44 points |

The focus reviewer scores 22 / 29 with selected models and 26 / 29 with request recency.
Creation recency and one title model each score 27 / 29 as exploratory comparisons.
This sample has only three recency misses. A large model cannot justify a personal improvement from this evidence.

The separate submission-time reconstruction yields 1,032 informative choices.
Selected models score 70.64%, compared with 65.70% for recency by decision count.
Its reviewer-average gain is 0.16 points, with a descriptive interval from −4.03 to +4.09 points.
The direction of the decision-average gain survives this timing change. The primary uncertainty remains.

## Further iteration: personal fallback

This policy was proposed after inspecting the comparison above. It is exploratory.
Each window retains its original selected model and baseline.
A reviewer receives learned scores only with at least 20 informative choices in the earlier selection window.
The model must also beat that reviewer's baseline Hit@3 in that earlier window.
Other reviewers receive baseline scores. These are heuristic requirements, not a statistical confidence gate.

The policy retains 31 gains and 11 losses, for 20 extra hits.
Its reviewer-average gain is 0.59 points, with a descriptive interval from +0.04 to +1.35 points.
The focus reviewer retains 26 / 29. Learned scores apply to 305 of 1,312 total evaluation choices.
Under submission timing, the policy retains 24 extra hits across 1,032 informative choices.
Its reviewer-average gain is 0.75 points, with a descriptive interval from +0.06 to +1.57 points.

These positive lower bounds do not establish confirmation. The policy came after the original result was visible.
Global model selection and personal screening also share a validation window.
All eight selected model fits reproduced their original validation and evaluation metrics exactly.
The fallback is a candidate to freeze for future evaluation. Production promotion remains disabled.

## Do we need much more data?

We need more useful decisions and better context. Raw PR volume is a poor measure of either.
The label learning curves keep the training period fixed and retain every training reviewer.
They compare one quarter, one half, and all labels on earlier selection windows only.
More labels improve reviewer-average Hit@3 by 0.53–1.50 points in three windows, but reduce it by 4.43 in one.
Longer history also gives mixed results. One seed and four windows cannot establish a scaling law.

Historical title features give modest, model-dependent gains. Larger neural models are not yet the clear next step.
The immediate work is to collect actual queues, exposure, request rounds, readiness, and content revisions before decisions.
Keep in-app opens and submitted reviews separate. Do not label every unseen PR as rejected.
Sample long queues and multiple reviewers. Retain reviewer-level fallbacks when evidence is weak.

Freeze the model families, selection rule, feature timing, and fallback before a future trial.
Compare against request recency, creation recency, and the complete production order on the same observed queues.
Use a separate personal validation period before the final period.
Require the existing five-point target, a positive paired bound, and acceptable reviewer results before promotion.
Use the existing local export and outcome pipeline to collect this evidence.

The historical cohort still differs from production eligibility and readiness gates.
In particular, production checks can suppress previously reviewed PRs, while this replay retains later request rounds.
Resolve that parity before attributing offline gains to the displayed product order.
These results predict which PR is reviewed next. They do not show that changing the order causes more reviews.

## Reproduction and artifacts

The [protocol](2026-09-21-repository-protocol.json) records the fixed initial comparison.
The [creation-time result](2026-09-21-repository-created.json) and [submission-time result](2026-09-21-repository-submitted.json) contain aggregate metrics.
They include source hashes, implementation hashes, dependency versions, learning curves, and the supplementary fallback results.
They contain no PR identities, titles, repository names, or reviewer logins.
Raw histories, vectors, API audits, and full reports remain in ignored local artifacts.
The [lab README](../README.md) gives collection, encoding, replay, and fallback commands.

Validation passed 94 focused tests, Ruff checks, and formatting checks.
The real-data runs tested all twelve candidates under both timing policies.
No production ranking code or stored production model changed.
