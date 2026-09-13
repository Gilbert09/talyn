-- Loops — recurring prompts on a cron schedule.
--
-- Two tables, the workflows shape: a rule the user edits, and an append-only
-- history of what it did. What is new here is that the trigger is TIME, which
-- changes exactly one thing about the design and it is load-bearing:
--
--   THE SCHEDULE IS A COLUMN, NOT A TIMER.
--
-- `loops.next_run_at` holds the next occurrence. A 30-second sweep reads the
-- due rows through a partial index, claims each firing by inserting its run row
-- under a unique constraint, dispatches, and only then advances the column. A
-- timer living in a process would be lost on every Railway deploy — which is
-- every push to main.
CREATE TABLE IF NOT EXISTS "loops" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"prompt" text NOT NULL,
	"cron" text NOT NULL,
	-- IANA zone name. The first per-row timezone stored anywhere in Talyn: every
	-- other `timezone` in this schema is just `timestamptz`.
	"timezone" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"concurrency" text DEFAULT 'skip' NOT NULL,
	"repository_id" text,
	"repo_full_name" text NOT NULL,
	"next_run_at" timestamp with time zone,
	"disabled_reason" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loops_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id")
		REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	-- SET NULL, not cascade: removing a repository must not delete the loop and
	-- its entire history. The scheduler re-resolves by repo_full_name first.
	CONSTRAINT "loops_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id")
		REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "loop_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"loop_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"repository_id" text,
	"repo_full_name" text NOT NULL,
	-- Denormalised from the loop at fire time, so editing a loop cannot rewrite
	-- what its past runs say they did.
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"task_id" text,
	-- The fact task_id cannot carry: its FK is ON DELETE SET NULL, so a deleted
	-- task empties task_id and a run that HAD one looks exactly like a run that
	-- never got that far. Those need different answers.
	"dispatched_at" timestamp with time zone,
	"status" text NOT NULL,
	"failure_code" text,
	"error" text,
	"retry_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "loop_runs_loop_id_loops_id_fk" FOREIGN KEY ("loop_id")
		REFERENCES "public"."loops"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "loop_runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id")
		REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action,
	-- SET NULL: the history must outlive the task. A run still active when its
	-- task disappears settles 'failed' with failure_code 'task_deleted'.
	CONSTRAINT "loop_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id")
		REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
-- The sweep's only hot read: enabled loops whose occurrence has arrived.
--
-- Partial on `enabled`, NOT on `next_run_at IS NOT NULL` (which is what 0053
-- does for workflow retries). The two are opposite situations: a retry column
-- is null on almost every row, so nullness is what makes that index small.
-- Here every enabled loop has a next_run_at, and the dead weight is the
-- DISABLED loops — including their index maintenance on every edit. With this
-- predicate a tick reads the left edge of the btree and stops: the cost is the
-- number of loops that are DUE, not the number that exist.
CREATE INDEX IF NOT EXISTS "idx_loops_due"
	ON "loops" USING btree ("next_run_at") WHERE "enabled";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_loops_workspace" ON "loops" USING btree ("workspace_id");
--> statement-breakpoint
-- THE CONCURRENCY DESIGN, and the direct analogue of idx_workflow_runs_delivery.
--
-- The run row is inserted BEFORE the task is created, so the insert is the
-- claim: a unique violation means another replica (or this one, re-entering
-- after a crash) already owns this occurrence. No advisory lock in the fire
-- path, no distributed dedupe cache.
--
-- What makes it stronger than the workflows version: a webhook delivery id is
-- an opaque token each replica must have RECEIVED, while a scheduled instant is
-- derived from the loop's own stored next_run_at. Two actors that both believe
-- a firing is owed cannot compute different keys for it.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_loop_runs_slot"
	ON "loop_runs" USING btree ("loop_id","scheduled_for");
--> statement-breakpoint
-- The history view: newest first, per loop.
CREATE INDEX IF NOT EXISTS "idx_loop_runs_history"
	ON "loop_runs" USING btree ("loop_id","created_at" DESC);
--> statement-breakpoint
-- The overlap probe and the settlement backstop. Partial because active runs
-- are a vanishing fraction of an append-only history — the same argument as
-- idx_workflow_runs_retry_due.
CREATE INDEX IF NOT EXISTS "idx_loop_runs_active"
	ON "loop_runs" USING btree ("loop_id","status")
	WHERE "status" IN ('waiting_slot','queued','running');
--> statement-breakpoint
-- The task:status listener's lookup: a task id back to the run that started it.
CREATE INDEX IF NOT EXISTS "idx_loop_runs_task"
	ON "loop_runs" USING btree ("task_id") WHERE "task_id" IS NOT NULL;
--> statement-breakpoint
-- Defence in depth (the 0052 block, verbatim with the names swapped). The
-- backend pool connects as the privileged role, but the loop routes run inside
-- withOwnerScope, which drops the transaction to `authenticated` — and a table
-- that is RLS-enabled with no policy raises `permission denied`, which aborts
-- the whole request transaction and cascades 25P02 onto every later query in
-- it. That exact omission was a prod incident on this pair's predecessors.
ALTER TABLE "loops" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "loop_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "loops" TO "authenticated";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "loop_runs" TO "authenticated";
--> statement-breakpoint
CREATE POLICY "loops_workspace" ON "loops" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
--> statement-breakpoint
-- Runs chain their ownership through the loop, exactly as workflow_runs chain
-- through their workflow.
CREATE POLICY "loop_runs_loop" ON "loop_runs" FOR ALL
  USING (loop_id IN (
    SELECT id FROM loops
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text)
  ))
  WITH CHECK (loop_id IN (
    SELECT id FROM loops
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text)
  ));
