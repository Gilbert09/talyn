CREATE OR REPLACE FUNCTION preserve_workbench_merge_archive() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.settings ->> 'archiveOnIdle' IS NOT NULL AND NEW.archived_at IS NULL
    AND EXISTS (SELECT 1 FROM workspaces ws WHERE ws.id = NEW.workspace_id
      AND (ws.settings ->> 'autoArchiveOnMerge') IS DISTINCT FROM 'false') THEN
    NEW.settings := NEW.settings || jsonb_build_object('archiveOnIdle', OLD.settings -> 'archiveOnIdle');
  END IF;
  IF OLD.settings ? 'autoArchivedForPr'
    AND (NEW.archived_at IS NULL OR NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at) THEN
    NEW.settings := NEW.settings || jsonb_build_object('autoArchivedForPr', OLD.settings -> 'autoArchivedForPr');
  END IF;
  RETURN NEW;
END $$;
