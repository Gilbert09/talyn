-- Instructions a person writes in Talyn for one repository. They go to every
-- session on the repository, for the agents chosen: Claude gets
-- <repo>/CLAUDE.local.md and Codex gets <repo>/AGENTS.override.md, both kept
-- out of git (.git/info/exclude).
--
-- Its own table, not `repositories.settings`: the text is read on every turn
-- and the repositories row is read by the pollers.
--
-- A delete empties `body` and keeps the row. The next turn then knows to take
-- the files out of the box. A repository that never had instructions has no
-- row and its sessions pay nothing.
--
-- Backend-pool-only: RLS on with NO policy and no talyn_backend grant. The
-- routes authorise with requireRepositoryAccess first.
CREATE TABLE IF NOT EXISTS "repository_instructions" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "repository_id" text NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
  "body" text DEFAULT '' NOT NULL,
  -- 'claude' | 'codex' | 'both'.
  "agents" text DEFAULT 'both' NOT NULL,
  "bytes" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_repository_instructions_repository"
  ON "repository_instructions" USING btree ("repository_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_repository_instructions_workspace"
  ON "repository_instructions" USING btree ("workspace_id");
--> statement-breakpoint
ALTER TABLE "repository_instructions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "repository_instructions" FROM PUBLIC, anon, authenticated;
