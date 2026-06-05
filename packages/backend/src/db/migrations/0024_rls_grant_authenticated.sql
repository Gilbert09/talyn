-- RLS enforcement prerequisites.
--
-- The policies already exist and filter by `auth.uid()` (0002 for the owner /
-- workspace tables, 0013 for pull_requests). They were inert because the
-- backend connects as the privileged `postgres` role, which owns these tables
-- and therefore bypasses RLS.
--
-- Enforcement is switched on at runtime by `db/scope.ts`, which wraps each
-- user request in a transaction that does `SET LOCAL ROLE authenticated` +
-- injects the caller's id as the JWT `sub`. `authenticated` is a
-- non-privileged, non-owner role, so RLS applies to it — but only once it has
-- been granted table access. That's what this migration does.
--
-- Deliberately NO `FORCE ROW LEVEL SECURITY`: that would subject the table
-- owner (the `postgres` pool connection) to RLS too, which would break the
-- background pollers / PR monitor / user-upsert that legitimately run
-- cross-owner on the pool with no JWT claims set.

GRANT USAGE ON SCHEMA "public" TO "authenticated";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "users" TO "authenticated";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspaces" TO "authenticated";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "environments" TO "authenticated";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "repositories" TO "authenticated";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "integrations" TO "authenticated";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "tasks" TO "authenticated";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "pull_requests" TO "authenticated";
