-- Workspace memory: short notes that agents and people save, so a later session
-- knows what an earlier one learned. Each entry has a scope: the whole
-- workspace, one repository, or one thread (a workbench). Sessions get an index
-- of the entries in their scope (name, type, description) and read a body only
-- when they need it.
--
-- A forget sets `forgotten_at` and keeps the row, so a person can restore it.
-- The unique index holds only for live rows: a forgotten entry does not block a
-- new one with the same name.
--
-- Backend-pool-only: RLS on with NO policy and no talyn_backend grant. The
-- routes authorise with requireWorkspaceAccess first.
CREATE TABLE IF NOT EXISTS "workspace_memories" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "owner_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- 'workspace' | 'repository' | 'thread'.
  "scope" text NOT NULL,
  "repository_id" text REFERENCES "repositories"("id") ON DELETE CASCADE,
  "thread_id" text REFERENCES "workbenches"("id") ON DELETE CASCADE,
  -- 'user' | 'feedback' | 'project' | 'reference'.
  "type" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "body" text NOT NULL,
  "bytes" integer DEFAULT 0 NOT NULL,
  -- Who wrote it: {"kind":"user"}, {"kind":"session","workbenchId":...} or {"kind":"auto"}.
  "source" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "forgotten_at" timestamp with time zone,
  CONSTRAINT "workspace_memories_scope_target" CHECK (
    ("scope" = 'workspace' AND "repository_id" IS NULL AND "thread_id" IS NULL)
    OR ("scope" = 'repository' AND "repository_id" IS NOT NULL AND "thread_id" IS NULL)
    OR ("scope" = 'thread' AND "thread_id" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_memories_live_name"
  ON "workspace_memories" USING btree (
    "workspace_id", "scope", coalesce("repository_id", ''), coalesce("thread_id", ''), lower("name")
  )
  WHERE "forgotten_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_memories_workspace_live"
  ON "workspace_memories" USING btree ("workspace_id")
  WHERE "forgotten_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "workspace_memories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "workspace_memories" FROM PUBLIC, anon, authenticated;
