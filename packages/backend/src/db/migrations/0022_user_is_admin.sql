-- Admin flag on users. Gates the developer Debug panel (and its WS stream),
-- which exposes backend internals across ALL accounts — so in a multi-tenant
-- (hosted) deployment it must be limited to operators. Defaults to false;
-- granted either by a TALYN_ADMIN_EMAILS bootstrap at login or by hand.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean NOT NULL DEFAULT false;
