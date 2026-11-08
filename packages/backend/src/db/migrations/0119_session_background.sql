-- Session background jobs and wake-ups (`session-background` flag).
--
-- workbench_background_jobs: a shell command an agent started in its session's
-- sandbox, run by the durable supervisor (durableExec.ts) so it outlives the
-- turn. `sandbox_id` is the box it started on: a session whose box changed
-- (move, resize, recreate) has lost the job. A sweep checks running jobs and
-- settles them once (`WHERE status = 'running'`).
--
-- workbench_wakeups: a turn Talyn sends into a chat at `wake_at`. The schedule
-- is a column swept every 30 s, never a timer, so a deploy does not lose it.
-- The sweep claims a row with `WHERE status = 'scheduled'`, so two replicas
-- cannot both fire it. A job's exit wake-up is UNIQUE per job.
--
-- payer_user_id / payer_workspace_id: the payer of the turn that made the row
-- (Teams and Spaces). NULL means the session's owner.
--
-- Backend-pool-only, like workbench_preview_hosts (0098): RLS on with NO policy
-- and no talyn_backend grant. The routes and the sweep read them on the pool.
-- Rows go with their session and chat (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS "workbench_background_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workbench_id" text NOT NULL REFERENCES "workbenches"("id") ON DELETE CASCADE,
	"chat_id" text NOT NULL REFERENCES "workbench_chats"("id") ON DELETE CASCADE,
	"workspace_id" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"name" text NOT NULL,
	"command" text NOT NULL,
	"cwd" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"detail" text,
	"durable_key" text NOT NULL,
	"marker" text NOT NULL,
	"keep_awake_until" timestamp with time zone,
	"notify_on_exit" boolean DEFAULT true NOT NULL,
	"payer_user_id" text,
	"payer_workspace_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_background_jobs_running" ON "workbench_background_jobs" USING btree ("last_checked_at") WHERE "status" = 'running';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_background_jobs_workbench" ON "workbench_background_jobs" USING btree ("workbench_id", "started_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workbench_wakeups" (
	"id" text PRIMARY KEY NOT NULL,
	"workbench_id" text NOT NULL REFERENCES "workbenches"("id") ON DELETE CASCADE,
	"chat_id" text NOT NULL REFERENCES "workbench_chats"("id") ON DELETE CASCADE,
	"workspace_id" text NOT NULL,
	"wake_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"prompt" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"failure_detail" text,
	"created_by" text DEFAULT 'agent' NOT NULL,
	"payer_user_id" text,
	"payer_workspace_id" text,
	"source_job_id" text REFERENCES "workbench_background_jobs"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_wakeups_due" ON "workbench_wakeups" USING btree ("wake_at") WHERE "status" = 'scheduled';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_wakeups_workbench" ON "workbench_wakeups" USING btree ("workbench_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workbench_wakeups_source_job" ON "workbench_wakeups" USING btree ("source_job_id") WHERE "source_job_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "workbench_background_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workbench_wakeups" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "workbench_background_jobs" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON "workbench_wakeups" FROM PUBLIC, anon, authenticated;
