-- A code-review unit waits for a free fleet runner, as a session's box does.
-- The wait records when it began, so one 30-minute bound holds also when a
-- restart resumes the wait on another instance.
ALTER TABLE "pr_code_review_runs" ADD COLUMN IF NOT EXISTS "capacity_wait_since" timestamp with time zone;
