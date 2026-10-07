-- When a finding was written onto the pull request, and in which GitHub review.
--
-- Findings live in the app. "Post to PR" copies them to GitHub as one review, and
-- these two columns are what stops a second press from writing the same comment
-- twice: a finding with `posted_at` set is never posted again.
--
-- Both are nullable and stay set for the life of the row. A later cycle can
-- re-open a finding, and the comment it left on the pull request is still there.
ALTER TABLE pr_code_review_findings
  ADD COLUMN IF NOT EXISTS posted_at timestamptz;
--> statement-breakpoint
ALTER TABLE pr_code_review_findings
  ADD COLUMN IF NOT EXISTS posted_review_id text;
