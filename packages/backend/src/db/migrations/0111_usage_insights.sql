-- Insights: compact rows the usage analytics read, so a page view never scans
-- the transcript (workbench_events) or the settings jsonb.
--
-- workbench_turn_usage: one row per (chat, turn, model), written when a turn's
-- result event is stored. Token counts are this turn's own (Codex reports
-- totals for the whole thread, so the writer stores the difference). The
-- turn-level columns (duration_ms, agent_steps, first_reply_ms) are set on the
-- turn's main model row only (is_primary). cost_estimate_micros is the agent's
-- own estimate at API prices; null when the agent reports none (Codex).
--
-- workbench_boot_samples: one row per box start and per successful wake, keyed
-- by the boot_metric event it mirrors, so the live write and the backfill
-- cannot store one twice.
--
-- usage_insights_backfill: the cursor of the one-off backfill of both tables
-- from existing events. completed_at set means it is done.
--
-- No FK to the session or the chat: a deleted session still counts in the
-- window it ran in. The workspace FK cascades, so deleting a workspace or an
-- account removes its rows. Backend-pool-only, like the usage tables (0110).
CREATE TABLE IF NOT EXISTS "workbench_turn_usage" (
	"chat_id" text NOT NULL,
	"turn" integer NOT NULL,
	"model" text NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"workbench_id" text NOT NULL,
	"agent" text NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_estimate_micros" bigint,
	"duration_ms" bigint,
	"agent_steps" integer,
	"first_reply_ms" bigint,
	"is_error" boolean DEFAULT false NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workbench_turn_usage_pkey" PRIMARY KEY ("chat_id", "turn", "model")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_turn_usage_workspace_ended" ON "workbench_turn_usage" USING btree ("workspace_id", "ended_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_turn_usage_workbench_ended" ON "workbench_turn_usage" USING btree ("workbench_id", "ended_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workbench_boot_samples" (
	"chat_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"workbench_id" text NOT NULL,
	"kind" text NOT NULL,
	"ms" bigint NOT NULL,
	"cause" text,
	"layer" text,
	"source" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "workbench_boot_samples_pkey" PRIMARY KEY ("chat_id", "seq")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_boot_samples_workspace_at" ON "workbench_boot_samples" USING btree ("workspace_id", "kind", "at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_insights_backfill" (
	"name" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"chats_done" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The output section counts by time in a workspace. These tables have no
-- index that answers that; tasks, workbenches and usage_intervals do.
CREATE INDEX IF NOT EXISTS "idx_merge_queue_events_merged_at" ON "merge_queue_events" USING btree ("at") WHERE "to_status" = 'merged';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pr_code_review_runs_workspace_created" ON "pr_code_review_runs" USING btree ("workspace_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pr_code_review_findings_workspace_created" ON "pr_code_review_findings" USING btree ("workspace_id", "created_at");
--> statement-breakpoint
ALTER TABLE "workbench_turn_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workbench_boot_samples" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "usage_insights_backfill" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "workbench_turn_usage" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON "workbench_boot_samples" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON "usage_insights_backfill" FROM PUBLIC, anon, authenticated;
