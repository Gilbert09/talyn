-- RUN THIS AFTER DEPLOYING the loop tenant-isolation fix.
--
-- Task creation used to allow a loop run to point at a task in another
-- workspace. The new settlement paths join on workspace, so such a row can
-- never be settled — and the overlap probe used to count it as in flight, which
-- made the loop skip every future firing with nothing visible in its history.
--
-- The probe now uses the same join, so a NEW mismatch cannot deadlock a loop.
-- Rows that already exist still sit at `queued`/`running` forever. This script
-- settles them so the loop rows stop being ambiguous.
--
-- Step 1 — look before you write. Expect zero rows on a healthy database.

SELECT r.id AS run_id, r.loop_id, r.status,
       r.workspace_id AS run_workspace, l.workspace_id AS loop_workspace,
       t.workspace_id AS task_workspace, r.created_at
FROM loop_runs r
JOIN loops l ON l.id = r.loop_id
LEFT JOIN tasks t ON t.id = r.task_id
WHERE r.status IN ('queued', 'running', 'waiting_slot')
  AND (r.workspace_id IS DISTINCT FROM l.workspace_id
    OR (r.task_id IS NOT NULL AND t.workspace_id IS DISTINCT FROM l.workspace_id))
ORDER BY r.created_at;

-- Step 2 — settle them. Run inside a transaction and check the row count
-- against step 1 before committing.
--
-- `dispatch_lost` is the existing failure code for "claimed but never started",
-- which is exactly what these rows are. It already has a UI label; a new code
-- would render as a blank reason in the loop history.
--
-- BEGIN;
--
-- UPDATE loop_runs r
-- SET status = 'failed',
--     failure_code = 'dispatch_lost',
--     error = 'Run linked across workspaces before the tenant-isolation fix; settled by operator.',
--     settled_at = now()
-- FROM loops l
-- LEFT JOIN tasks t ON t.id = r.task_id
-- WHERE l.id = r.loop_id
--   AND r.status IN ('queued', 'running', 'waiting_slot')
--   AND (r.workspace_id IS DISTINCT FROM l.workspace_id
--     OR (r.task_id IS NOT NULL AND t.workspace_id IS DISTINCT FROM l.workspace_id));
--
-- COMMIT;
--
-- The affected loops fire normally from their next scheduled occurrence.
-- Nothing has to be re-run by hand: a loop run is one occurrence, and the next
-- one is claimed on its own schedule.
