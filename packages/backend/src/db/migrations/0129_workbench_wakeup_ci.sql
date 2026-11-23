-- A session wake-up can wait for CI on the session's pull request. The row
-- keeps `wake_at` as the latest time it fires; the checks listener and the
-- background sweep fire it sooner when the checks on `ci_head_sha` settle,
-- the head moves, or the pull request closes. NULL on a timed wake-up.
ALTER TABLE workbench_wakeups ADD COLUMN ci_pull_request_id text;
ALTER TABLE workbench_wakeups ADD COLUMN ci_head_sha text;
ALTER TABLE workbench_wakeups ADD COLUMN ci_pr_head_at_schedule text;
CREATE INDEX IF NOT EXISTS idx_workbench_wakeups_ci ON workbench_wakeups (ci_pull_request_id)
  WHERE status = 'scheduled' AND ci_pull_request_id IS NOT NULL;
