-- A session started from a pull request, or linked to one by hand, owns that
-- PR. The PR is older than the session and the session pushed none of its
-- commits, so `eligiblePr()` refuses it. The merge backfill then removed the
-- link at its next run (every 10 minutes).
--
-- `pull_request_link_explicit` marks a link that a person or a caller chose.
-- The backfill and the merge rules accept it without the evidence test.
ALTER TABLE workbenches ADD COLUMN pull_request_link_explicit boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- A write that changes the PR and does not set the flag is a heuristic link,
-- so the flag goes back to false. An unlink always clears it.
CREATE OR REPLACE FUNCTION stamp_workbench_pr_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.pull_request_id IS NOT NULL THEN NEW.pull_request_linked_at := clock_timestamp();
    ELSE NEW.pull_request_link_explicit := false;
    END IF;
  ELSIF NEW.pull_request_id IS DISTINCT FROM OLD.pull_request_id THEN
    NEW.pull_request_linked_at := CASE WHEN NEW.pull_request_id IS NULL THEN NULL ELSE clock_timestamp() END;
    NEW.settings := NEW.settings - 'archiveOnIdle';
    IF NEW.pull_request_id IS NULL OR NEW.pull_request_link_explicit IS NOT DISTINCT FROM OLD.pull_request_link_explicit THEN
      NEW.pull_request_link_explicit := false;
    END IF;
  END IF;
  RETURN NEW;
END $$;
