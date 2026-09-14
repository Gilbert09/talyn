-- Unlink the pull requests a cloud run never opened.
--
-- `posthogCode/poller.ts` used to find "the PR this run opened" by running
-- `JSON.stringify` over the whole run AND the remote task record and taking the
-- first thing that looked like a PR URL. Both halves of that were wrong: the
-- task record carries the user's prompt, and the run carries the agent's
-- closing prose, which cites pull requests it merely read. So a task was filed
-- against whichever PR the agent happened to MENTION first.
--
-- It shows up worst on Loops, because a loop fires forever. A "Daily PR" loop
-- on PostHog/posthog put two of its runs against #99835 — authored by the user,
-- opened the day before, off a branch no loop had touched, already merged.
--
-- The read side is fixed (one structured field, `output.pr_url`). This is the
-- rows it already wrote.
--
-- WHY `type = 'code_writing'` IS THE WHOLE SAFETY ARGUMENT. Every path that
-- creates a task ALREADY knowing its PR — the merge-queue executor, the
-- auto-keep watcher, the workflow actions — creates a `pr_response`. A
-- `code_writing` task is a freeform prompt against a repo and is created with
-- `pull_request_id` NULL (`taskCreate.ts`), so any link on one can only have
-- come from the poller. Restricting to it is what keeps this from unlinking a
-- `pr_response` task, whose PR legitimately predates it by definition.
--
-- And the test itself is an impossibility, not a heuristic: a pull request that
-- was already open before the task existed is not one the task opened. Compared
-- against `last_summary ->> 'createdAt'`, GitHub's own timestamp — NOT
-- `pull_requests.created_at`, which is when Talyn first cached the row and can
-- postdate the PR by months. A row we only know through the poller's own
-- placeholder has that field stamped at link time, so it fails the test and is
-- left alone: this errs toward keeping a link, never toward inventing one.
WITH mislinked AS (
  SELECT t.id AS task_id, pr.id AS pr_id
  FROM "tasks" t
  JOIN "pull_requests" pr ON pr.id = t."pull_request_id"
  WHERE t."type" = 'code_writing'
    -- CASE rather than a WHERE conjunct: the planner may reorder AND operands,
    -- and an unparseable timestamp would then abort the migration instead of
    -- being skipped.
    AND CASE
          WHEN pr."last_summary" ->> 'createdAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'
            THEN (pr."last_summary" ->> 'createdAt')::timestamptz < t."created_at"
          ELSE false
        END
),
cleared_tasks AS (
  UPDATE "tasks" t
     SET "pull_request_id" = NULL,
         -- Both copies of the same claim. `pullRequest` is what the poller
         -- wrote on linking; `posthogPrUrl` is what the task detail renders.
         "metadata" = (t."metadata" - 'pullRequest') - 'posthogPrUrl',
         "updated_at" = now()
    FROM mislinked m
   WHERE t.id = m.task_id
  RETURNING t.id
)
-- The reverse pointer, which is not cosmetic: `pull_requests.task_id` is read
-- by the merge queue, the auto-keep watcher, prMonitor and the PR routes' "has
-- a task" filter. Only cleared where it still names the task we just unlinked —
-- a PR since claimed by a real task keeps its pointer.
UPDATE "pull_requests" pr
   SET "task_id" = NULL,
       "updated_at" = now()
  FROM mislinked m
 WHERE pr.id = m.pr_id
   AND pr."task_id" = m.task_id;
