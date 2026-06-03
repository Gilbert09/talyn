-- Drop the per-repo local clone path. Cloud-only: tasks run on the provider's
-- sandbox, so there's no local working tree and no path to track.
ALTER TABLE "repositories" DROP COLUMN IF EXISTS "local_path";
