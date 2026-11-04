-- The setup recipe (0099) learns from more than one session, and a step that
-- fails on boxes stops running.
--
-- session_count and repository_setup_step_sessions: the different sessions
-- that recorded a step. A step that one session needed runs on new boxes only
-- after a second session needed it too (SETUP_STEP_MIN_SESSIONS). confirmed_at
-- is when that happened; null means the step waits and does not run.
--
-- Existing steps keep running: they get confirmed_at = first_seen_at and their
-- first session as their one session. Only new steps wait.
--
-- box_failure_count, box_last_failure, box_disabled_*: the box setup reports
-- each learned step's exit code. A failure adds one, a success sets the count
-- to 0, and SETUP_STEP_MAX_BOX_FAILURES failures in a row stop the step in the
-- box setup and the bake.
--
-- repository_setup_step_sessions is backend-pool-only, like
-- repository_setup_steps: RLS on with NO policy and no talyn_backend grant.
ALTER TABLE "repository_setup_steps" ADD COLUMN IF NOT EXISTS "session_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "repository_setup_steps" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "repository_setup_steps" ADD COLUMN IF NOT EXISTS "box_failure_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "repository_setup_steps" ADD COLUMN IF NOT EXISTS "box_last_failure" text;
--> statement-breakpoint
ALTER TABLE "repository_setup_steps" ADD COLUMN IF NOT EXISTS "box_disabled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "repository_setup_steps" ADD COLUMN IF NOT EXISTS "box_disabled_reason" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repository_setup_step_sessions" (
	"step_id" text NOT NULL REFERENCES "repository_setup_steps"("id") ON DELETE CASCADE,
	-- No foreign key: the count stays when the session is deleted.
	"workbench_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repository_setup_step_sessions_pkey" PRIMARY KEY ("step_id", "workbench_id")
);
--> statement-breakpoint
INSERT INTO "repository_setup_step_sessions" ("step_id", "workbench_id", "seen_at")
SELECT "id", "source_workbench_id", "first_seen_at" FROM "repository_setup_steps" WHERE "source_workbench_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "repository_setup_steps"
SET "confirmed_at" = "first_seen_at",
	"session_count" = CASE WHEN "source_workbench_id" IS NULL THEN 0 ELSE 1 END
WHERE "confirmed_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "repository_setup_step_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "repository_setup_step_sessions" FROM PUBLIC, anon, authenticated;
