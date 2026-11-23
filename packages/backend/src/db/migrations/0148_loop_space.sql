-- A loop can put the sessions it starts in a team space (loop_space).
--
-- Null is Personal, which is what every loop did before this column. A
-- deleted space sets it back to null. A space that is archived or that the
-- owner left stays on the row: the run starts in Personal and writes why in
-- loop_runs.notice.
ALTER TABLE "loops" ADD COLUMN IF NOT EXISTS "space_id" text REFERENCES "spaces"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "loop_runs" ADD COLUMN IF NOT EXISTS "notice" text;
