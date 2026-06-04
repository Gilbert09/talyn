-- FastOwl-orchestrated merge queue. When a PR is queued, the merge-queue
-- processor merges it (squash by default) as soon as it's clean. PRs targeting
-- the same (repo, base branch) merge strictly one-at-a-time; different bases /
-- repos proceed in parallel. On conflict / behind / blocked it fires the same
-- "take this PR to a clean, mergeable state" cloud run the auto-keep-mergeable
-- watcher uses (which merges the base branch in), waits, then merges. The PR
-- drops off the queue once merged.
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "merge_queued" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- FIFO ordering within a (repo, base) group: oldest queued first. NULL when not
-- queued. Ordering by this timestamp rather than an explicit position means
-- add / remove / drop-on-merge never has to renumber siblings.
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "merge_queued_at" timestamp with time zone;
--> statement-breakpoint
-- Merge method to use when this PR's turn comes ('merge' | 'squash' | 'rebase').
-- Defaults to squash to match the manual merge route.
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "merge_method" text NOT NULL DEFAULT 'squash';
--> statement-breakpoint
-- Processor bookkeeping:
--   { attempts, lastFixTaskId, accounted, status, lastError, lastErrorAt }
-- `attempts` counts consecutive completed fix-runs that left the PR
-- un-mergeable; `status` is the coarse state the desktop renders
-- ('waiting' | 'fixing' | 'merging' | 'blocked').
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "merge_queue_state" jsonb;
--> statement-breakpoint
-- Hot path: the processor scans only queued PRs each tick.
CREATE INDEX IF NOT EXISTS "idx_pr_merge_queued" ON "pull_requests" ("workspace_id") WHERE "merge_queued" = true;
