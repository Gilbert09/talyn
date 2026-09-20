-- Record WHEN a PR entered (and left) the viewer's review-requested cohort.
--
-- Nothing anywhere recorded this. `merge_queue_events` is the only temporal
-- history the schema has, and it only covers PRs somebody explicitly queued —
-- so "how long have I been sitting on this review" had no honest answer.
--
-- The Reviews tab's Priority sort was using `createdAt` as a stand-in, and it
-- lies in the direction that matters most: a three-week-old PR you were added
-- to an hour ago reads as three weeks of neglect, and it outranks the request
-- that has genuinely been waiting since Tuesday. Adding a reviewer to an old
-- PR is completely routine, so this is not an edge case.
--
-- Written ONLY on the transition, in `prMonitor.reconcileRelationshipFlags`:
-- `first_seen_at` on false->true and `cleared_at` on true->false. A true->true
-- tick must not touch either, or every PR would look brand new every thirty
-- seconds and the age signal would be identically zero for everybody.
--
-- `cleared_at` is not read by the sort — a cleared PR has left the cohort and
-- is no longer in the list. It is the OUTCOME half of the pair, and the only
-- record that a review actually happened: most reviews are submitted on
-- github.com, so the desktop never sees them. Together the two columns are
-- "asked at T, answered at T+n", which is what a ranking can later be measured
-- against and what the per-user model's label is built from.
ALTER TABLE "pull_requests"
  ADD COLUMN IF NOT EXISTS "review_requested_first_seen_at" timestamptz;

ALTER TABLE "pull_requests"
  ADD COLUMN IF NOT EXISTS "review_requested_cleared_at" timestamptz;

-- Seed the rows already in the cohort, or the age term is uniformly zero for
-- every existing PR until each one happens to be re-requested — which for a
-- standing request is never.
--
-- `least(last_polled_at, created_at)` is the honest floor rather than a guess:
-- the request cannot have arrived after we last looked at the row, and it
-- cannot predate the row existing. It over-states the wait for a PR that was
-- tracked long before the reviewer was added, which is the same direction
-- `created_at` already erred in, so no existing ordering gets worse.
UPDATE "pull_requests"
SET "review_requested_first_seen_at" = least("last_polled_at", "created_at")
WHERE "review_requested" = true
  AND "review_requested_first_seen_at" IS NULL;
