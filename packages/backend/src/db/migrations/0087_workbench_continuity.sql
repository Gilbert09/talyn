ALTER TABLE workbench_chats
  ADD COLUMN turn_parser jsonb,
  ADD COLUMN drain_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN backup_lease_until timestamptz,
  ADD COLUMN backup_retry_at timestamptz,
  ADD COLUMN backup_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN backup_token text;
--> statement-breakpoint
ALTER TABLE workbenches
  ADD COLUMN archive_retry_at timestamptz,
  ADD COLUMN restore_requested_at timestamptz;
--> statement-breakpoint
UPDATE workbenches SET archive_retry_at = archive_lease_until, archive_lease_until = NULL
WHERE archive_pending_at IS NOT NULL AND archive_failures > 0;
--> statement-breakpoint
CREATE INDEX idx_workbench_backup_due ON workbench_chats (backup_retry_at, updated_at)
WHERE agent_backup_pending;
--> statement-breakpoint
ALTER TABLE workbenches ADD COLUMN sandbox_generation text;
--> statement-breakpoint
ALTER TABLE workbench_script_runs ADD COLUMN sandbox_generation text;
--> statement-breakpoint
UPDATE workbench_script_runs SET sandbox_generation = sandbox_id;
--> statement-breakpoint
UPDATE workbenches SET sandbox_generation = sandbox_id WHERE sandbox_id IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION protect_pending_workbench_archive() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.archive_pending_at IS NOT NULL AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'The session archive is still pending';
  END IF;
  IF NEW.archive_pending_at IS NOT NULL AND NEW.status <> 'moving' THEN
    NEW.status := 'archived';
  END IF;
  RETURN NEW;
END $$;
