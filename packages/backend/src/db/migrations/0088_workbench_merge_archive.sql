CREATE INDEX IF NOT EXISTS "idx_pull_requests_repo_number"
  ON "pull_requests" (lower("owner"), lower("repo"), "number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbenches_archive_on_idle"
  ON "workbenches" ("id")
  WHERE "archived_at" IS NULL AND "settings" ->> 'archiveOnIdle' IS NOT NULL;
--> statement-breakpoint
-- An older backend must not start queued work after a merge.
CREATE OR REPLACE FUNCTION protect_workbench_merge_archive() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE pending boolean;
BEGIN
  IF NEW.status = 'running' AND (OLD.status <> 'running' OR NEW.turn_count > OLD.turn_count) THEN
    SELECT settings ->> 'archiveOnIdle' IS NOT NULL INTO pending
      FROM workbenches WHERE id = NEW.workbench_id FOR SHARE;
    IF pending THEN
      RAISE EXCEPTION 'The session will archive when its current turns finish';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER workbench_merge_archive_guard BEFORE UPDATE ON workbench_chats
  FOR EACH ROW EXECUTE FUNCTION protect_workbench_merge_archive();
--> statement-breakpoint
-- Preserve server markers when an overlapping backend writes stale settings.
CREATE OR REPLACE FUNCTION preserve_workbench_merge_archive() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.settings ->> 'archiveOnIdle' IS NOT NULL AND NEW.archived_at IS NULL THEN
    NEW.settings := NEW.settings || jsonb_build_object('archiveOnIdle', OLD.settings -> 'archiveOnIdle');
  END IF;
  IF OLD.settings ? 'autoArchivedForPr'
    AND (NEW.archived_at IS NULL OR NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at) THEN
    NEW.settings := NEW.settings || jsonb_build_object('autoArchivedForPr', OLD.settings -> 'autoArchivedForPr');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER workbench_merge_archive_settings_guard BEFORE UPDATE ON workbenches
  FOR EACH ROW EXECUTE FUNCTION preserve_workbench_merge_archive();
