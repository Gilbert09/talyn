-- automations_start_sessions (0144): schedules (loops) and rules (workflows) start
-- sessions only. No automation creates a cloud task.
--
-- Loops: every loop now starts a session. A session uses the workspace MCP
-- servers, so a per-loop selection (a cloud-task feature) is cleared. A loop
-- on PostHog Code cannot start a session, so it is turned off with a reason
-- the editor shows; the person picks a Talyn Fleet agent to turn it on again.
UPDATE "loops"
SET "enabled" = false,
    "next_run_at" = NULL,
    "disabled_reason" = 'environment_missing',
    "updated_at" = now()
WHERE "provider" <> 'selfhosted' AND "enabled";
--> statement-breakpoint
UPDATE "loops"
SET "target" = 'session',
    "mcp_server_ids" = NULL,
    "updated_at" = now()
WHERE "target" <> 'session' OR "mcp_server_ids" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "loops" ALTER COLUMN "target" SET DEFAULT 'session';
--> statement-breakpoint
ALTER TABLE "loop_runs" ALTER COLUMN "target" SET DEFAULT 'session';
--> statement-breakpoint
-- Workflows: `start_task` becomes `start_session` with the same fields, and
-- `run_prompt` (GitHub rules) becomes `start_session` on the PR's repository.
-- The backend also reads an old action this way (`workflowActionAsSession`).
UPDATE "workflows"
SET "actions" = (
      SELECT jsonb_agg(
               CASE
                 WHEN a ->> 'type' = 'start_task'
                   THEN jsonb_set(a, '{type}', '"start_session"')
                 WHEN a ->> 'type' = 'run_prompt'
                   THEN jsonb_set(a, '{type}', '"start_session"') || '{"repositoryId": null}'::jsonb
                 ELSE a
               END
               ORDER BY t.ord
             )
      FROM jsonb_array_elements("workflows"."actions") WITH ORDINALITY AS t(a, ord)
    ),
    "updated_at" = now()
WHERE jsonb_typeof("actions") = 'array'
  AND ("actions" @> '[{"type": "start_task"}]'::jsonb OR "actions" @> '[{"type": "run_prompt"}]'::jsonb);
