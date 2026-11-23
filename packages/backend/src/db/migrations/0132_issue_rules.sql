-- Issue rules (Linear, GitHub Issues): the work a rule started on an issue,
-- and the Linear OAuth flow's pending states.
--
-- `external_issue_links` ties one issue to the session or task a rule started
-- for it. A start action inserts the row BEFORE it dispatches, and the partial
-- UNIQUE (workspace_id, integration, external_id) WHERE status = 'active' is
-- what stops a second event on the same issue from starting a second piece of
-- work. When the work's pull request merges, Talyn comments on the issue,
-- moves it to done, and marks the row `done`. Work that ended without a merge
-- marks it `failed`, so a later event can start again. `our_comment_ids`
-- holds the comments Talyn wrote, so a rule never triggers on them. `facts`
-- keeps the issue facts (no long text) for the merge write-back.
--
-- `inbound_oauth_states` is one pending OAuth sign-in for an inbound vendor
-- (Linear today): single use, 10-minute TTL, PKCE verifier encrypted.
--
-- Both are backend-pool-only, like inbound_connections (0131): RLS on with NO
-- policy and no talyn_backend grant.
CREATE TABLE IF NOT EXISTS "external_issue_links" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"integration" text NOT NULL,
	"connection_id" text REFERENCES "inbound_connections"("id") ON DELETE SET NULL,
	"workflow_id" text REFERENCES "workflows"("id") ON DELETE SET NULL,
	"run_id" text,
	"external_id" text NOT NULL,
	"external_key" text NOT NULL,
	"external_url" text NOT NULL DEFAULT '',
	"facts" jsonb,
	"task_id" text REFERENCES "tasks"("id") ON DELETE SET NULL,
	"workbench_id" text REFERENCES "workbenches"("id") ON DELETE SET NULL,
	"pull_request_id" text REFERENCES "pull_requests"("id") ON DELETE SET NULL,
	"our_comment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_external_issue_links_active"
  ON "external_issue_links" USING btree ("workspace_id", "integration", "external_id") WHERE "status" = 'active';
--> statement-breakpoint
-- Every link of one issue, any status: the self-echo check reads our comment ids.
CREATE INDEX IF NOT EXISTS "idx_external_issue_links_issue"
  ON "external_issue_links" USING btree ("integration", "external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_external_issue_links_task"
  ON "external_issue_links" USING btree ("task_id") WHERE "task_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_external_issue_links_workbench"
  ON "external_issue_links" USING btree ("workbench_id") WHERE "workbench_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_external_issue_links_pull_request"
  ON "external_issue_links" USING btree ("pull_request_id") WHERE "pull_request_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "external_issue_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "external_issue_links" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound_oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"code_verifier_enc" jsonb NOT NULL,
	"client" text NOT NULL DEFAULT 'desktop',
	"mobile_return" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inbound_oauth_states_expires"
  ON "inbound_oauth_states" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "inbound_oauth_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "inbound_oauth_states" FROM PUBLIC, anon, authenticated;
