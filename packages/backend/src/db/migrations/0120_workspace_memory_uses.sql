-- Which session or thread used which memory entry (Talyn memory, 0096).
--
-- A row per entry and session: `wrote` when the session saved or updated the
-- entry with talyn_memory_write, `read` when it read the body with
-- talyn_memory_read. The thread work panel lists the entries a thread used,
-- the most recent use first.
--
-- Backend-pool-only, like workspace_memories (0096): RLS on with NO policy and
-- no talyn_backend grant. Rows go with their entry and session (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS "workspace_memory_uses" (
	"memory_id" text NOT NULL REFERENCES "workspace_memories"("id") ON DELETE CASCADE,
	"workbench_id" text NOT NULL REFERENCES "workbenches"("id") ON DELETE CASCADE,
	"wrote" boolean DEFAULT false NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("memory_id", "workbench_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_memory_uses_workbench" ON "workspace_memory_uses" USING btree ("workbench_id", "last_used_at");
--> statement-breakpoint
ALTER TABLE "workspace_memory_uses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "workspace_memory_uses" FROM PUBLIC, anon, authenticated;
