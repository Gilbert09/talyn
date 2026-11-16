-- PostHog Inbox backlog: a person can run a rule on older reports by hand
-- ("Run selected"). The run history must show that, and who did it.
--  - `trigger_source`: 'event' (a webhook, a push or a poll) or 'manual'.
--  - `triggered_by_user_id`: the user who started a manual run.
--  - `triggered_by_label`: their name or email when they started it, so the
--    history needs no join to `users` (another workspace member can read it).
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "trigger_source" text DEFAULT 'event' NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "triggered_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "triggered_by_label" text;
