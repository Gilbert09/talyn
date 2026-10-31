-- Threads: a long conversation that is not tied to one repository. A thread is
-- a workbench row with kind 'thread'. It has no repository, so repository_id
-- becomes nullable and repo_full_name holds '' for a thread.
--
-- thread_id links a session to the thread that started it (or that a person
-- continued it in). ON DELETE SET NULL: deleting a thread keeps its sessions.
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'session' NOT NULL;
--> statement-breakpoint
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "thread_id" text REFERENCES "workbenches"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "workbenches" ALTER COLUMN "repository_id" DROP NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbenches_thread" ON "workbenches" USING btree ("thread_id") WHERE "thread_id" IS NOT NULL;
