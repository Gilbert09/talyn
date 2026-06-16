CREATE TABLE "pr_check_states" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"head_sha" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"state" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pr_check_states_repo_sha_name" ON "pr_check_states" USING btree ("repo_full_name","head_sha","name");
--> statement-breakpoint
CREATE INDEX "idx_pr_check_states_repo_sha" ON "pr_check_states" USING btree ("repo_full_name","head_sha");
--> statement-breakpoint
-- Backend-derived check state for the incremental count fast path. Read by the
-- privileged pool role only and never shipped to the desktop (only the derived
-- counts are), so RLS stays OFF — mirrors `github_installations` / `settings`.
-- See docs/INCREMENTAL_CHECK_COUNTS.md.
