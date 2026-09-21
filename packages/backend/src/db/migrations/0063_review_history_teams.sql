-- Which TEAMS asked the viewer for each review.
--
-- The requesting team is how people describe their own reviewing habits —
-- "I don't review for team hogql these days" — and nothing in the model
-- captured it. Path familiarity is only an indirect proxy: a team's work spills
-- across directories (an `mcp` fix and a `web-analytics` change requested by
-- the same team), and one directory can be shared by teams whose requests mean
-- very different things to the person receiving them.
--
-- The data was already being fetched and discarded. The backfill reads
-- `Team { combinedSlug }` off each ReviewRequestedEvent to decide whether the
-- request was direct, then kept only that boolean.
--
-- Backfilled as empty rather than NULL: a row written before this column
-- existed genuinely names no team, and the feature reads an empty list as "no
-- team affinity signal" rather than as a missing value to guess at.
ALTER TABLE "review_history"
  ADD COLUMN IF NOT EXISTS "teams" text[] NOT NULL DEFAULT '{}';
