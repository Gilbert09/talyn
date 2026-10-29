-- Slack sessions, phase 2: which Slack thread belongs to which session, which
-- messages already triggered one, what each channel tends to work on, and the
-- session's own record of where it came from.
--
-- The three new tables are backend-pool-only, like 0090: RLS on with NO policy
-- and no talyn_backend grant. Event processing has no request and no owner
-- scope; the routes authorise against req.user explicitly.

-- Nullable: only a session started outside the app has one. Display data
-- copied from Slack (team, channel, message, permalink). Never a credential.
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "source" jsonb;
--> statement-breakpoint
-- One row per Slack thread Talyn acted on. A later trigger in the same thread
-- becomes a new turn in the same session. `workbench_id` is null while the
-- request waits for the user to pick a repository (`phase` 'needs_repository',
-- with the built prompt and source kept here) or while it is starting.
CREATE TABLE IF NOT EXISTS "slack_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"workspace_id" text REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"workbench_id" text REFERENCES "workbenches"("id") ON DELETE SET NULL,
	-- 'starting' | 'needs_repository' | 'started' | 'failed'
	"phase" text NOT NULL,
	-- The message the status reaction sits on: the latest trigger in the thread.
	"trigger_message_ts" text NOT NULL,
	-- The ONE reaction Talyn set there, so it removes only its own.
	"status_reaction" text,
	-- The SlackStatusState that reaction shows.
	"last_state" text,
	"pending_prompt" text,
	"pending_source" jsonb,
	"pending_candidates" jsonb,
	-- The words the session's name and branch come from (the request, not
	-- Talyn's framing around it).
	"pending_naming_text" text,
	-- Why the repository was chosen (SlackRepoChoiceReason) and the detail.
	"repo_reason" text,
	"repo_reason_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_slack_threads_thread" ON "slack_threads" USING btree ("team_id", "channel_id", "thread_ts");
--> statement-breakpoint
-- Status reactions look a thread up by its session on every state change.
CREATE INDEX IF NOT EXISTS "idx_slack_threads_workbench" ON "slack_threads" USING btree ("workbench_id") WHERE "workbench_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_threads_pending_user" ON "slack_threads" USING btree ("user_id") WHERE "phase" = 'needs_repository';
--> statement-breakpoint
-- A message that already triggered something. The primary key is the guard:
-- a trigger reaction removed and added again (a new event id) does nothing.
-- `event_id` lets a retry of the SAME event proceed. Rows are kept: one per
-- human action, about a hundred bytes each.
CREATE TABLE IF NOT EXISTS "slack_trigger_messages" (
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_ts" text NOT NULL,
	"event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("team_id", "channel_id", "message_ts")
);
--> statement-breakpoint
-- Which repositories a channel's Slack sessions used. `corrections` counts the
-- times a person picked or changed the repository for one; those weigh double.
CREATE TABLE IF NOT EXISTS "slack_repo_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"repository_id" text NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
	"uses" integer DEFAULT 0 NOT NULL,
	"corrections" integer DEFAULT 0 NOT NULL,
	"corrected" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_slack_repo_memory" ON "slack_repo_memory" USING btree ("team_id", "channel_id", "repository_id");
--> statement-breakpoint
ALTER TABLE "slack_threads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "slack_trigger_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "slack_repo_memory" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "slack_threads", "slack_trigger_messages", "slack_repo_memory" FROM PUBLIC, anon, authenticated;
