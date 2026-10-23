-- The reverse link: "which live session is working this pull request". The
-- pull-request list reads it for every row it returns, and background fix runs
-- read it before they dispatch.
CREATE INDEX IF NOT EXISTS "idx_workbenches_pull_request"
  ON "workbenches" ("pull_request_id")
  WHERE "archived_at" IS NULL;
