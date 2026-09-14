-- EMERGENCY ROLLBACK for the backend data boundary.
--
-- Run this when phase 2 has been applied and you must put the PREVIOUS build
-- back. That build runs `set local role authenticated` on every request, so it
-- needs the grants phase 2 removed. Drizzle has no down migrations, so this is
-- the only way back.
--
-- You do NOT need this to roll back a build that only has migration 0057
-- applied. 0057 revokes nothing, so the old build still works.
--
-- Connect as the migration/pool user (the owner of these tables) and run the
-- whole file. It is safe to re-run.
--
-- The grants below restore exactly what migrations 0024, 0025, 0029, 0033,
-- 0040, 0047, 0052 and 0054 gave `authenticated`, and nothing wider.

GRANT USAGE ON SCHEMA public TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.users, public.workspaces, public.environments, public.repositories,
  public.integrations, public.tasks, public.pull_requests, public.mcp_tokens,
  public.skills, public.skill_usage, public.merge_queue_entries,
  public.workflows, public.loops
TO authenticated;

GRANT SELECT, INSERT ON TABLE public.merge_queue_events TO authenticated;

GRANT USAGE, SELECT ON SEQUENCE public.merge_queue_events_id_seq TO authenticated;

GRANT SELECT, INSERT, DELETE ON TABLE public.posthog_oauth_states TO authenticated;

GRANT SELECT ON TABLE public.release_notes TO authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.workflow_runs, public.loop_runs TO authenticated;

-- Verify before you redeploy: this must return no rows.
--   SELECT t FROM unnest(ARRAY[
--     'public.users','public.workspaces','public.environments','public.repositories',
--     'public.integrations','public.tasks','public.pull_requests','public.mcp_tokens',
--     'public.skills','public.skill_usage','public.merge_queue_entries',
--     'public.workflows','public.loops','public.merge_queue_events',
--     'public.posthog_oauth_states','public.release_notes',
--     'public.workflow_runs','public.loop_runs'
--   ]) AS t
--   WHERE NOT has_table_privilege('authenticated', t, 'SELECT');
--
-- Leave the `talyn_backend` role in place. It is harmless to the old build,
-- and dropping it would force a re-grant when you roll forward again.
