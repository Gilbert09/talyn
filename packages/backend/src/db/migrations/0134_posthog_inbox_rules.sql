-- PostHog Inbox rules: a PostHog self-driving report that is ready for work
-- starts a session that opens a pull request.
--
-- `workflows.max_runs_per_day` is a per-rule daily cap, next to
-- max_runs_per_pr_per_hour. NULL means no daily cap. PostHog Inbox rules
-- always set one (the validator defaults it to 10), because one PostHog
-- project can make thousands of reports a week and each run bills box-hours.
--
-- `posthog_inbox_pollers` is the poller's state, one row per PostHog
-- connection (`integrations` row of type 'posthog'):
--  - `cursor_updated_at` is the newest report `updated_at` the poller has
--    handled, as PostHog wrote it (text, so PostHog's microseconds survive).
--    `cursor_report_ids` are the reports at exactly that instant, so a tie is
--    not read twice.
--  - `next_poll_at` and `lease_until` are the claim. A replica takes a row with
--    a conditional UPDATE (due, and no live lease), so two replicas never poll
--    one connection at the same time.
--  - `last_error` / `last_error_status` keep the last failure for the editor
--    (a 401 or 403 means the connection needs the Inbox permission).
--
-- Backend-pool-only, like external_issue_links (0132): RLS on with NO policy
-- and no talyn_backend grant.
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "max_runs_per_day" integer;
--> statement-breakpoint
-- How the poller finds the workspaces to poll, every minute. Partial, so it
-- never reads another integration's rules.
CREATE INDEX IF NOT EXISTS "idx_workflows_posthog_inbox"
  ON "workflows" USING btree ("workspace_id") WHERE "integration" = 'posthog_inbox' AND "enabled";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "posthog_inbox_pollers" (
	"integration_id" text PRIMARY KEY NOT NULL REFERENCES "integrations"("id") ON DELETE CASCADE,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"cursor_updated_at" text,
	"cursor_report_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"last_error_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_posthog_inbox_pollers_next_poll"
  ON "posthog_inbox_pollers" USING btree ("next_poll_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_posthog_inbox_pollers_workspace"
  ON "posthog_inbox_pollers" USING btree ("workspace_id");
--> statement-breakpoint
ALTER TABLE "posthog_inbox_pollers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "posthog_inbox_pollers" FROM PUBLIC, anon, authenticated;
