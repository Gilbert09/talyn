-- Rework the PR relationship flags. `review_requested` now means "awaiting
-- MY review" — i.e. I'm a requested reviewer (incl. via a team) AND I have
-- not already reviewed it. The monitor reconciles this every poll, so an
-- approved PR drops off the Review list instead of lingering (GitHub keeps
-- team review requests on a PR even after you approve it).
--
-- "Mine" used to be derived as `NOT review_requested`, which broke once a
-- review-requested PR could flip its flag off while staying tracked. Add a
-- dedicated `authored` flag so the Mine tab keys off authorship directly,
-- independent of the review flag. The old individual-vs-team signal is no
-- longer needed.
ALTER TABLE "pull_requests" DROP COLUMN "explicitly_review_requested";
ALTER TABLE "pull_requests" ADD COLUMN "authored" boolean DEFAULT false NOT NULL;
