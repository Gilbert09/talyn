-- A workflow action that GitHub rate-limited is retried, not lost.
--
-- Until now a run whose action hit a long rate-limit gate settled `failed` and
-- stopped there. The delivery was consumed, and the unique
-- (workflow_id, delivery_id) index made a redelivery a no-op — so unlike every
-- other subsystem in this codebase, nothing ever tried again. Four PRs on
-- PostHog/posthog (#99671–#99674) lost their labels in one burst on 2026-09-12
-- to gates of 128–163s, which is 2–3 minutes of patience away from working.
--
-- Waiting inline is not the fix. These run in the webhook worker's six-wide slow
-- lane, so sleeping out a 163s gate pins a slot — and because the gate is per
-- ACCOUNT, a burst like that one blocks four of the six on the same wait while
-- PR refreshes queue behind them. The run is parked instead, and a sweep picks
-- it up once the gate has cleared.
ALTER TABLE "workflow_runs"
  ADD COLUMN IF NOT EXISTS "retry_after" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workflow_runs"
  ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- What the run was acting ON, so a retry is faithful rather than approximate.
--
-- The row already denormalises the repo, number, title, URL and author, which is
-- what the history renders. A retry needs more than that: a `comment` action
-- interpolates `{{pr.baseBranch}}` and `{{pr.headBranch}}`, and re-running one
-- without them would post the template with blanks in it. The webhook payload is
-- long gone by then — this is the only place those facts survive.
ALTER TABLE "workflow_runs"
  ADD COLUMN IF NOT EXISTS "facts" jsonb;
--> statement-breakpoint
-- The sweep's only query: runs parked and now due. Partial, because the rows
-- that are due are a vanishing fraction of the table — every settled run keeps a
-- NULL `retry_after` forever, and indexing those would be most of the index.
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_retry_due"
  ON "workflow_runs" USING btree ("retry_after")
  WHERE "retry_after" IS NOT NULL;
