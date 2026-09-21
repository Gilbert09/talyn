# Review ranking: experiments and release gates

Updated: 2026-09-21.

**The first pooled-model comparison is complete. No new model qualifies for production.**
CatBoost won validation, then tied request recency on the later replay.
The corrected dataset is much narrower than the original dataset.
Its higher scores do not show a product improvement.

The maintained lab lives in [`scripts/review-ranking`](../scripts/review-ranking/README.md).
The [saved report](../scripts/review-ranking/results/2026-09-21.json) records cutoffs, versions, data hashes, and all results.
The private GitHub cache stays outside version control.

## Objective

`Hit@3` asks whether the next reviewed PR appears among the first three candidates.
Each decision has one observed choice. This differs from getting all three suggestions reviewed.
It also differs from causing more reviews or improving review quality.

Use equal weight per reviewer for the main offline comparison.
Report equal-event results, Hit@1, MRR, and NDCG@3 alongside it.
Select configurations on queues with more than three candidates.
Smaller queues cannot distinguish top-three performance.
Also report the complete cohort, queue sizes, and excluded events.

For a later product experiment, measure useful completed reviews per active session.
Include sessions without reviews. Also measure selection time and reviews within 24 hours of a recommendation.
Keep urgent work, long waits, and review quality as separate constraints.
Historical choice prediction alone cannot justify changing those constraints.

## Corrections to the original experiment

The original spike reported these figures:

| Method | Historical Hit@3 |
| --- | ---: |
| Best logistic configuration | 53.4% |
| Most recently requested first | 51.9% |
| Fitted production feature set | 30.8% |
| Production prior | 24.1% |

These figures describe the old reconstruction. They are not validated production results.
The fitted component did not include the complete production gates, adjustments, or score cap.
The best model exceeded the fitted feature set by 22.6 points, and the prior by 29.3 points.

The old “perfect recency oracle” was another request-recency sort.
Its 50.4% used equal event weights. The 51.9% baseline used equal reviewer weights.
**Neither figure establishes a ceiling.**

The audit also found these problems:

- Twenty-six of 581 scored events stored a request after the first review.
- Selected PRs bypassed the eligibility test applied to alternatives.
- Features included later review counts, later requests, and mutable PR content.
- Training profiles included outcomes from later in the training window.
- Training truncated queues to ten candidates, while evaluation used full queues.
- Team requests lacked historical membership checks.
- Connections stopped at twenty items without completeness guarantees.
- Ties could favour the selected PR through input order.
- Reruns moved the time windows because scripts used the current clock.

Reviewing another PR is not proof that a pending PR was seen or rejected.
The maintained feature therefore counts intervening reviews, without calling them explicit skips.
An age preference can serve a waiting-time policy even when it predicts habits poorly.
This experiment does not establish that the production age ramp has the wrong sign.

## Maintained benchmark

The new loader uses observed direct requests from cached GitHub timeline responses.
It reconstructs request rounds and features strictly before each review timestamp.
It applies the same eligibility rules to the selected PR and every alternative.
It excludes uncertain team membership and possibly truncated connections.
It does not substitute PR creation time for missing request times.

All eligible candidates enter training and evaluation.
Features use earlier activity, request recency, author relationships, and review rounds.
Current titles, file paths, diff sizes, and live checks are excluded from historical features.
Ties receive their exact expected score, independent of label position.
The random baseline uses the mean of `min(3 / queue_size, 1)`.

The frozen endpoint is `2026-09-21T11:14:46.916Z`.
Training covers the preceding 180 to 60 days.
Validation covers the following 30 days. Replay covers the final 30 days.
This final month was already inspected during research, so it is development evidence.
It is not an untouched test period.

The loader sees 7,919 legacy rows and excludes 319 potentially truncated histories.
It records 6,034 rows without a confirmed direct request.
There are 739 reconstructed choices across the full cache.
The configured windows contain 442 training, 90 validation, and 141 replay choices.
Only 59 validation choices and 107 replay choices have more than three candidates.
A few reviewers supply most of the informative decisions.

Nine configurations compare four model families:

1. Pooled conditional logistic regression with full-choice softmax loss.
2. The same model with strongly regularized personal coefficients.
3. LightGBM LambdaMART with shallow trees and a training cutoff of six.
4. CatBoost YetiRank with NDCG@3 as its training objective.

Each family selects its configuration on validation Hit@3.
The overall candidate is also selected before replay scoring.
The report includes validation feature ablations and validation with each reviewer excluded from training.
These ablations are diagnostic. They do not select another replay winner.

## First results

The table uses equal reviewer weights and queues with more than three candidates.
All rows use the same 107 replay decisions.

| Method | Hit@3 |
| --- | ---: |
| Newest request first | **85.53%** |
| Newest PR creation first | 68.46% |
| Uniform random expectation | 60.18% |
| Oldest request first | 46.11% |
| Pooled logistic regression | 87.91% |
| Logistic regression with personal coefficients | 60.75% |
| LightGBM LambdaMART | 77.52% |
| **Validation-selected CatBoost** | **85.53%** |

CatBoost used depth three and 150 trees.
Its paired difference from request recency is zero points.
The descriptive 95% interval spans approximately −0.44 to +0.69 percentage points.
The calculation resamples reviewers, then week blocks within each reviewer.
Repeated PRs can still create dependence across blocks. The small reviewer cohort limits interpretation.

Pooled logistic regression is 2.38 points ahead on this replay.
Selecting it after seeing that result would require another future evaluation.
The report therefore sets `promotion.allowed` to `false`.

All-queue results appear in the report. They must not replace the selected metric after inspection.
Small queues and different reviewer weights can change which method appears best.
The high random score shows how different this cohort is from the original benchmark.

Request removals, reopen events, and historical alternatives remain incomplete.
Review submission time also follows the actual choice, sometimes by hours.
A stricter reconstruction reduces some errors; it does not recover missing history.

## Prospective collection

Web and desktop record local snapshots while the Reviews panel is visible.
Collection uses the existing `reviewPriority` audience, which currently contains Tom only.
It covers creation-newest, creation-oldest, and Priority sorts within that audience.

Each snapshot contains the full displayed queue, including rows outside the viewport.
It records candidate IDs, order, numeric features, readiness state, head revision, and observation times.
Separate events record visible rows and in-app opens.
A queue entry does not imply exposure. An open does not imply a submitted review.

Chunks contain at most 25 candidates. Each chunk carries the total count and a snapshot ID.
The importer rejects incomplete chunks, conflicting headers, duplicate PRs, and invalid ranks.
It checks exposure timestamps and candidate membership separately.

New snapshots record the exact scoring trace, including its server or client source.
Server traces include a profile hash, so a stale client profile cannot replace the actual scoring inputs.
Older snapshots retain their `client_profile` label and cannot pass exact replay without a trace.
`request_first_seen_at` is an observation time, not an authoritative GitHub request timestamp.

New records stay in local storage on the device.
The **Export ranking data** button downloads them as JSON.
No new snapshot event is sent to PostHog or another service.
Raw titles, descriptions, code, author names, paths, and search text are omitted.
Exports still contain reviewer login, repository names, and PR identifiers. Keep them private.

An IndexedDB archive retains up to 30 days and 50 million serialized characters per workspace.
Transactions keep each snapshot and its size metadata together. Concurrent tabs cannot overwrite each other's events.
Retention removes whole snapshot groups, including their observations. Old bytes can remain until the next write.
The original seven-day, one-million-character log remains a fallback when archive storage fails.
Exports merge both stores and report archive availability, eviction counts, and write failures in the current app session.
Clearing site storage removes both stores. Browser quotas and device failures can still lose data.
Export regularly during the pilot. The archive has no network path.

Current limits include external-link opens and authoritative request rounds.
The snapshot checker reports `review_labels: 0`; the separate outcome join supplies submitted-review labels.

## Shared model and outcome pipeline (2026-09-21)

The lab now has an executable pipeline for prospective data.
See the [lab commands](../scripts/review-ranking/README.md) for protocol files and each collection step.

The outcome collector enumerates repository PRs and paginates every review list.
It includes reviews outside the displayed queue, then assigns each review to the latest earlier snapshot.
The fixed horizon is 24 hours. A snapshot supplies one next-review choice.
Filtered queues, ambiguous timestamps, missing candidates, and incomplete outcome windows cannot supply positive labels.
Session negatives require a closed horizon without a newer snapshot.
GitHub deletions, access gaps, and concurrent API changes still limit completeness.
The declared repository scope must match the unfiltered queue throughout the pilot.

Content capture stores current observations locally. It records both revisions and the observation time.
A fixed MiniLM encoder turns the available title, description, paths, and patches into 384-value vectors.
Inference runs locally through ONNX. No private text goes to an embedding service.
Features require a matching head revision and an earlier content observation.
Later content cannot fill a historical gap. Missing content remains explicit.
MiniLM is a compact text baseline; code-specialized encoders remain a later comparison.

The shared neural network uses candidate features and mean features from the complete queue.
It adds recent review activity, content similarity, size, readiness, and observed affinity features.
Its hidden layer has sixteen units. The loss balances reviewers and scores complete choice groups.
It has no candidate-position feature. Tests verify stable scores when candidates change order.

Personal adjustments fit residual errors while shared weights remain fixed.
Strong regularization and a sample-size factor limit their contribution.
An adjustment stays off unless a separate, earlier validation window supports a positive Hit@3 lower bound.
Unknown reviewers and reviewers without enough evidence use the shared score unchanged.

Four forward windows separate training, shared selection, personal validation, and the final development comparison.
The experiment compares the observed display order, pooled models, shared neural scores, and guarded personal scores.
It preserves observed readiness gates and also reports raw recency baselines.
Backend score limits and authoritative model versions still need a separate parity check.
The artifact and report both refuse production promotion.

Synthetic tests cover collection, attribution, feature timing, actual model fitting, and personal gating.
A local run verified the fixed encoder's 384-value output, unit norm, and identical repeated results.
These checks establish implementation behavior. They do not establish a gain on fresh human decisions.
Fresh local exports and closed outcome windows remain the next measurement requirement.

## Larger repository replay (2026-09-21)

The [experiment report](../scripts/review-ranking/results/2026-09-21-repository.md) records the new results and reproduction steps.
The collector now enumerates repository PRs without selecting them by review outcomes.
It collected 51,765 histories with complete review and filtered timeline pagination.
Thirty sampled queues matched a separate reconstruction. Thirty sampled histories matched fresh API reads.
Deleted records, access gaps, team membership, and human exposure remain unknown.

The replay supplies 3,647 usable choices from 95 reviewers, including 2,349 queues larger than three.
Twelve models compare numeric features and reconstructed historical titles across four successive time windows.
The personal prior now scales with each reviewer's training count and the number of reviewers.
This prevents a larger pool from automatically suppressing every personal adjustment.

The combined evaluation contains 997 informative choices from 32 reviewers.
Selected models score 719 hits, compared with 658 for request recency: 72.12% versus 66.00%.
Equal-reviewer Hit@3 rises from 82.47% to 83.20%. Its descriptive difference interval still includes zero.
Most gains come from queues with at least eleven PRs. The focus reviewer's result regresses from 26/29 to 22/29.

A further exploratory policy uses learned scores only where earlier personal results support them.
It retains 678 hits and preserves the focus reviewer's 26/29 result.
This policy came after the initial results were inspected. Its positive descriptive bound is not confirmation.
Both comparisons were repeated using submission timestamps. All eight selected model fits reproduced their original metrics exactly.

More training labels give mixed gains. Current evidence does not justify collecting raw history without a specific measurement goal.
Prioritize actual queues, readiness, authoritative request rounds, content revisions, and fresh human decisions.
Freeze the fallback policy for a future comparison against the complete production order.
Production ranking remains unchanged. Historical results cannot establish that changing the order causes more reviews.

## Production capture audit (2026-09-21)

A capture check on desktop 0.2.101 found 79 candidates in the focus reviewer's queue.
Seventy-seven had team requests. Two had direct requests.
The historical benchmark covered direct requests only. It therefore does not represent this live queue.
Three complete test snapshots contained 237 candidate rows and 36 viewport observations.
These were agent-operated checks. Their snapshot IDs are excluded from human outcome attribution.

The audit also found a scoring provenance gap.
Old snapshots recorded the client profile, while displayed scores could use a different cached server profile.
New verdicts carry the exact numeric inputs, feature statistics, effective weights, state, and scoring time.
Server traces include a profile hash. Local fallback traces identify their client source.
The trace omits author names, paths, team names, and PR text.
Unknown numeric features survive JSON as explicit null values and retain their original scoring behavior.

The parity command runs these inputs through the actual compiled production scorer.
It checks scores, readiness gates, and displayed Priority order, including creation-time and identity ties.
It records the scorer version and a digest of the compiled implementation.
Other display modes check scores only. Missing or unsupported traces fail the check.
This verifies replay; it cannot prove candidate completeness or ranking quality.

New snapshot headers record the full workspace repository scope.
Outcome attribution excludes snapshots with unknown or different scope.
Explicit exclusions, including agent checks, censor attribution instead of falling back to an older snapshot.
Existing exports remain readable, but missing provenance cannot qualify them for the new checks.

The archive now retains a longer local history, with explicit loss counters and a smaller fallback log.
Fresh human outcomes, authoritative request rounds, shadow evaluation, and controlled product evidence remain open release gates.
Production ranking behavior remains unchanged.

## Review timing and unfinished outcomes (2026-09-21)

The outcome collector now records review creation and submission separately.
GraphQL supplies creation time. Identity checks bind it to the REST review, reviewer, repository, and PR.
The primary join requires a queue snapshot before creation. Submission timing remains a separate protocol option.
Visible unfinished reviews and late submissions can censor a choice.
An unfinished first review cannot be replaced with a later completed review from the same snapshot.
Training inputs reject snapshots at or after the recorded decision time.

Submitted-review conversion remains a separate observation.
A review can finish after a snapshot even when its ranking decision occurred earlier.
That completion can count toward conversion, but cannot become a new ranking choice for that snapshot.
Negative conversion still requires a closed 24-hour window without a newer snapshot.

Creation time is an approximation. GitHub review objects can remain pending before submission.
Neither timestamp records the moment a human opened the PR. Pending-review visibility also depends on account access.
See the [GitHub review API](https://docs.github.com/en/rest/pulls/reviews#about-pull-request-reviews).

In the collected history, 6,082 of 146,508 valid submitted reviews had a delay longer than one minute.
For the focus reviewer, 38 of 3,440 exceeded one minute, and one exceeded an hour.
This is a real validation gap, but the observed delays do not explain the main queue mismatch.
Twenty records from a fresh API request matched the stored review identities and both timestamps exactly.

## Next experiment protocol

The following steps retain the agreed order. Unchecked work is not implemented yet.

- [x] Freeze the historical benchmark, audit eligibility, and test temporal features and ties.
- [x] Compare pooled logistic, personal logistic, LambdaMART, and CatBoost.
- [x] Test available activity features through separate validation ablations.
- [x] Add local snapshots, exposure observations, exports, and a completeness checker.
- [x] Build a scoped outcome collector and strict snapshot join.
- [x] Separate review creation, submission, unfinished outcomes, and session conversion.
- [x] Collect repository histories, reconstruct earlier titles, and compare twelve models across successive periods.
- [x] Check label-volume curves, submission-time sensitivity, and an exploratory fallback based on earlier personal results.
- [ ] Collect fresh exports and complete outcome journals for the pilot.
- [x] Record exact scoring inputs, server profile versions, and the workspace repository scope.
- [x] Add replay checks against the actual production scorer and Priority comparator.
- [ ] Record authoritative request rounds and historical content revisions.
- [ ] Evaluate ranking gains on fresh queues under the complete production ordering.
- [x] Add observed content vectors, recent review features, a shared neural model, and guarded personal adjustments.
- [ ] Measure these features on prospective data, then compare code-specialized encoders and attention models.
- [ ] Compare an offline LLM teacher against human outcomes.
- [ ] Run the selected model without changing displayed order, then run a controlled product experiment.

Before joining outcomes, freeze the repository scope, observation window, and label rules.
Fetch or record all submitted reviews in that scope, with pagination and completeness checks.
Fetching outcomes only for suggested candidates cannot establish the next review.
Deduplicate by GitHub review ID. Keep request rounds separate.
Use only snapshots recorded strictly before review creation, within a fixed 24-hour attribution window.
For each decision, use the latest eligible snapshot; do not duplicate one review across earlier snapshots.
Keep reviews outside the observed candidate set as coverage failures, not forced positives.
For session conversion, wait until the 24-hour outcome window closes before assigning a negative label.
Keep actual review-start observations separate from GitHub's creation-time approximation.

Use additional forward time windows for model development.
Then freeze the model, features, candidate policy, baselines, and an untouched future evaluation period.
Estimate sample needs from pilot variance and clustering before setting that period's length.
Report direct and team requests, long queues, returning rounds, and reviewers absent from training separately.
Do not pool raw private history across tenants without an agreed data policy.

The planning target remains **five absolute Hit@3 points above the strongest valid baseline**.
This is a release target, not a forecast.
Require a positive paired confidence bound and acceptable results across reviewers.
Also require evidence of useful product outcomes before changing the default order.
Keep the existing fallback for groups with insufficient evidence.

## Larger model direction

Build a model that represents the reviewer, recent work, code changes, and the whole queue.
Cache code representations by revision. Fit personal adjustments only where earlier data supports them.
Use a small model over candidate representations before increasing model size.

An LLM can extract structured features or supply teacher rankings for comparison.
Human review outcomes remain the evaluation labels.
Randomize candidate input order and test stability before distilling teacher predictions.
Measure API cost and latency before commissioning a larger teacher dataset.

Score the full eligible queue while it remains small enough.
A filter that keeps only recent requests imposes a coverage limit before ranking begins.
If retrieval becomes necessary, combine recency, relationships, active conversations, and dependencies.

Relevant primary sources:

- [Gmail Priority Inbox](https://research.google/pubs/the-learning-behind-gmail-priority-inbox/): shared and personal scores, with stored decision features.
- [LightGBM parameters](https://lightgbm.readthedocs.io/en/stable/Parameters.html#lambdarank_truncation_level): ranking objectives and training cutoff.
- [CatBoost ranking objectives](https://catboost.ai/docs/en/concepts/loss-functions-ranking): top-position ranking modes.
- [SASRec](https://arxiv.org/abs/1808.09781) and [SetRank](https://arxiv.org/abs/1912.05891): recent actions and candidate-set context.
- [CodeReviewer](https://arxiv.org/abs/2203.09095): representations trained on code changes and review tasks.
- [RankZephyr](https://arxiv.org/abs/2312.02724): an LLM ranking precedent, without evidence of transfer to personal PR choices.
- [Unbiased learning to rank](https://arxiv.org/abs/1608.04468): why displayed position and exposure affect observed feedback.

These sources motivate experiments. They do not establish an improvement for Talyn.
