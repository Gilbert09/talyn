-- A loop can now start a reviewable session instead of a legacy cloud task.
-- Existing loops and history stay on `task`.
ALTER TABLE "loops" ADD COLUMN IF NOT EXISTS "target" text DEFAULT 'task' NOT NULL;
--> statement-breakpoint
ALTER TABLE "loop_runs" ADD COLUMN IF NOT EXISTS "target" text DEFAULT 'task' NOT NULL;
--> statement-breakpoint
ALTER TABLE "loop_runs" ADD COLUMN IF NOT EXISTS "workbench_id" text REFERENCES "workbenches"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "loop_runs" ADD COLUMN IF NOT EXISTS "workbench_chat_id" text REFERENCES "workbench_chats"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_loop_runs_workbench" ON "loop_runs" ("workbench_id") WHERE "workbench_id" IS NOT NULL;
