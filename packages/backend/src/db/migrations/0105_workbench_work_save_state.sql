-- Whether a session's work checkpoints work (incident of 2026-11-03).
--
-- A failed checkpoint was written only to the log and the debug bus, so
-- nothing a person could see said that the work was not saved. These columns
-- keep the last result on the row: the Sandbox panel and the MCP tool read
-- them, and the transcript notes a run of failures.
--
-- work_checked_at: when a save last confirmed that storage holds all of the
-- box's work (a new checkpoint, a check that found nothing new, or nothing to
-- save). work_checkpoint_at stays the time of the stored copy.
-- work_unpushed_commits: commits GitHub lacks, as the last save counted them.
-- work_save_failures: saves that failed in a row; 0 after one works.
--
-- workbench_script_runs.started_at: when the run started, so the panel can
-- say for how long the setup script has run. Null on older rows.
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "work_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "work_unpushed_commits" integer;
--> statement-breakpoint
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "work_save_failures" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "work_save_failed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "work_save_error" text;
--> statement-breakpoint
ALTER TABLE "workbench_script_runs" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;
