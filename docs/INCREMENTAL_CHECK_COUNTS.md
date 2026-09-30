# The check ledger

**Status:** SHIPPED. `pr_check_states` (migrations 0027, 0070), `services/checkCounts.ts`,
`packages/shared/src/checkVerdict.ts`. This replaced the webhook-only "incremental
check counts" design, whose table nothing ever corrected (see "Why it was rebuilt").

## What it is

`pr_check_states` holds one row per **(repo, head sha, check name)**. It is the
per-commit record of every check run and commit status Talyn knows about:

| column | notes |
|---|---|
| `repo_full_name`, `head_sha`, `name` | the unique key — a re-run of a name updates its row |
| `state` | normalized: `success` \| `failure` \| `pending` \| `in_progress` \| `skipped` |
| `raw_state` | GitHub's own value (`FAILURE`, `ERROR`, `TIMED_OUT`, …) |
| `required` | GitHub's per-PR required-ness from the last full fetch; NULL = not known |
| `url` | detailsUrl / targetUrl |
| `source` | `check_run` \| `status` \| `snapshot` (a full-fetch reseed) |
| `ts` | the event's own time — the ordering key |

Nothing per-check leaves the backend. The front ends see only the summary fields
derived from it: `checks`, `ciStatus`, `humanGates`, `blockingReason`.

## Two writers, one lock

1. **Webhooks.** `check_run` and `status` deliveries are parsed and buffered by
   the coalescer (keyed by repo + sha, 750 ms window). A flush upserts the rows
   (an older event never overwrites a newer one) and re-derives the verdict.
2. **Every complete full fetch.** `prCache.upsertRow` starts
   `reseedCheckLedger` for the PR's head. The snapshot replaces every row that no
   webhook touched since the fetch started, and deletes rows GitHub no longer
   lists. A webhook that landed during the fetch keeps the usual newest-wins rule.
   `required` comes from the snapshot when it knows, and is kept when it does not
   (the by-branch path cannot ask).

There is no lock. A per-commit `pg_advisory_xact_lock` shipped first and was
removed the next day: `withBlockingAdvisoryLock` holds the lock on one pooled
connection and runs the work on others, so a burst of flushes took the whole pool
and deadlocked it (2026-09-30). Two flushes of one commit can still interleave
and write an older count last; the settle refresh and the next reseed correct it.

The reseed is **not awaited** by `upsertRow`. That write can be inside a request
transaction that holds the PR row lock. A flush that holds the advisory lock can
be waiting for that row. If the request waited for the reseed, each would wait
for the other. The reseed reads the PR row `FOR UPDATE`, so it sees the committed
facts.

Most reseeds change nothing: every tracked PR is fetched once per watching
workspace each sweep, and PostHog/posthog has ~17. So a reseed first compares an
md5 of the ledger (one aggregate row) with the same hash of the snapshot, and
stops if they match. When they differ, it rewrites only the rows that differ.
Reseeds run two at a time, and repeat requests for a commit merge into the
newest snapshot. The 24 h prune only removes rows for a commit that is no open
PR's head, because an unchanged ledger is no longer touched.

An incomplete context list (a page of a >100-check rollup could not be read) never
reseeds, and adds a stand-in context so a `FAILURE` rollup cannot read as green.

## One verdict

`deriveCiVerdict` (shared) takes per-check facts and returns:

- `ciStatus`: `none` | `passing` | `running` | `failing_optional` |
  `failing_required` | `needs_human`.
- `humanGates`: failing gates only a person can clear.
- Counts of blocking, unknown and optional failures.

A failing check with **unknown** required-ness counts as blocking. The one
exception is `MERGEABLE + UNSTABLE` read in the same fetch — GitHub itself saying
the failures are optional. The webhook path never uses that exception, because
the row's `mergeStateStatus` is from before the failure.

`computeBlockingReason` takes the verdict. The full fetch (`rawToSummary`) and the
ledger recompute (`recomputeVerdicts` → `verdictFor`) use the same functions, so
they can disagree only about inputs.

The ledger recompute writes `checks`, `blockingReason`, `ciStatus`, `humanGates`
and `failingChecksDigest` with one `||` jsonb merge, and skips the UPDATE when
none of them changed.

## Human gates

`HUMAN_GATES` in `checkVerdict.ts`. The first entry is PostHog Visual Review:

- the gate: status context `PostHog Visual Review / <type>` in raw state
  `FAILURE` (not `ERROR`; ` (tracking)` / ` (partial)` never gate);
- its consequences: `Visual regression tests pass` (required) and
  `Complete Visual Review run`, which fail because the gate fails.

If a gate fails and every blocking failure is the gate or one of its
consequences, the verdict is `needs_human`. `prBlocksMerge` is true (the queue
must not submit). `prNeedsFollowup` is false (no automation spends a run). The
merge queue parks `awaiting_human_check`, and auto-keep stands down, both before
any run.

## Healing

- **Settle refresh.** Every buffered event re-arms a per-commit timer. 90 s after
  the last event, one authoritative refresh runs for the PRs on that head (one
  fetch per GitHub account). That reseeds the ledger after CI goes quiet.
- **Required-ness recheck.** A failing row with `required = null` fires a
  targeted by-number refresh (leading + trailing 15 s debounce).
- **The reconcile sweep** (5 min) still refetches every tracked PR, and now
  refreshes tracked rows even when the relationship searches fail.
- **Pruning.** Rows for a closed PR's head and a force-pushed PR's old head are
  deleted; rows idle for 24 h are pruned by the sweep.

## Why it was rebuilt (2026-09-29)

PostHog/posthog#104122 had 308 completed check runs and showed "1/232 running".
Opening the detail sheet fixed it until the next check event. The cause: the
webhook table was never corrected. The full fetch replaced `last_summary.checks`
but left the rows, so the next `check_run` on the commit (PostHog runs review- and
label-triggered workflows long after CI) recounted from a stale `pending` row.
The unlocked read-then-write between flushes produced the same "exactly 1"
symptom. And there is no periodic poll any more, so nothing else repaired it.

The same week, a held `'blocked'` verdict (PostHog reports `BLOCKED` on every PR)
survived a required `Semgrep Checks Pass` going red, because the webhook path
patched `checks` only, and the pill read `'blocked'` as "every failure is
non-required". The pill now draws `ciStatus`.
