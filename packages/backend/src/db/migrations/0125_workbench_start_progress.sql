-- workbenches.start_progress: the step a sandbox start is on (sandbox, code,
-- setup), when it began, and this repository's median time for it. Written
-- only when the step changes, and cleared when the start ends. Git's live
-- percentage is not stored: it stays in the process that runs the clone.
ALTER TABLE workbenches ADD COLUMN start_progress jsonb;
