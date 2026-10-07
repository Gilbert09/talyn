-- Why a review unit failed, and whether it moved to another agent.
--
-- `failure_detail` holds the provider's own error sentence for a unit whose run
-- failed. Before this column a run the vendor refused looked the same as an
-- agent that wrote nothing, and the vendor's sentence was thrown away.
--
-- `failed_over_from` names the fleet agent a unit moved away from, after that
-- agent reported a usage limit or a spent subscription. A unit moves one time
-- only, and this column is what stops a second move.
--
-- Both are nullable. A unit that ran normally has neither.
ALTER TABLE pr_code_review_runs
  ADD COLUMN IF NOT EXISTS failure_detail text;
--> statement-breakpoint
ALTER TABLE pr_code_review_runs
  ADD COLUMN IF NOT EXISTS failed_over_from text;
