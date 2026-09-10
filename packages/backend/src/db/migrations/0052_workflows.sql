-- Workflows — user-defined PR automation.
--
-- Two tables, following the merge-queue pair (0031 + the RLS block from 0033):
-- a config row the user edits, and an append-only history of what it did.
--
-- WHY A TABLE AND NOT `workspaces.settings`
--
-- Saved PR filters (Session 101) ride the settings jsonb and cost zero
-- migrations, which was right for them: a filter is pure config with no
-- history. A workflow has a run log — which PR, which event, which actions,
-- and the task it started — that is queried by time window for the stats, and
-- appended to from a webhook worker on any replica. That is a table.
CREATE TABLE IF NOT EXISTS "workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	-- WorkflowTriggerEvent[] and WorkflowConditions / WorkflowAction[] from
	-- @talyn/shared. jsonb rather than columns because the shapes are a
	-- discriminated union the validator owns; a column per condition would be a
	-- migration every time a trigger learns a new fact.
	"events" jsonb NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	-- The loop breaker. An `add_labels` action produces a `pull_request/labeled`
	-- delivery, which is itself a trigger event, so a workflow on `pr_labeled`
	-- that adds a label is an unbounded loop. Self-echo suppression in the
	-- engine is the real fix; this bounds the echo it cannot see (a third party
	-- relabelling in response to ours). Default 5 — see
	-- DEFAULT_WORKFLOW_RUNS_PER_PR_PER_HOUR.
	"max_runs_per_pr_per_hour" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_workspace_id_fkey" FOREIGN KEY ("workspace_id")
		REFERENCES "public"."workspaces"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflows_workspace" ON "workflows" USING btree ("workspace_id");
--> statement-breakpoint
-- One evaluation of one workflow against one PR.
--
-- THE PR IS DENORMALISED ON PURPOSE. `pull_request_id` is nullable and set
-- only when a row happens to exist, because a workflow fires on every PR in a
-- watched repo — including PRs Talyn does not track, which have no row at all
-- — and because un-watching a PR DELETES the row it did have. The record of
-- what an automation did to someone's PR has to outlive both, which is the
-- same reasoning that makes `tasks.pull_request_id` `ON DELETE set null`
-- (0048). Reading the repo/number/title off the run row also means the history
-- view is one query with no joins.
CREATE TABLE IF NOT EXISTS "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"repository_id" text,
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"pr_title" text DEFAULT '' NOT NULL,
	"pr_url" text DEFAULT '' NOT NULL,
	"pr_author" text DEFAULT '' NOT NULL,
	"pull_request_id" text,
	"task_id" text,
	"event" text NOT NULL,
	-- GitHub's X-GitHub-Delivery. See the unique index below.
	"delivery_id" text NOT NULL,
	"status" text NOT NULL,
	-- WorkflowActionOutcome[] — one entry per action, in order, each with its
	-- ok/code/detail. The whole point of a `partial` status.
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_runs_workflow_id_fkey" FOREIGN KEY ("workflow_id")
		REFERENCES "public"."workflows"("id") ON DELETE cascade,
	CONSTRAINT "workflow_runs_repository_id_fkey" FOREIGN KEY ("repository_id")
		REFERENCES "public"."repositories"("id") ON DELETE set null,
	CONSTRAINT "workflow_runs_pull_request_id_fkey" FOREIGN KEY ("pull_request_id")
		REFERENCES "public"."pull_requests"("id") ON DELETE set null,
	CONSTRAINT "workflow_runs_task_id_fkey" FOREIGN KEY ("task_id")
		REFERENCES "public"."tasks"("id") ON DELETE set null
);
--> statement-breakpoint
-- THE IDEMPOTENCY KEY, and the whole concurrency design.
--
-- GitHub redelivers, and the webhook worker's coalescing map is in-memory and
-- per-replica — adequate for "should I refresh this PR", useless for "should I
-- post this comment". The engine INSERTS the run row before it acts; a unique
-- violation means another replica, or an earlier delivery of the same event,
-- already owns this (workflow, delivery) and this one returns without acting.
-- No advisory lock, no distributed dedupe cache.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workflow_runs_delivery"
	ON "workflow_runs" USING btree ("workflow_id","delivery_id");
--> statement-breakpoint
-- The history view: newest first, per workflow.
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_workflow_at"
	ON "workflow_runs" USING btree ("workflow_id","created_at" DESC);
--> statement-breakpoint
-- The rate-cap query: "how many times has THIS workflow run on THIS PR in the
-- last hour". Counted from the table rather than an in-process window so it
-- survives a restart and is shared across replicas.
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_pr"
	ON "workflow_runs" USING btree ("workflow_id","repo_full_name","pr_number","created_at");
--> statement-breakpoint
-- Defence in depth (the 0013 + 0024 / 0033 pattern). The backend pool connects
-- as the privileged role, but the workflow routes run inside withOwnerScope,
-- which drops the transaction to `authenticated` — a table that is
-- RLS-enabled with no policy raises `permission denied`, which aborts the whole
-- request transaction and cascades 25P02 onto every later query in it. That
-- exact omission was a prod incident on these two tables' predecessors.
ALTER TABLE "workflows" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workflows" TO "authenticated";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "workflow_runs" TO "authenticated";
--> statement-breakpoint
CREATE POLICY "workflows_workspace" ON "workflows" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
--> statement-breakpoint
-- Runs chain their ownership through the workflow, exactly as
-- merge_queue_events chain through their entry.
CREATE POLICY "workflow_runs_workflow" ON "workflow_runs" FOR ALL
  USING (workflow_id IN (
    SELECT id FROM workflows
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text)
  ))
  WITH CHECK (workflow_id IN (
    SELECT id FROM workflows
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text)
  ));
