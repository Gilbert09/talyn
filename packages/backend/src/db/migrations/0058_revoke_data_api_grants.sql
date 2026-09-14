-- PHASE 2 of the backend data boundary: the revocations.
--
-- Migration 0057 added the `talyn_backend` role and its grants and revoked
-- nothing, so the previous build could keep serving while it rolled out. This
-- removes the Data API roles' direct access to application tables.
--
-- SAFE TO APPLY because 0057 has already shipped and cut over: every replica
-- now runs a build whose owner scopes use `talyn_backend`. Checked before this
-- was written — Railway had exactly one active deployment (the 0057 build), and
-- the role plus all 17 rewritten policies were live in production.
--
-- If this ever has to be undone, the previous build cannot run without these
-- grants: re-run `docs/rollout/rollback_regrant_authenticated.sql` BEFORE
-- redeploying it. Drizzle has no down migrations.
--
-- Measured on production on 2026-09-14, AFTER phase 1:
--
--   role           tasks_select  bypassrls
--   anon           f             f
--   authenticated  t             f
--   service_role   f             t
--   talyn_backend  t             f
--
-- So `authenticated` is the only role this actually takes anything from. The
-- `anon` and PUBLIC clauses are kept because they cost nothing and another
-- deployment may differ. `service_role` is deliberately NOT revoked: it holds
-- no table grants here, and revoking what it does not have would only risk
-- breaking Supabase Studio and support tooling on a project where it does.
-- It does carry BYPASSRLS, so treat the service key as a production secret.
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
