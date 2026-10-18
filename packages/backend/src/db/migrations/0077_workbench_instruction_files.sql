-- Instruction files from the user's own machine (~/.claude/CLAUDE.md, rules,
-- ~/.codex/AGENTS.md, a repo's CLAUDE.local.md), copied into a sandbox
-- session before each turn. See docs/WORKBENCHES.md.
--
-- The content lives ONLY here. Not in `workspaces.settings`, which every
-- workspace read ships, and the list route never selects it.
CREATE TABLE IF NOT EXISTS "workbench_instruction_files" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  -- 'claude-user' | 'codex-user' | 'claude-rule:<path>' | 'claude-local:<owner/repo>'.
  "key" text NOT NULL,
  -- 'claude' | 'codex'. Derived from the key.
  "agent" text NOT NULL,
  -- 'user' | 'repo'.
  "target" text NOT NULL,
  "repo_full_name" text,
  -- Where the file is on the user's machine, with `~`. For display only.
  "source_path" text NOT NULL,
  -- Imports already inlined. Empty while the file is switched off.
  "content" text DEFAULT '' NOT NULL,
  "content_hash" text DEFAULT '' NOT NULL,
  "bytes" integer DEFAULT 0 NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workbench_instruction_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id")
    REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workbench_instruction_files_workspace_key"
  ON "workbench_instruction_files" USING btree ("workspace_id", "key");
--> statement-breakpoint
ALTER TABLE "workbench_instruction_files" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workbench_instruction_files" TO talyn_backend;
--> statement-breakpoint
CREATE POLICY "workbench_instruction_files_workspace" ON "workbench_instruction_files" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()));
--> statement-breakpoint
DO $$
BEGIN
  IF NOT has_table_privilege('talyn_backend', 'public.workbench_instruction_files', 'SELECT') THEN
    RAISE EXCEPTION 'talyn_backend did not receive SELECT on: public.workbench_instruction_files';
  END IF;
END $$;
