-- Merge queue v2 cutover. Runs at new-instance boot, BEFORE the health-gated
-- traffic switch: re-sync merge_queue_entries with the v1 state blobs one
-- final time (the dual-write window only tracked membership — v1's own
-- transitions never touched entries), then flip the engine flag. The old
-- instance re-reads the flag every 10s tick, so it stands down within one
-- tick of this committing; the v2 triggers + reconciler on the new instance
-- take over. Every statement is idempotent — a re-run (crash loop, second
-- replica racing the boot migrator's blocking lock) converges to the same
-- state.

-- 1) Close out active entries whose PR left the queue during the dual-write
--    window (v1 merged it, a sweep closed it, or the mirror was dequeued).
UPDATE "merge_queue_entries" e
SET "status" = CASE WHEN pr."state" = 'merged' THEN 'merged' ELSE 'removed' END,
    "version" = e."version" + 1,
    "updated_at" = now()
FROM "pull_requests" pr
WHERE pr."id" = e."pull_request_id"
  AND e."status" NOT IN ('merged','removed')
  AND (pr."state" <> 'open' OR pr."merge_queued" = false);
--> statement-breakpoint
-- 2) Refresh the surviving active entries from the authoritative v1 blobs:
--    status (same mapping as the 0031 backfill), budgets, group key, head.
--    A blob-'merging' entry gets merge_started_at stamped so the reconciler's
--    60s in-flight recovery verify-merges it right after cutover.
UPDATE "merge_queue_entries" e
SET
  "status" = CASE COALESCE(pr."merge_queue_state"->>'status', 'waiting')
    WHEN 'fixing' THEN 'fixing'
    WHEN 'merging' THEN 'merging'
    WHEN 'blocked' THEN
      CASE WHEN pr."merge_queue_state"->>'mergeForbidden' = 'hard'
        THEN 'blocked_manual' ELSE 'blocked' END
    ELSE 'queued'
  END,
  "blocked_code" = CASE
    WHEN COALESCE(pr."merge_queue_state"->>'status', '') <> 'blocked' THEN NULL
    WHEN pr."merge_queue_state"->>'mergeForbidden' = 'hard' THEN 'app_refused_hard'
    WHEN pr."merge_queue_state"->>'mergeForbidden' = 'unsigned-commits' THEN 'unsigned_commits'
    WHEN pr."merge_queue_state"->>'mergeForbidden' = 'failing-checks' THEN 'app_refused_checks'
    WHEN COALESCE(pr."merge_queue_state"->>'blockReason', '') LIKE 'This PR is a draft%' THEN 'draft'
    ELSE 'attempts_exhausted'
  END,
  "blocked_reason" = pr."merge_queue_state"->>'blockReason',
  "base_branch" = COALESCE(NULLIF(pr."last_summary"->>'baseBranch', ''), e."base_branch"),
  "merge_method" = pr."merge_method",
  "head_sha" = COALESCE(NULLIF(pr."last_summary"->>'headSha', ''), e."head_sha"),
  "fix_attempts" = COALESCE((pr."merge_queue_state"->>'attempts')::int, 0),
  "rerun_attempts" = COALESCE((pr."merge_queue_state"->>'rerunAttempts')::int, 0),
  "resign_attempts" = COALESCE((pr."merge_queue_state"->>'resignAttempts')::int, 0),
  "fix_task_id" = t."id",
  "fix_task_accounted" = COALESCE((pr."merge_queue_state"->>'accounted')::boolean, true),
  "last_error" = pr."merge_queue_state"->>'lastError',
  "last_error_at" = (pr."merge_queue_state"->>'lastErrorAt')::timestamptz,
  "merge_started_at" = CASE WHEN pr."merge_queue_state"->>'status' = 'merging' THEN now() ELSE NULL END,
  "version" = e."version" + 1,
  "updated_at" = now()
FROM "pull_requests" pr
LEFT JOIN "tasks" t ON t."id" = pr."merge_queue_state"->>'lastFixTaskId'
WHERE pr."id" = e."pull_request_id"
  AND e."status" NOT IN ('merged','removed')
  AND pr."merge_queued" = true AND pr."state" = 'open';
--> statement-breakpoint
-- 3) Backfill queued PRs that have NO active entry (drift the other way:
--    rows queued before 0031 shipped whose entry creation was missed, or a
--    failed dual-write). Same INSERT as 0031 — idempotent via the partial
--    unique index.
INSERT INTO "merge_queue_entries" (
	"id", "pull_request_id", "workspace_id", "repository_id", "base_branch",
	"merge_method", "status", "blocked_code", "blocked_reason", "enqueued_at",
	"head_sha", "fix_attempts", "rerun_attempts", "resign_attempts",
	"fix_task_id", "fix_task_accounted", "last_error", "last_error_at"
)
SELECT
	gen_random_uuid()::text,
	pr."id", pr."workspace_id", pr."repository_id",
	COALESCE(pr."last_summary"->>'baseBranch', ''),
	pr."merge_method",
	CASE COALESCE(pr."merge_queue_state"->>'status', 'waiting')
		WHEN 'fixing' THEN 'fixing'
		WHEN 'merging' THEN 'merging'
		WHEN 'blocked' THEN
			CASE WHEN pr."merge_queue_state"->>'mergeForbidden' = 'hard'
				THEN 'blocked_manual' ELSE 'blocked' END
		ELSE 'queued'
	END,
	CASE
		WHEN COALESCE(pr."merge_queue_state"->>'status', '') <> 'blocked' THEN NULL
		WHEN pr."merge_queue_state"->>'mergeForbidden' = 'hard' THEN 'app_refused_hard'
		WHEN pr."merge_queue_state"->>'mergeForbidden' = 'unsigned-commits' THEN 'unsigned_commits'
		WHEN pr."merge_queue_state"->>'mergeForbidden' = 'failing-checks' THEN 'app_refused_checks'
		WHEN COALESCE(pr."merge_queue_state"->>'blockReason', '') LIKE 'This PR is a draft%' THEN 'draft'
		ELSE 'attempts_exhausted'
	END,
	pr."merge_queue_state"->>'blockReason',
	COALESCE(pr."merge_queued_at", now()),
	COALESCE(pr."last_summary"->>'headSha', ''),
	COALESCE((pr."merge_queue_state"->>'attempts')::int, 0),
	COALESCE((pr."merge_queue_state"->>'rerunAttempts')::int, 0),
	COALESCE((pr."merge_queue_state"->>'resignAttempts')::int, 0),
	t."id",
	COALESCE((pr."merge_queue_state"->>'accounted')::boolean, true),
	pr."merge_queue_state"->>'lastError',
	(pr."merge_queue_state"->>'lastErrorAt')::timestamptz
FROM "pull_requests" pr
LEFT JOIN "tasks" t ON t."id" = pr."merge_queue_state"->>'lastFixTaskId'
WHERE pr."merge_queued" = true AND pr."state" = 'open'
ON CONFLICT ("pull_request_id") WHERE "status" NOT IN ('merged','removed') DO NOTHING;
--> statement-breakpoint
-- 4) Flip the engine. From here the v1 processor skips every tick and the v2
--    triggers + reconciler drive the queue. Rollback = set this back to '"v1"'.
UPDATE "settings" SET "value" = '"v2"'::jsonb, "updated_at" = now() WHERE "key" = 'merge_queue_engine';
