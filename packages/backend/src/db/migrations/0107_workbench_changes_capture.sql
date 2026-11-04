-- A stored copy of a session's changes, so a sleeping sandbox does not wake
-- to show them (see services/workbenches/changesCapture.ts).
--
-- The copy itself is in Talyn's storage, not in Postgres: a patch can be
-- megabytes, and WORKBENCH_COLUMNS ships on every list and poll. These two
-- small columns only say that a new copy exists, so a client can fetch it
-- again when the etag moves.
--
-- changes_at: when the newest stored copy was taken.
-- changes_etag: its etag (16 hex characters).
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "changes_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "changes_etag" text;
