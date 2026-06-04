-- Per-PR "auto-keep mergeable" watcher. When enabled, a background watcher
-- repeatedly fires a cloud "take this PR to a clean, mergeable state" run
-- whenever the PR has a blocker (conflicts / failing CI / requested changes /
-- unresolved review threads) and no run is already in flight — keeping the PR
-- mergeable indefinitely (including conflicts that appear days later).
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "auto_keep_mergeable" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Watcher bookkeeping for the runaway guard:
--   { attempts, lastAutoTaskId, accounted, pausedAt }
-- `attempts` counts consecutive completed auto-runs that left the PR
-- un-mergeable; it resets to 0 once the PR is observed mergeable. The watcher
-- pauses after 3 and re-arms on the next clean observation.
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "auto_merge_state" jsonb;
--> statement-breakpoint
-- Hot path: the watcher scans only enabled PRs each tick.
CREATE INDEX IF NOT EXISTS "idx_pr_auto_keep" ON "pull_requests" ("workspace_id") WHERE "auto_keep_mergeable" = true;
