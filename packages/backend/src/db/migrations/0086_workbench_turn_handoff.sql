ALTER TABLE workbench_chats ADD COLUMN IF NOT EXISTS turn_owner text;
--> statement-breakpoint
ALTER TABLE workbench_chats ADD COLUMN IF NOT EXISTS turn_heartbeat_at timestamptz;
--> statement-breakpoint
ALTER TABLE workbench_chats ADD COLUMN IF NOT EXISTS turn_started_at timestamptz;
--> statement-breakpoint
ALTER TABLE workbench_chats ADD COLUMN IF NOT EXISTS turn_offset bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE workbench_chats ADD COLUMN IF NOT EXISTS turn_attempt integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE workbench_chats ADD COLUMN IF NOT EXISTS turn_message jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workbench_script_runs (
  id text PRIMARY KEY,
  workbench_id text NOT NULL REFERENCES workbenches(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  sandbox_id text NOT NULL,
  name text NOT NULL,
  generation text NOT NULL,
  owner text NOT NULL,
  heartbeat timestamptz NOT NULL DEFAULT now(),
  "offset" bigint NOT NULL DEFAULT 0,
  output text NOT NULL DEFAULT '',
  running boolean NOT NULL DEFAULT true,
  exit_code integer
);
--> statement-breakpoint
ALTER TABLE workbench_script_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON workbench_script_runs FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON workbench_script_runs TO talyn_backend;
--> statement-breakpoint
DROP POLICY IF EXISTS workbench_script_runs_workspace ON workbench_script_runs;
--> statement-breakpoint
CREATE POLICY workbench_script_runs_workspace ON workbench_script_runs FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()));
--> statement-breakpoint
ALTER TABLE workbench_chats ADD COLUMN IF NOT EXISTS agent_backup_pending boolean NOT NULL DEFAULT false;
