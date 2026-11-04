-- The time each learned setup step takes in the box setup (Tom, 2026-11-03:
-- "some of these setup script steps is taking forever").
--
-- The box setup prints each learned step's wall time on its result line.
-- last_duration_ms is the newest measurement, typical_duration_ms a rolling
-- mean (SETUP_STEP_TYPICAL_WEIGHT), and measured_boxes the box setups that
-- measured the step. A slow step needs a higher share of sessions to run on
-- every box (SETUP_STEP_SLOW_MS).
--
-- The times of the whole setup are one small record per repository, in
-- repositories.settings.setupTiming, so they need no column.
ALTER TABLE "repository_setup_steps" ADD COLUMN IF NOT EXISTS "last_duration_ms" integer;
--> statement-breakpoint
ALTER TABLE "repository_setup_steps" ADD COLUMN IF NOT EXISTS "typical_duration_ms" integer;
--> statement-breakpoint
ALTER TABLE "repository_setup_steps" ADD COLUMN IF NOT EXISTS "measured_boxes" integer DEFAULT 0 NOT NULL;
