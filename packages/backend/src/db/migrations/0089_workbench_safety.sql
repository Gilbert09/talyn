ALTER TABLE workbenches ADD COLUMN pull_request_linked_at timestamptz;
ALTER TABLE workbenches ADD COLUMN pushed_head_shas text[] NOT NULL DEFAULT '{}';
ALTER TABLE workbenches ADD COLUMN allocated_branch boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNIQUE INDEX uq_workbenches_allocated_branch ON workbenches (workspace_id, branch) WHERE allocated_branch;
--> statement-breakpoint
-- Use the last write only when it proves that the link existed before the merge.
UPDATE workbenches w SET pull_request_linked_at = w.updated_at
FROM pull_requests p WHERE p.id = w.pull_request_id
  AND (p.state = 'open' OR w.updated_at < p.merged_at);
--> statement-breakpoint
CREATE FUNCTION stamp_workbench_pr_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.pull_request_id IS NOT NULL THEN NEW.pull_request_linked_at := clock_timestamp(); END IF;
  ELSIF NEW.pull_request_id IS DISTINCT FROM OLD.pull_request_id THEN
    NEW.pull_request_linked_at := CASE WHEN NEW.pull_request_id IS NULL THEN NULL ELSE clock_timestamp() END;
    NEW.settings := NEW.settings - 'archiveOnIdle';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER z_workbench_pr_link BEFORE INSERT OR UPDATE ON workbenches
FOR EACH ROW EXECUTE FUNCTION stamp_workbench_pr_link();
--> statement-breakpoint
CREATE TABLE workbench_maintenance_claims (name text PRIMARY KEY, token text NOT NULL, expires_at timestamptz NOT NULL);
ALTER TABLE workbench_maintenance_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON workbench_maintenance_claims FROM PUBLIC, anon, authenticated;
-- Backend-only and read on the pool (maintenanceClaim.ts), like the team tables: RLS on, no policy, no talyn_backend grant.
