# Incremental check counts from webhooks

**Status:** design / not yet implemented.

**Goal:** keep the PR pill's check **counts** (`total / passed / failed / inProgress / skipped`)
live from `check_run` / `check_suite` / `status` webhooks **without a GraphQL
`refreshPr` per event**, and **without bloating `pull_requests.lastSummary`
egress**. Full PR data (mergeable, reviews, authoritative blocking reason) is
fetched on demand when the detail overlay opens, and the 5-min reconcile sweep
remains the correctness backstop.

## Why

Today every check event on a tracked PR triggers `refreshPr` →
`batchPullRequestsByNumber` → GitHub's `statusCheckRollup`, which is ~1–2s for a
big PR (100+ contexts, `isRequired` branch-protection resolution). On a busy repo
the worker can't keep up. But a check event only changes **one check's state** —
recomputing the *counts* needs only the set of checks for the PR's head commit,
which we can maintain ourselves.

## Principles

- **The webhook is the source of truth for the fast path.** A `check_run` payload
  carries everything we need to update one check: `name`, `head_sha`, `status`,
  `conclusion`, `pull_requests[]`.
- **Counts ship; per-check rows never do.** Per-check state lives in a dedicated
  table, queried with a `GROUP BY` aggregate (~5 rows). The desktop only ever
  sees the small counts object (already in `lastSummary.checks`).
- **Approximate fast, exact slow.** Incremental updates the counts immediately;
  the sweep and the detail-overlay fetch reconcile to GitHub's authoritative
  rollup. Drift self-heals within 5 min.

## Data model — new table `pr_check_states`

Per-check state, keyed to a **GitHub repo + head commit** (workspace-independent —
checks belong to a commit, shared by every workspace tracking that PR).

| column        | type      | notes |
|---------------|-----------|-------|
| `id`          | text pk   | uuid |
| `repo_full_name` | text   | `owner/repo`, lowercased |
| `head_sha`    | text      | commit the check ran on |
| `name`        | text      | check/context name — the dedupe key (re-runs of a name supersede) |
| `source`      | text      | `check_run` \| `status` |
| `external_id` | text null | GitHub `check_run.id` / status context id (debug only) |
| `state`       | text      | normalized: `success` \| `failure` \| `pending` \| `skipped` (matches `normalizeCheckState`) |
| `updated_at`  | timestamptz |
| `created_at`  | timestamptz |

Indexes:
- `UNIQUE (repo_full_name, head_sha, name)` — one row per check name (re-runs
  upsert in place; the table is therefore *already* deduped, replacing
  `dedupeLatestCheckByName` at read time).
- `INDEX (repo_full_name, head_sha)` — drives the count aggregate.

Rows are tiny text records. **Nothing here is a jsonb blob and nothing here is
shipped to the desktop** — it's purely backend-derived state.

## Webhook update flow

On `check_run` (and later `status`):

1. Extract `{ repoFullName, headSha, name, state, externalId }`.
   `state = normalizeCheckState(status, conclusion)` (reuse the existing helper).
2. **Upsert** into `pr_check_states` on `(repo_full_name, head_sha, name)` —
   set `state`, `external_id`, `updated_at`. Last-writer-wins; out-of-order
   events are rare and the sweep corrects them.
3. For each PR in `check_run.pull_requests` that we **track** (reuse
   `filterTrackedOpenAcross`):
   - Resolve the PR's **current** `head_sha` from `lastSummary.headSha`.
   - **Only if `check_run.head_sha === current head_sha`** recompute (checks on a
     superseded sha — post-force-push — must not count, matching GitHub's rollup).
   - Recompute counts in SQL:
     `SELECT state, count(*) FROM pr_check_states WHERE repo_full_name=? AND head_sha=? GROUP BY state`
     → `{ total, passed, failed, inProgress, skipped }`.
   - Write each tracked workspace row with `jsonb_set(last_summary, '{checks}', …)`
     (no need to read the blob back), bump `last_check_digest`, and
     `emitPullRequestUpdated` with the new counts (existing small public shape).

`check_suite/completed` is a checkpoint signal — optionally trigger a recount /
log a diff, but the per-`check_run` upserts already carry the state.

## What incremental does *not* recompute (phase 1)

`blockingReason` depends on `mergeable` + `reviewDecision` + required-ness, none
of which a check event carries. Phase 1 updates **counts only**; `blockingReason`
stays as last computed and is refreshed by `pull_request`/`push` events and the
sweep. (Counts are "the main thing on the pill" — the explicit priority.) Phase 2
can apply the `mergeStateStatus` heuristic from cached `mergeable` for a
best-effort colour.

## Cleanup / wipe triggers

- **PR closed/merged** (`pull_request` closed): delete `pr_check_states` for that
  PR's `head_sha`.
- **Force-push / new head** (`pull_request` synchronize): delete rows for the
  *previous* `head_sha` (the pre-update `lastSummary.headSha`); the new sha's rows
  accrue as checks arrive.
- **TTL safety net**: the 5-min sweep prunes rows whose `head_sha` matches no
  tracked open PR, so the table can't grow unbounded (it only ever holds checks
  for currently-open, currently-tracked PRs).

## Correctness backstops

- **5-min reconcile sweep**: full GraphQL → authoritative counts → overwrites
  `lastSummary.checks`. Any incremental drift heals within a tick.
- **Detail overlay**: opening a PR runs the full PR GraphQL query (mergeable,
  reviews, full rollup) — always accurate, never reads `pr_check_states`.

## Edge cases

- **Unknown head_sha** (a check arrives before any `pull_request` event for the
  PR): do a single `refreshPr` to establish `headSha` + counts, then incremental
  thereafter. Most PRs get a `pull_request` event first.
- **Legacy `status` events** (commit statuses): needed for repos that use them
  (GitHub-Actions repos like posthog generally don't). `status` payloads carry a
  `sha` but no PR numbers → map `sha → tracked PR` via `lastSummary.headSha`.
  Requires subscribing to the `status` event. **Phase 2.**
- **Cross-fork junk**: `check_run.pull_requests` sometimes lists unrelated PRs —
  already filtered out by `filterTrackedOpenAcross` (we only touch tracked PRs).

## Phasing

1. **Phase 1 — shadow mode.** Add the table + `check_run` handler. Compute counts
   incrementally but keep `refreshPr` on check events too; log
   `incremental vs GraphQL` count diffs to the debug bus. No behaviour change —
   just validate accuracy.
2. **Phase 2 — cut over.** Once diffs are clean, drop the per-check-event
   `refreshPr`: check events go incremental-only. Add `status` handling +
   `blockingReason` heuristic + force-push pruning.
3. **Phase 3 — polish.** Tune TTLs, add a Debug tile for incremental-vs-sweep
   drift.

## Egress summary (the explicit constraint)

- New rows are tiny text records — no jsonb blobs.
- Counts via `GROUP BY` aggregate — ~5 rows per recompute.
- `lastSummary` updated via `jsonb_set` — the blob is never read back into the
  backend.
- Broadcast uses the existing small counts shape — no per-check data leaves the
  backend.
- The table is pruned on close/merge/force-push + TTL — bounded to open,
  tracked PRs.
