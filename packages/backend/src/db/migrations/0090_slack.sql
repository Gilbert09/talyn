-- Slack sessions, phase 1: the installation, the identity links, the event
-- inbox and the OAuth state.
--
-- Backend-pool-only, like the team tables (0071): RLS on with NO policy and no
-- talyn_backend grant. The routes run before ownerScope and authorise
-- explicitly.
CREATE TABLE IF NOT EXISTS "slack_installations" (
	"team_id" text PRIMARY KEY NOT NULL,
	"team_name" text,
	"team_url" text,
	"app_id" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"bot_name" text,
	"scope" text,
	"access_token_enc" jsonb,
	"refresh_token_enc" jsonb,
	"expires_at" timestamp with time zone,
	"token_error" text,
	"token_error_at" timestamp with time zone,
	"refresh_lease_until" timestamp with time zone,
	"installed_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- No FK to slack_installations: forgetting a token keeps the links, so a
-- reinstall brings them back without everybody linking again.
CREATE TABLE IF NOT EXISTS "slack_user_links" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"workspace_id" text REFERENCES "workspaces"("id") ON DELETE SET NULL,
	"trigger_emojis" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_slack_user_links_team_slack_user" ON "slack_user_links" USING btree ("team_id", "slack_user_id");
--> statement-breakpoint
-- One Slack identity per Talyn user per team.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_slack_user_links_team_user" ON "slack_user_links" USING btree ("team_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_user_links_user" ON "slack_user_links" USING btree ("user_id");
--> statement-breakpoint
-- The primary key is the idempotency: Slack retries a slow delivery, and two
-- replicas can receive the same one.
CREATE TABLE IF NOT EXISTS "slack_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"team_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"outcome" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_events_pending" ON "slack_events" USING btree ("received_at") WHERE "processed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_events_processed" ON "slack_events" USING btree ("processed_at") WHERE "processed_at" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slack_oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"flow" text NOT NULL,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"workspace_id" text REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"code_verifier_enc" jsonb NOT NULL,
	"client" text DEFAULT 'desktop' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_oauth_states_expires_at" ON "slack_oauth_states" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "slack_installations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "slack_user_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "slack_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "slack_oauth_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "slack_installations", "slack_user_links", "slack_events", "slack_oauth_states" FROM PUBLIC, anon, authenticated;
