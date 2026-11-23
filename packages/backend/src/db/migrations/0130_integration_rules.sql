-- Rules per integration: a workflow belongs to GitHub or to Slack.
--
-- One engine and one pair of tables serve both. A rule gains `integration`,
-- and a run records what it acted on as a SUBJECT (a pull request or a Slack
-- channel) rather than only as a pull request. Every existing row is a GitHub
-- rule, which is what the defaults say.
--
-- No grant or policy changes: the grants from 0052 and 0057 are on the
-- tables, so they cover the new columns, and the RLS policies key on
-- `workspace_id` / `workflow_id`, which do not change.
ALTER TABLE "workflows"
  ADD COLUMN IF NOT EXISTS "integration" text DEFAULT 'github' NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow_runs"
  ADD COLUMN IF NOT EXISTS "integration" text DEFAULT 'github' NOT NULL;
--> statement-breakpoint
-- What the run acted on, as a stable key: `pr:<owner/repo>#<number>` or
-- `slack:<team>:<channel>`. The per-hour rate cap counts runs per key.
--
-- Keyed on the repository and number, not on `pull_request_id`: most runs
-- have no PR row (a rule fires on PRs Talyn does not track), and the rate cap
-- counted by repository and number before this column existed.
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "subject_key" text;
--> statement-breakpoint
-- The subject as a person reads it: `owner/repo#12` or `#eng-bugs`.
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "subject_label" text;
--> statement-breakpoint
-- The session a `start_session` action started. SET NULL, like the task and
-- PR links: the record of what a rule did outlives the session it started.
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "workbench_id" text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_workbench_id_fkey'
  ) THEN
    ALTER TABLE "workflow_runs"
      ADD CONSTRAINT "workflow_runs_workbench_id_fkey" FOREIGN KEY ("workbench_id")
      REFERENCES "public"."workbenches"("id") ON DELETE set null;
  END IF;
END $$;
--> statement-breakpoint
-- A Slack run has no pull request. The other PR snapshot columns
-- (`pr_title`, `pr_url`, `pr_author`) keep NOT NULL: they default to '', which
-- a Slack run writes.
ALTER TABLE "workflow_runs" ALTER COLUMN "repo_full_name" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ALTER COLUMN "pr_number" DROP NOT NULL;
--> statement-breakpoint
UPDATE "workflow_runs"
  SET "subject_key" = 'pr:' || "repo_full_name" || '#' || "pr_number",
      "subject_label" = "repo_full_name" || '#' || "pr_number"
  WHERE "subject_key" IS NULL AND "repo_full_name" IS NOT NULL AND "pr_number" IS NOT NULL;
--> statement-breakpoint
-- The rate-cap query: "how many times has THIS rule run on THIS subject in the
-- last hour".
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_subject_at"
  ON "workflow_runs" USING btree ("workflow_id", "subject_key", "created_at");
--> statement-breakpoint
-- How a Slack event finds its rules: by team, among the enabled Slack rules
-- only, so the lookup never scans the GitHub rules.
CREATE INDEX IF NOT EXISTS "idx_workflows_slack_team"
  ON "workflows" USING btree ((conditions ->> 'slackTeamId'))
  WHERE "integration" = 'slack' AND "enabled";
