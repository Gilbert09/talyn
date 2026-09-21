# Review ranking lab

This package runs local ranking experiments and validates prospective exports.
It makes no network calls and installs no production model.
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
The storage cap and seven-day window can remove history. Export before that history expires.

Review labels require a separate, complete outcome journal.
The current importer deliberately reports zero review labels.
The research document specifies attribution, coverage, delayed outcomes, and the next evaluation gate.

## Model boundaries

Training uses full choice groups and balances reviewer contributions.
The conditional logit adds optional personal coefficients with stronger regularization.
LightGBM and CatBoost use shallow trees and a fixed, small configuration grid.
Select by validation Hit@3 for queues larger than three.
Report all families, but do not choose another winner after inspecting replay results.

The deployment path is separate work.
It needs a versioned model artifact, score parity checks, and evaluation of the final production order.
Python and its model libraries remain outside the app's runtime dependencies.
