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
GRANT USAGE ON SCHEMA public TO talyn_backend;
--> statement-breakpoint
-- The owner id, without depending on schema `auth`.
--
-- The policies were written against `auth.uid()`, which no new role can reach
-- on Supabase: `auth` belongs to `supabase_auth_admin`, and the role the
-- backend connects as holds USAGE on it WITHOUT grant option and is not a
-- member of the owner. So it cannot pass that access on — a `GRANT USAGE ON
-- SCHEMA auth` from it raises a WARNING and grants nothing, which would leave
-- this migration committed and every owner-scoped query failing at runtime.
--
-- `auth.uid()` is not privileged machinery, though: it reads two GUCs that
-- `withOwnerScope` sets itself. This is the same read, in a schema we own.
-- Returning text rather than uuid keeps it usable by the policies as written
-- (they all cast to text) without forcing every owner id to parse as a uuid.
CREATE OR REPLACE FUNCTION public.talyn_uid() RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )
$fn$;
--> statement-breakpoint
-- `authenticated` and `anon` need it too: the policies below are rewritten in
-- place, and the PREVIOUS build is still serving requests under those roles.
-- Granted per role that exists, so this also applies to a plain Postgres with
-- no Supabase roles at all.
DO $$
DECLARE
  grantee text;
BEGIN
  FOR grantee IN SELECT rolname FROM pg_roles
    WHERE rolname IN ('talyn_backend', 'anon', 'authenticated', 'service_role')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.talyn_uid() TO %I', grantee);
  END LOOP;
END $$;
--> statement-breakpoint
-- Prove the replacement agrees with what it replaces, on THIS database, before
-- anything depends on it.
DO $$
DECLARE
  sample constant text := '00000000-0000-0000-0000-0000000000ab';
  theirs text;
  ours text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', sample, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', sample)::text, true);
  BEGIN
    EXECUTE 'SELECT (auth.uid())::text' INTO theirs;
  EXCEPTION WHEN undefined_function OR invalid_schema_name OR insufficient_privilege THEN
    -- No `auth` schema to compare against (a bare Postgres). Nothing to check.
    RETURN;
  END;
  SELECT public.talyn_uid() INTO ours;
  -- Put the claim GUCs back. They are transaction-local, but this migration
  -- shares its transaction with everything below, and a stale sub would
  -- silently shadow the real owner in any later check.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  IF theirs IS DISTINCT FROM ours THEN
    RAISE EXCEPTION 'public.talyn_uid() = % but auth.uid()::text = % — the owner id would change meaning', ours, theirs;
  END IF;
END $$;
--> statement-breakpoint
-- Repoint every policy at it. All of them are TO PUBLIC, so they bind every
-- role — including the previous build's `authenticated` and the new
-- `talyn_backend` — and the rewrite is a straight substitution inside the
-- expressions Postgres already parsed.
DO $$
DECLARE
  p record;
  new_qual text;
  new_check text;
BEGIN
  FOR p IN
    SELECT tablename, policyname, qual, with_check FROM pg_policies
    WHERE schemaname = 'public'
      AND (COALESCE(qual, '') LIKE '%auth.uid()%' OR COALESCE(with_check, '') LIKE '%auth.uid()%')
  LOOP
    new_qual := replace(COALESCE(p.qual, ''), 'auth.uid()', 'public.talyn_uid()');
    new_check := replace(COALESCE(p.with_check, ''), 'auth.uid()', 'public.talyn_uid()');
    IF p.qual IS NOT NULL AND p.with_check IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON public.%I USING (%s) WITH CHECK (%s)',
        p.policyname, p.tablename, new_qual, new_check);
    ELSIF p.qual IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON public.%I USING (%s)', p.policyname, p.tablename, new_qual);
    ELSE
      EXECUTE format('ALTER POLICY %I ON public.%I WITH CHECK (%s)', p.policyname, p.tablename, new_check);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  remaining int;
BEGIN
  SELECT count(*) INTO remaining FROM pg_policies
  WHERE schemaname = 'public'
    AND (COALESCE(qual, '') LIKE '%auth.uid()%' OR COALESCE(with_check, '') LIKE '%auth.uid()%');
  IF remaining > 0 THEN
    RAISE EXCEPTION '% policies still call auth.uid(), which talyn_backend cannot reach', remaining;
  END IF;
END $$;
--> statement-breakpoint
-- Preserve only the explicit grants from 0024, 0025, 0029, 0033, 0040,
-- 0047, 0052 and 0054. Do not copy Supabase's broader default grants.
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
-- Prove the table grants landed. A grant that silently did nothing must not
-- read as a successful migration — that is exactly how the `auth` grants
-- above would have failed, had they stayed.
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
  IF NOT has_function_privilege('talyn_backend', 'public.talyn_uid()', 'EXECUTE') THEN
    RAISE EXCEPTION 'talyn_backend cannot execute public.talyn_uid(); every policy would fail';
  END IF;
END $$;
