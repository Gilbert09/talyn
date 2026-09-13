-- Drain old replicas before this migration. Their owner scopes use authenticated
-- and will fail after these revocations. Start the new backend after migration.
-- Product clients use the backend API, not Supabase table access.
CREATE ROLE talyn_backend NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
--> statement-breakpoint
-- The migration connection is also the backend pool connection.
GRANT talyn_backend TO CURRENT_USER;
--> statement-breakpoint
DO $$
DECLARE
  api_role text;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles
    WHERE rolname IN ('authenticator', 'anon', 'authenticated')
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
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
-- Table revocation does not remove independent column grants.
DO $$
DECLARE
  col record;
BEGIN
  FOR col IN
    SELECT c.relname, a.attname FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attacl IS NOT NULL
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%I) ON TABLE public.%I FROM PUBLIC, anon, authenticated',
      col.attname, col.relname
    );
  END LOOP;
END $$;
--> statement-breakpoint
-- Defaults belong to the object creator. These cover the migration/pool role.
-- Remove global defaults too: schema defaults cannot cancel a global grant.
-- Future migrations must grant to talyn_backend explicitly, never Data API roles.
-- Keep pool-only tables ungranted. Other object creators need the same defaults.
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
