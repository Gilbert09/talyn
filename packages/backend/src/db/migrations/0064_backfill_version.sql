-- Version the history backfill, so changing WHAT it collects re-collects it.
--
-- The backfill records completion as a timestamp, and `hasBackfilled` reads it
-- as "this viewer is done". That was right while the collected shape was fixed
-- and became wrong the moment migration 0063 added team slugs: every viewer
-- already marked done keeps a history with no teams in it, the team-affinity
-- feature reads zero for all of them, and nothing anywhere says so. The model
-- simply gets quietly worse than it should be.
--
-- A timestamp cannot express "done, but to an older recipe". A version can.
-- `hasBackfilled` now compares against the current BACKFILL_VERSION, so adding
-- a field to the collected shape is a one-line bump that re-reads history for
-- everybody rather than a silent gap nobody notices.
--
-- Existing rows default to 0 — below the current version — which is what makes
-- them re-run on the next sweep and pick up their teams.
ALTER TABLE "review_rank_models"
  ADD COLUMN IF NOT EXISTS "backfill_version" integer NOT NULL DEFAULT 0;
