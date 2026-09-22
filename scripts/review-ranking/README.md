# Review ranking lab

This package runs local ranking experiments and validates prospective exports.
Training stays local and installs no production model.

Historical replay ends a request after every submitted review. A live audit found that comment-only reviews can leave requests active.
Treat that replay as a restricted-policy experiment. Use observed queues for promotion evidence.
The outcome and content collectors use read-only GitHub requests through the existing `gh` login.
The optional encoder downloads public weights only when requested. PR content is encoded on this machine.
See [`docs/REVIEW_RANKING.md`](../../docs/REVIEW_RANKING.md) for results and release gates.

## Setup and checks

Use Python 3.12 and `uv`. The committed lock fixes dependency versions.
CI uses uv 0.2.37, which generated this lock.

```sh
cd scripts/review-ranking
uv sync --frozen --python 3.12
uv run --frozen ruff check .
uv run --frozen ruff format --check .
uv run --frozen pytest -q
```

Tests use synthetic data. They need no GitHub token or private history.
The lab includes actual training checks for each model family.
Use `uv sync --frozen --extra encoder` to install the optional encoder and run its tests.
Pass `--extra encoder` to `uv run` for those checks too. CI tests this extra without downloading weights.

## Repository-wide historical experiment

Use this collector for new historical work. The older spike cache remains a development reference.
Select the repository and dates before collection. Keep them fixed throughout model comparison.

```sh
uv run --frozen python -m review_rank.history \
  --repo OWNER/REPOSITORY \
  --start 2026-03-25T00:00:00Z --end 2026-09-21T00:00:00Z \
  --cache artifacts/repository-history-cache \
  --output artifacts/repository-history.json
uv run --frozen python -m review_rank.history_audit \
  --history artifacts/repository-history.json --output artifacts/history-audit.json
uv run --frozen --extra encoder python -m review_rank.history_encode \
  --history artifacts/repository-history.json --output artifacts/title-vectors.json
uv run --frozen python -m review_rank.rolling \
  --history artifacts/repository-history.json --embeddings artifacts/title-vectors.json \
  --output artifacts/rolling.json
```

The encoder uses the fixed MiniLM cache. Add `--download-model` to permit the first public weight download.
Later runs use the local cache. Private text is encoded locally.
Omit `--embeddings` to compare numeric models alone.
Use `--decision-time submitted` for a separate timing sensitivity check.

The collector enumerates every PR in creation order until the fixed end date.
It fetches histories for PRs updated since the start, plus older PRs that remain open.
This includes requests that were later removed without a review.
It does not select PRs through reviewer searches or use a search-result cap.
Four concurrent read requests keep collection bounded. Raw responses stay in a resumable private cache.
Request limits and a rate reserve stop collection before a complete output is written.
Resume with the same dates and cache after a transient failure or rate reset.

Review lists and filtered timeline lists are fully paginated.
The timeline uses `filteredCount`; GitHub's `totalCount` includes excluded event types.
History is checked against the current title, draft state, and closure state.
Inconsistent records receive one separate read. Remaining gaps stay explicit in the output.
Complete pagination does not imply complete historical truth. Deleted records and access gaps remain unknown.

The replay includes every observed direct human request in the repository.
It applies removals, submissions, closures, reopen events, and draft transitions.
A decision with uncertain candidate state is excluded as a whole.
The selected PR never bypasses eligibility. Team membership remains outside this historical cohort.
Features count completed review activity only from the fixed collection start.
The first 30 days supply history before model training starts.

The default decision timestamp is the review's `createdAt`.
A recorded earlier creation time can exclude requests that arrived during the review.
It remains an approximation of the human's decision time.
An outcome must finish inside its assigned window before the decision can enter training or evaluation.
Invalid start timestamps remain audited. They cannot supply a choice under the creation-time policy.
Their valid submissions still update earlier review activity.

Title changes reconstruct the text available before each decision.
The encoder runs locally and caches vectors by text hash and encoder version.
Unverified title histories supply missing values. They do not remove candidates.
Content features compare the candidate with the reviewer's last 20 completed reviews.
They include title similarity, scope overlap, change type, and missing-value indicators.
PR bodies, file paths, and diffs do not enter this historical experiment.

Four successive comparisons each use a 14-day selection window and a 14-day evaluation window.
Training expands from the same fixed start. All models receive the same eligible decisions.
The fixed comparison includes pooled and personal logistic models, boosted trees, and shared neural models.
One personal model scales its prior by reviewer count and each reviewer's available training decisions.
Adding reviewers therefore does not automatically suppress every personal adjustment.
This model remains an offline candidate. It does not replace the prospective pipeline's separate personal validation gate.
Numeric and title models remain separate candidates. Selection uses reviewer-average Hit@3 on queues larger than three.
Models do not refit on selection data, so training budgets remain equal.

Reports include reviewer and decision averages, sample counts, queue sizes, gains, losses, and paired intervals.
Learning curves compare one quarter, one half, and all available training history on the same selection window.
Separate curves sample labels within the full training window, while retaining every training reviewer.
This helps separate label volume from the age of the training data.
A shuffled-label control helps diagnose accidental shortcuts. It is not a proof that all leakage is absent.
The independent audit reconstructs up to 30 queues from raw events through a separate implementation.
It checks API records, not the queue that a human actually saw.
All historical comparisons remain development evidence. Production promotion stays disabled.

The [21 September report](results/2026-09-21-repository.md) records the larger replay and its limits.
It also tests an exploratory fallback after the original model comparison.
This command refits the selected models and requires exact metric reproduction before testing the fallback:

```sh
uv run --frozen python -m review_rank.fallback \
  --history artifacts/repository-history.json --embeddings artifacts/title-vectors.json \
  --report artifacts/rolling.json --output artifacts/fallback.json
```

The fallback requires 20 informative earlier choices and a positive personal Hit@3 difference.
It uses the selected baseline elsewhere. These requirements are heuristic and need a separate future trial.
The earlier selection window supplies all routing decisions. Evaluation labels cannot select a reviewer's policy.

## Production score replay

Build the shared package from the repository root before running the check:

```sh
npm run build --workspace=@talyn/shared
cd scripts/review-ranking
uv run --frozen python -m review_rank.parity \
  --export artifacts/queue.json --output artifacts/production-parity.json
```

New snapshots carry exact server or client scoring traces.
The command invokes the compiled serving scorer and checks the recorded score and gate for every candidate.
Priority snapshots also check the complete displayed order, including ties.
Other sort modes check scores only. Unsupported versions and missing traces fail explicitly.
The output records the scorer version and a digest of its compiled code.
Passing replay does not authorize promotion or establish candidate completeness.
Older stored statistics can have fewer fields than the current features.
Production skips the learned term in that case. Replay preserves this fallback and still checks every recorded score.

New snapshots also record the workspace's repository scope.
The outcome join excludes snapshots whose scope does not match the frozen protocol, including older snapshots without scope.
Pass `--exclude-snapshots artifacts/exclusions.json` to `review_rank.outcomes join` to exclude agent-operated checks.
That private file must contain an `excluded_snapshot_ids` list.
An excluded snapshot still censors earlier observations. Its review cannot become an older snapshot's positive label.

## Historical comparison

The existing spike cache supplies raw timeline responses and its dataset manifest.
Keep that cache private. The maintained loader does not need the spike's model code.

```sh
uv run --frozen python -m review_rank.benchmark \
  --dataset ../spikes/review-rank-lab/cache/dataset.json \
  --cache ../spikes/review-rank-lab/cache \
  --output artifacts/benchmark.json
```

The run uses the manifest's fixed collection time and seed 71.
The report contains code and data hashes, dependency versions, cutoffs, audits, and model configurations.
It also contains both reviewer-weighted and event-weighted results.
The saved [`results/2026-09-21.json`](results/2026-09-21.json) contains aggregate results with anonymous reviewer labels.
It contains no raw PR records, repository names, or reviewer logins.

The loader restricts eligibility to observed direct requests.
It excludes connections with twenty or more items because their pagination status is unknown.
Missing request removals, reopen events, and historical candidates still limit the benchmark.
Every report explicitly refuses promotion from this development data.

## Prospective export validation

Open Reviews in an account with `reviewPriority` enabled.
Use **Export ranking data** to download the local record.
Keep exports in the ignored `artifacts` directory.

```sh
uv run --frozen python -m review_rank.snapshots artifacts/talyn-review-ranking.json
```

The command prints aggregate completeness counts. It never uploads the export.
It reassembles queue chunks and rejects incomplete or conflicting snapshots.
It keeps visible impressions and opens separate from eligibility.
It does not infer submitted reviews from clicks.

Each export has `schema_version: 1` and an `events` array.
Queue events carry a workspace, reviewer, snapshot ID, timestamp, model data, and candidate chunks.
Exposure and open events reference that snapshot ID and an observation timestamp.
The client logs changed queues and refreshes stable queues every five visible minutes.
The IndexedDB archive retains up to 30 days and 50 million serialized characters per workspace.
The original seven-day localStorage log remains a fallback. Exports merge both sources.
Archive availability and loss counters remain visible in the import audit.
New candidates record `requested_teams` from the displayed summary, with normalized team names and a matching count.
An empty list means no matched team. Missing or null data remains unknown.
Exports contain these names and must remain private. They do not establish an exact request round.
The archive can still lose history through retention limits, browser quotas, or device failures. Export regularly.

The checker alone reports zero review labels. The following pipeline adds submitted-review outcomes.

## Collect and join outcomes

Create `artifacts/protocol.json` before the pilot. Use the full repository scope of the unfiltered Reviews queue.
Keep that scope fixed during collection. Each reviewer needs a protocol and a journal.
The example dates are placeholders. Replace them before collection, then keep the file unchanged.

```json
{
  "schema_version": 1,
  "workspace": "workspace-id-from-export",
  "reviewer": "github-login",
  "repos": ["owner/repository"],
  "start": "2026-10-01T00:00:00Z",
  "end": "2026-12-01T00:00:00Z",
  "horizon_seconds": 86400,
  "decision_time": "created"
}
```

Export local snapshots regularly. After the protocol ends, collect outcomes and join all exports:

```sh
uv run --frozen python -m review_rank.outcomes collect \
  --protocol artifacts/protocol.json --max-requests 2000 \
  --output artifacts/outcomes.json
uv run --frozen python -m review_rank.outcomes join \
  --protocol artifacts/protocol.json --journal artifacts/outcomes.json \
  --exports artifacts/export-01.json artifacts/export-02.json \
  --output artifacts/joined.json
```

The collector enumerates all PRs created before the end date, then paginates each scoped review list.
It includes submitted reviews on PRs absent from the queue. Dismissed reviews still count as submitted reviews.
The default GraphQL collector batches 50 PRs and filters each review connection by the protocol reviewer.
It checks review identities, parent PRs, counts, pagination cursors, and both timestamps.
Use `--transport rest` for an independent comparison through the original collector.
That path reads every PR's reviews, then binds GraphQL creation times to REST review identities.
Visible pending reviews and reviews submitted after the window remain censoring evidence.
This can require many requests on large repositories. A budget limit or API error stops the collection.
It writes no journal on failure. Increase the explicit budget and retry when appropriate.
It does not use GitHub search, which would impose a result limit.
Creation order prevents new review activity from moving PRs between pages.
Deleted records and API access gaps remain limits. GitHub does not provide a transactional snapshot.

The primary join uses the latest snapshot strictly before review creation, within 24 hours.
Creation time is a proxy for the decision. It does not record when the human opened the PR.
Set `decision_time` to `submitted` in a separate frozen protocol for a timing sensitivity comparison.
The journal must match that protocol. Older journals without creation times must be collected again.
Each snapshot labels its next review only. Later reviews need a fresh snapshot.
An unfinished first review prevents a later completion from becoming that snapshot's ranking label.
Duplicate review IDs are removed. Conflicting records stop the join.
Filtered queues, ambiguous timestamps, missing candidates, and expired windows remain visible in the audit.
They never become forced positive examples. Unknown request rounds remain unknown.
Submitted-review conversion is separate from the ranking label.
A review already started can still complete after a snapshot, without supplying a new ranking choice.
A negative conversion needs a closed 24-hour window and no newer snapshot.
Other unfinished sessions remain censored. Clicks do not supply review labels.
Snapshot repository scope must match the protocol. Older exports without scope cannot supply labels.

## Observe content and encode it locally

Run content capture during the pilot. Capture again when PR revisions change.
It reads the current title, description, filenames, and available patches for exported candidates.
The collector verifies the head revision, base revision, update time, and file count around the read.
It refuses changed revisions and incomplete file lists. GitHub can omit or shorten individual patches.
The content is therefore a representation of available text, not a guaranteed complete diff.

```sh
uv run --frozen python -m review_rank.content \
  --export artifacts/export-01.json --output artifacts/content-01.json
uv run --frozen --extra encoder python -m review_rank.encoder \
  --content artifacts/content-01.json --download-model \
  --output artifacts/embeddings.json
```

Later encoding runs can omit `--download-model` and use the local cache.
The encoder uses MiniLM at a fixed commit, with ONNX CPU inference and no remote Python code.
Each vector has 384 values. The output records model hashes, pooling, and truncation counts.
It encodes up to sixteen chunks of 254 content tokens, with two special tokens per chunk.
It averages tokens within chunks, then averages chunks and normalizes the result.
This is a compact text baseline. It is not a code-specialized model or proof of ranking quality.
See the [model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2).

Content captured today cannot supply features for yesterday's queue.
The feature builder requires a matching head revision and an observation time at or before the snapshot.
Use the app after capture, then export again to obtain eligible later snapshots.
Missing content has explicit indicators. Recent content uses only reviews submitted before the current snapshot.
All exports, content, vectors, journals, and models remain private files under `artifacts`.
Output files use mode `0600` and refuse replacement. Their parent directories must also remain private.

## Shared model and personal adjustments

Freeze four window ends before examining results: training, shared selection, personal validation, and test.
Use one complete journal per reviewer that covers the full test period.
Pool reviewers from one workspace only. Cross-workspace pooling needs a separate data policy.

```sh
uv run --frozen python -m review_rank.experiment \
  --joined artifacts/joined.json --embeddings artifacts/embeddings.json \
  --train-end 2026-11-01T00:00:00Z --tune-end 2026-11-11T00:00:00Z \
  --personal-end 2026-11-21T00:00:00Z --test-end 2026-12-01T00:00:00Z \
  --output artifacts/experiment.json --model-output artifacts/model.json
```

The dates illustrate the command. Set pilot windows from observed volume before model selection.
Each window needs ten decisions and at least one queue larger than three.
These minimums prevent empty comparisons. They do not establish statistical power.
Decisions whose review crosses a window boundary are excluded.
Omit `--embeddings` to test observed numeric features alone.

The experiment compares pooled logistic models and a shared neural network.
The network combines each candidate with the mean features of its full queue.
A sixteen-unit hidden layer learns interactions. A listwise loss trains against the chosen PR.
Candidate permutation changes only the score order. There are no position features in the model.
Training gives equal total weight to each reviewer.

The shared model stays fixed after selection. Personal linear adjustments fit its remaining errors.
They have strong regularization and scale by `n / (n + 50)`.
A reviewer needs twenty training choices and twenty informative validation choices across two calendar weeks.
The lower bootstrap bound for validation Hit@3 gain must exceed zero before their adjustment turns on.
Other reviewers receive the exact shared score. The final test cannot enable adjustments.
These are experimental safeguards, not a guarantee of generalization.

All comparisons preserve observed readiness gates. Raw recency baselines are also reported.
The report includes actual displayed order, team requests, returning reviews, long queues, and unseen reviewers.
Displayed order can come from different sort modes. The priority-sort subset is reported separately.
The experiment does not reproduce backend score caps or guarantee production parity.
Both the report and JSON model explicitly refuse production promotion.

## Model boundaries

Training uses full choice groups and balances reviewer contributions.
The conditional logit adds optional personal coefficients with stronger regularization.
LightGBM and CatBoost use shallow trees and a fixed, small configuration grid.
Select by validation Hit@3 for queues larger than three.
Report all families, but do not choose another winner after inspecting replay results.

The deployment path is separate work.
It needs a versioned model artifact, score parity checks, and evaluation of the final production order.
Python and its model libraries remain outside the app's runtime dependencies.
