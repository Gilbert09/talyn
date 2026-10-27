ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "memory_restore_pending" text;
--> statement-breakpoint
ALTER TABLE "workbench_chats" ADD COLUMN IF NOT EXISTS "recap_pending" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "workbench_chats" ADD COLUMN IF NOT EXISTS "agent_backup" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workbench_agent_backups" (
  "chat_id" text NOT NULL REFERENCES "workbench_chats"("id") ON DELETE CASCADE,
  "agent" text NOT NULL,
  "session_id" text NOT NULL,
  "seq" integer NOT NULL,
  "start_offset" bigint NOT NULL,
  "data" bytea NOT NULL,
  "byte_len" integer NOT NULL,
  "sha256" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("chat_id", "session_id", "seq")
);
--> statement-breakpoint
ALTER TABLE "workbench_agent_backups" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workbench_agent_backups" TO talyn_backend;
--> statement-breakpoint
CREATE POLICY "workbench_agent_backups_chat" ON "workbench_agent_backups" FOR ALL
  USING (chat_id IN (
    SELECT id FROM workbench_chats
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid())
  ))
  WITH CHECK (chat_id IN (
    SELECT id FROM workbench_chats
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid())
  ));
--> statement-breakpoint
-- This trigger also handles writes from the previous backend during deployment.
CREATE OR REPLACE FUNCTION clear_old_workbench_agent_backup() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.agent_session_id IS DISTINCT FROM NEW.agent_session_id THEN
    DELETE FROM workbench_agent_backups WHERE chat_id = OLD.id AND session_id = OLD.agent_session_id;
    NEW.agent_backup := NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER workbench_chat_session_backup_cleanup
  BEFORE UPDATE OF agent_session_id ON workbench_chats
  FOR EACH ROW EXECUTE FUNCTION clear_old_workbench_agent_backup();
--> statement-breakpoint
DO $$
BEGIN
  IF NOT has_table_privilege('talyn_backend', 'public.workbench_agent_backups', 'SELECT') THEN
    RAISE EXCEPTION 'talyn_backend did not receive SELECT on: public.workbench_agent_backups';
  END IF;
END $$;
