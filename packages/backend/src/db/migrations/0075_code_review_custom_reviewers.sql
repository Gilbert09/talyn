-- The team's own reviewers that one review cycle ran.
--
-- A workspace can add its own review skills, and each one runs as a reviewer
-- next to Talyn's. Which of them apply is decided when a cycle starts, and the
-- answer is frozen here as `[{ lensKey, skillKey, name }]`. A cycle must finish
-- as the thing it started as, and a finding must keep its reviewer's name after
-- the skill is renamed or removed.
--
-- The skill's CONTENT is not stored. It would ride on every read of this row,
-- and it is read from the skill itself when a reviewer is dispatched.
--
-- Nullable. NULL is a cycle that started before this column existed, and it
-- runs Talyn's reviewers as before. An empty list is a cycle that ran none of
-- the team's own.
ALTER TABLE pr_code_reviews
  ADD COLUMN IF NOT EXISTS custom_reviewers jsonb;
