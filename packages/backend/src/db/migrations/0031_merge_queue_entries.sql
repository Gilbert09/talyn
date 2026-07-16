-- Merge queue v2: first-class entries + audit log (dual-write phase).
-- The old processor keeps driving off pull_requests.merge_queue_state until
-- the engine flag flips to 'v2' (migration 0032); until then the enqueue /
-- dequeue routes dual-write membership here and this backfill seeds the
-- current queue. See services/mergeQueue/.
CREATE TABLE IF NOT EXISTS "merge_queue_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"pull_request_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"base_branch" text NOT NULL DEFAULT '',
	"merge_method" text NOT NULL DEFAULT 'squash',
	"status" text NOT NULL DEFAULT 'queued',
	"blocked_code" text,
	"blocked_reason" text,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"head_sha" text NOT NULL DEFAULT '',
	"fix_attempts" integer NOT NULL DEFAULT 0,
	"rerun_attempts" integer NOT NULL DEFAULT 0,
	"resign_attempts" integer NOT NULL DEFAULT 0,
	"fix_task_id" text,
	"fix_task_accounted" boolean NOT NULL DEFAULT true,
	"fix_kind" text,
	"signing_checked_sha" text,
	"unsigned_count" integer,
	"automerge_armed_at" timestamp with time zone,
	"automerge_armed_by" text,
	"pending_disarm" boolean NOT NULL DEFAULT false,
	"merge_started_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"last_evaluated_at" timestamp with time zone,
	"version" integer NOT NULL DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_queue_entries_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "pull_requests"("id") ON DELETE cascade,
	CONSTRAINT "merge_queue_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade,
	CONSTRAINT "merge_queue_entries_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE cascade,
	CONSTRAINT "merge_queue_entries_fix_task_id_fkey" FOREIGN KEY ("fix_task_id") REFERENCES "tasks"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_mqe_active_pr" ON "merge_queue_entries" ("pull_request_id") WHERE "status" NOT IN ('merged','removed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mqe_group" ON "merge_queue_entries" ("repository_id","base_branch","enqueued_at") WHERE "status" NOT IN ('merged','removed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mqe_active_ws" ON "merge_queue_entries" ("workspace_id") WHERE "status" NOT IN ('merged','removed');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mqe_inflight" ON "merge_queue_entries" ("status") WHERE "status" IN ('merging','automerge_armed','fixing');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merge_queue_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"trigger" text NOT NULL,
	"code" text,
	"message" text NOT NULL DEFAULT '',
	"detail" jsonb,
	CONSTRAINT "merge_queue_events_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "merge_queue_entries"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mqev_entry" ON "merge_queue_events" ("entry_id","at");
--> statement-breakpoint
-- RLS enabled here; the authenticated GRANTs + workspace-owner policies land
-- in 0033. (This migration originally shipped them policy-less on the wrong
-- assumption these tables were pool-only — but the enqueue route's dual-write
-- and the list/timeline endpoints query them inside withOwnerScope's
-- authenticated-role transaction. See 0033 for the incident note.)
ALTER TABLE "merge_queue_entries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "merge_queue_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Engine flag: 'v1' = the old poll processor drives; 'v2' = the event-driven
-- pipeline drives. Flipped by migration 0032 at cutover; the old processor
-- re-reads it every tick, so the prior deploy stops driving within ~10s of
-- the flip committing. Seeded idempotently, never overwritten here.
INSERT INTO "settings" ("key", "value") VALUES ('merge_queue_engine', '"v1"'::jsonb) ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- Backfill: one active entry per currently-queued PR, mapped from the old
-- jsonb state blob. Status map: waiting→queued, fixing/merging keep their
-- names, blocked splits on mergeForbidden ('hard' → blocked_manual). Blocked
-- codes: 'hard'→app_refused_hard, 'unsigned-commits'→unsigned_commits,
-- 'failing-checks'→app_refused_checks, draft reason→draft, else
-- attempts_exhausted. fix_task_id joins tasks so a pruned task can't break
-- the FK. Idempotent via the partial unique index on active entries.
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
