-- PHASE 2 of the backend data boundary. NOT a migration yet, on purpose.
--
-- Migration 0057 added the `talyn_backend` role and its grants, and revoked
-- nothing, so the old and the new build can serve at the same time. This
-- script removes the Data API roles' direct access to application tables.
--
-- WHEN TO APPLY
--
-- Only after every replica runs a build that uses `talyn_backend` — that is,
-- one full deploy after 0057 landed. The old build runs `set local role
-- authenticated` on every request, so applying this while one is still serving
-- gives that replica `permission denied` on every authenticated request.
--
-- HOW TO APPLY
--
-- Copy this file to `packages/backend/src/db/migrations/0058_revoke_data_api_grants.sql`,
-- add the entry to `meta/_journal.json`, and push. The next boot applies it.
-- Rolling it back means re-running `docs/rollout/rollback_regrant_authenticated.sql`.
--
-- CHECK FIRST — this must return no rows:
--
--   SELECT usename FROM pg_stat_activity
--   WHERE datname = current_database() AND backend_start < now() - interval '1 hour';
--
-- and confirm in Railway that only one deployment is active.

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
