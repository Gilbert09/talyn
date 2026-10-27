ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "archive_pending_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "archive_lease_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "archive_failures" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workbenches_archive_pending_idx" ON "workbenches" ("archive_pending_at")
  WHERE "archive_pending_at" IS NOT NULL;
--> statement-breakpoint
-- Keep pending archives safe during writes from the previous backend.
CREATE OR REPLACE FUNCTION protect_pending_workbench_archive() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.archive_pending_at IS NOT NULL AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'The session archive is still pending';
  END IF;
  IF NEW.archive_pending_at IS NOT NULL AND NEW.status <> 'moving' THEN
    NEW.status := 'archived';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS workbench_archive_guard ON workbenches;
--> statement-breakpoint
CREATE TRIGGER workbench_archive_guard BEFORE UPDATE ON workbenches
  FOR EACH ROW EXECUTE FUNCTION protect_pending_workbench_archive();
