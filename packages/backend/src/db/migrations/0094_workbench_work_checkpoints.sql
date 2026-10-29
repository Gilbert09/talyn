-- The last checkpoint of a session's unsaved work. The bundle itself is in
-- Talyn's storage (bucket `workbench-work`), never in a git ref. A replacement
-- sandbox restores from it after a loss. The table keeps its grants:
-- backend-only, like every workbench column.
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "work_checkpoint_sha" text;
--> statement-breakpoint
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "work_checkpoint_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "work_checkpoint_bytes" integer;
