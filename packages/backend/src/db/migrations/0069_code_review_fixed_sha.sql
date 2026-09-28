-- The commit a fix run produced, recorded on each finding it addressed.
--
-- Without it a fixed finding simply left the list, so the app could not say what
-- had happened to it — only that it was gone, which reads the same as a finding
-- that went stale or one somebody dismissed. The sha is what turns "5 findings
-- are no longer here" into five links to the commit that dealt with them.
--
-- Nullable and empty-by-default on purpose: a fix run that completed without
-- pushing anything has no commit to name, and inventing one (the head it started
-- from, say) would claim a change that was never made.
ALTER TABLE pr_code_review_findings
  ADD COLUMN IF NOT EXISTS fixed_head_sha text;
