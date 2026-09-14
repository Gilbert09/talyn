-- PHASE 1 of the backend data boundary: ADDITIVE ONLY.
--
-- This migration adds the `talyn_backend` role and grants it scoped access.
-- It revokes NOTHING, so a replica running the previous build (whose owner
-- scopes assume `authenticated`) keeps working while this one boots. That is
-- not a nicety: migrations run at backend boot and Railway's cutover overlaps
-- old and new deliberately, so a revoking migration would break the replica
-- still serving every request, with the health gate then pinning the broken
-- build in place if the new one failed to start.
--
-- PHASE 2 revokes the Data API roles' access. It must ship in a LATER deploy,
-- once no replica runs the old build. The script is
-- `docs/rollout/phase2_revoke_data_api_grants.sql` — copy it to a numbered
-- migration when the time comes. Until then the boundary is incomplete: the
-- backend uses the scoped role, but `anon`/`authenticated` still hold their
-- old grants.
--
-- Product clients use the backend API, not Supabase table access.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talyn_backend') THEN
    CREATE ROLE talyn_backend NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint
-- The migration connection is also the backend pool connection. Rotating
-- DATABASE_URL to a different user later breaks `set local role talyn_backend`
-- on every owner-scoped request — re-run this grant for the new user first.
GRANT talyn_backend TO CURRENT_USER;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles
    WHERE rolname IN ('authenticator', 'anon', 'authenticated', 'service_role')
  LOOP
    IF pg_has_role(api_role, 'talyn_backend', 'MEMBER') THEN
      RAISE EXCEPTION 'Data API role % must not inherit or assume talyn_backend', api_role;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, auth TO talyn_backend;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth.uid() TO talyn_backend;
--> statement-breakpoint
-- Prove the two `auth` grants actually landed.
--
-- On Supabase the `auth` schema belongs to `supabase_auth_admin`. A grantor
-- that is not the owner and holds no grant option gets a WARNING, not an
-- error — so the migration would commit "successfully" and every RLS policy
-- (all of them call `auth.uid()`) would then fail at runtime under the new
-- role. Failing here instead rolls the whole migration back and refuses to
-- boot, which leaves the previous build serving.
DO $$
BEGIN
  IF NOT has_schema_privilege('talyn_backend', 'auth', 'USAGE') THEN
    RAISE EXCEPTION
      'talyn_backend lacks USAGE on schema auth. Grant it as the schema owner '
      '(supabase_auth_admin) before deploying: GRANT USAGE ON SCHEMA auth TO talyn_backend;';
  END IF;
  IF NOT has_function_privilege('talyn_backend', 'auth.uid()', 'EXECUTE') THEN
    RAISE EXCEPTION
      'talyn_backend lacks EXECUTE on auth.uid(). Grant it as the schema owner '
      '(supabase_auth_admin): GRANT EXECUTE ON FUNCTION auth.uid() TO talyn_backend;';
  END IF;
END $$;
--> statement-breakpoint
-- Preserve only the explicit grants from 0024, 0025, 0029, 0033, 0040,
-- 0047, 0052 and 0054. Do not copy Supabase's broader default grants.
-- All existing owner policies target PUBLIC and still use auth.uid().
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.users, public.workspaces, public.environments, public.repositories,
  public.integrations, public.tasks, public.pull_requests, public.mcp_tokens,
  public.skills, public.skill_usage, public.merge_queue_entries,
  public.workflows, public.loops
TO talyn_backend;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.merge_queue_events TO talyn_backend;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE public.merge_queue_events_id_seq TO talyn_backend;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE public.posthog_oauth_states TO talyn_backend;
--> statement-breakpoint
GRANT SELECT ON TABLE public.release_notes TO talyn_backend;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.workflow_runs, public.loop_runs TO talyn_backend;
--> statement-breakpoint
-- Prove the table grants landed too, for the same reason as the auth check:
-- a grant that silently did nothing must not read as a successful migration.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing FROM unnest(ARRAY[
    'public.users', 'public.workspaces', 'public.environments', 'public.repositories',
    'public.integrations', 'public.tasks', 'public.pull_requests', 'public.mcp_tokens',
    'public.skills', 'public.skill_usage', 'public.merge_queue_entries',
    'public.workflows', 'public.loops', 'public.merge_queue_events',
    'public.posthog_oauth_states', 'public.release_notes',
    'public.workflow_runs', 'public.loop_runs'
  ]) AS t
  WHERE NOT has_table_privilege('talyn_backend', t, 'SELECT');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'talyn_backend did not receive SELECT on: %', missing;
  END IF;
END $$;
