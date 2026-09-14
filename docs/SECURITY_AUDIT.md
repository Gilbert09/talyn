# Backend Security Review

Date: 2026-09-12. Review base: `997a442002f1ce48532f202c7e04cabdfd23798d`.
Integrated and re-verified against `2cf9ed70b1732162e98447bf581527b62ef533c0`.

This review found and corrected authorization defects. It does not certify that Talyn has no vulnerabilities.
The review used source tracing, local fixtures, database tests, and mocked external services.
It did not access production data, credentials, or infrastructure.

## Scope

- REST route mounting, JWT verification, owner scoping, and database row-level security.
- Workspaces, repositories, tasks, pull requests, environments, skills, workflows, and newly merged Loops.
- GitHub credentials, installation callbacks, repository access, webhooks, and background processing.
- Cloud dispatch, remote task associations, transcript retrieval, cancellation, and credential restoration.
- PostHog destinations, OAuth request handling, encrypted credentials, and error responses.
- WebSocket authentication, subscriptions, broadcasts, admin access, and MCP tokens.
- External queue evidence and installed backend runtime dependencies.

## Implemented Controls

| Area | Control |
| --- | --- |
| Database boundary | The backend uses a dedicated non-login role with owner policies, filtering on `public.talyn_uid()` rather than the unreachable `auth.uid()`. Phase 2 removes `authenticated`'s access to application tables. |
| GitHub authorization | Workspace operations use user credentials, never globally selected installation credentials. |
| Credential freshness | Database state controls access. Conditional rotation cannot overwrite replacement or revoked credentials. |
| Diagnostics | Rate-account identifiers use a digest instead of a token when the login is unknown. |
| Installation callbacks | Installation hints require user-authorized discovery. Expiry is checked during state redemption. |
| Repository access | Registration and webhook recipients require current repository access. Cross-workspace response sharing is removed. |
| Task relationships | Creation, dispatch, and result linking reject foreign repository and PR references. |
| Loop history | History joins and settlement require matching task and loop workspaces, including historical records. |
| Task metadata | Public PATCH accepts only supported dispatch settings. Remote identifiers remain server-controlled. |
| Fleet operations | Transcript retrieval and cancellation require a matching remote workspace. Credential delivery uses verified GitHub credentials. |
| Skills | Repository authorization precedes every cache lookup, including stale fallback. |
| PostHog requests | Exact trusted HTTPS origins, redirect refusal, and upstream error-body redaction. |
| WebSockets | Token deadlines, current authorization, one pending handshake, bounded queues, and connection limits. |
| Client recovery | Temporary token failures retain reconnect retries. Explicit logout cancels pending work. |
| Admin and MCP | Admin bootstrap no longer reverses revocation. MCP and internal impersonation enforce the account allowlist. |
| Queue evidence | Exact bot identity is required. GitHub must confirm external claims of a completed merge. |
| Dependencies | Runtime updates and a scoped Express `qs` override resolve the reported backend advisories. |

## Verification

- 1,856 backend tests passed across 72 selected files, including row-level security and two-tenant regressions.
- 21 web heartbeat and connection tests passed after combining the client changes with main.
- Repository access caching and refresh-failure classification are covered by their own suites.
- `npm run typecheck` passed for all configured packages and applications.
- ESLint passed for changed and new TypeScript files, without warnings.
- `npm audit --omit=dev --workspace=@talyn/backend` reported zero vulnerabilities.
- `git diff --check` passed.

The complete package suites were not run locally. CI supplies the full cross-platform checks.
A clean dependency scan covers published advisories only. It does not prove that each reachable path is safe.

## Rollout Requirements

**This deploys as an ordinary push.** Migration 0057 is additive: it creates the
`talyn_backend` role and grants it scoped access, and it revokes nothing. A
replica running the previous build keeps working while the new one boots.

That shape is deliberate. Migrations run at backend boot and Railway's cutover
overlaps old and new on purpose, so a revoking migration would break the replica
still serving every request — and the health gate would then pin the broken
build in place if the new one failed to start. An earlier draft of this change
asked the operator to drain the old replicas first. No step in this pipeline can
do that, so the requirement was removed rather than documented.

The boundary therefore lands in two phases.

### Phase 1 — this deploy

1. Push. Migration 0057 runs at boot, grants `talyn_backend` its access, and
   repoints every RLS policy at `public.talyn_uid()`. It FAILS LOUDLY and
   refuses to boot if a grant did not land or a policy was left behind — see
   "Why the policies moved off `auth.uid()`" below. Verified against production
   in a rolled-back transaction before merge.
2. Before the deploy, run `docs/rollout/find_posthog_hosts.sql`. Set
   `POSTHOG_ALLOWED_ORIGINS` for every host it lists. The allowlist accepts
   `us.posthog.com`, `eu.posthog.com` and `app.posthog.com` without
   configuration; every other host stops working when this build serves.
3. Grant existing administrators explicitly. `TALYN_ADMIN_EMAILS` now applies
   only when a user row is INSERTED, so an operator who already has a row keeps
   the `is_admin` they have. Nobody is demoted by this change. To add one:
   `UPDATE users SET is_admin = true WHERE email = 'someone@example.com';`
   Raw SQL is the only route from a zero-admin state — the console grant path
   needs an existing admin and `TALYN_ADMIN_GRANT_ENABLED=1`.
4. After the deploy, run `docs/rollout/repair_mismatched_loop_runs.sql`. It
   settles loop runs that were linked across workspaces before this change.
5. Verify login, owned-resource CRUD and foreign-resource refusal.

### Phase 2 — shipped

6. Migration 0058 removes `anon`/`authenticated` access to application tables
   and strips the default privileges, so a table created later grants them
   nothing. Applied one deploy after 0057, with Railway showing a single active
   deployment — every replica was already on `talyn_backend`.
7. Verified in production: the Data API roles hold no table privileges, the
   backend keeps its 18 tables plus the merge-queue sequence, and owner scoping
   still resolves.

**The boundary is now complete.** `authenticated` was the only Data API role
that actually held grants (`anon` and `service_role` had none), so it is the one
this took anything from.

### Rollback

Now that phase 2 has shipped, a build older than 0057 cannot run: its owner
scopes use `authenticated`, whose grants are gone. To go back that far, run
`docs/rollout/rollback_regrant_authenticated.sql` BEFORE redeploying it. Drizzle
has no down migrations; that script is the only way back. Rolling back to any
build from 0057 onwards needs no database work.

### Why the policies moved off `auth.uid()`

On Supabase the `auth` schema belongs to `supabase_auth_admin`, and the role the
backend connects as holds USAGE on it **without grant option** and is not a
member of the owner:

```
auth ACL:  postgres=U/supabase_admin          -- no grant option
pg_has_role(postgres, supabase_admin)      = f
pg_has_role(postgres, supabase_auth_admin) = f
```

So the backend cannot grant `auth` access to a role it creates — on this project
or any Supabase project. A `GRANT USAGE ON SCHEMA auth` from it raises a WARNING
and grants nothing, which would have left the migration committed and every
owner-scoped query failing at runtime, because each policy calls `auth.uid()`.
This was caught by dry-running the migration against production inside a
transaction that rolled back; the earlier draft would have taken the backend down.

`auth.uid()` is not privileged machinery, though — it reads two GUCs that
`withOwnerScope` sets itself. So 0057 defines `public.talyn_uid()` with the same
body in a schema we own, proves it agrees with `auth.uid()` on the live database
before anything depends on it, and repoints all 17 policies at it. The policies
are all `TO PUBLIC`, so the rewrite serves the previous build's `authenticated`
role too — which is what keeps the deploy overlap working.

0057 also asserts every table grant landed, for the same reason the `auth` grant
failed: a grant that silently did nothing must not read as a successful
migration. The whole migration is one transaction, so a failure rolls back
cleanly and the boot refuses, leaving the previous build serving. Re-running it
is safe.

### Operational notes

8. Workspace GitHub operations consume user rate budgets, not installation
   budgets. Poll fetches and REST sweeps are shared between workspaces that use
   the SAME credential (identical token, identical permissions), and repository
   access checks are cached for 60 seconds per credential — a credential
   revoked in the database still stops granting access at once, because the
   cache is keyed on the credential itself.
9. `XAUTOCLAIM` needs Redis 6.2 or later. The worker now checks once at start
   and logs plainly if the command is missing: ordinary delivery still runs, but
   deliveries a stopped replica left pending are NOT recovered.
10. Alert on the `webhooks:authorization-exhausted` event. It fires once per
    delivery that exhausted its authorization retries and needs an operator
    replay. One workspace that cannot be authorized no longer parks the whole
    delivery: the workspaces that CAN be verified proceed, and the delivery is
    only held when none of them could answer.
11. Keep the backend behind the expected single trusted proxy. Do not expose its
    Node listener directly. `trust proxy` is a hop count of 1, and the WebSocket
    guard reads the last `X-Forwarded-For` entry, so a client cannot spoof its
    address — both assume exactly one proxy appends it.

The database tests use PGlite. They do not reproduce every managed Supabase role
or grant. Verify effective `auth.uid()` policy behavior on a real Supabase
project rather than assuming a successful grant changed privileges.

Supabase authentication is not disabled. Product clients already use Talyn's
REST API for application data. On this database `authenticated` is the ONLY
Data API role holding table grants — `anon` and `service_role` have none, so
phase 2's revoke of them is a no-op kept for other deployments. `service_role`
does carry `BYPASSRLS`, so it would be unrestricted if it were ever granted a
table; that is a reason to keep the service key secret, not an access path
today. Future migrations must grant scoped access
to `talyn_backend`, not to `anon` or `authenticated`. Other roles that create
application tables need equivalent default restrictions.

Socket limits are per replica: 20 per owner, 50 per source address, and 1,000
total. Authorization refreshes every 15 seconds and expires after 30 seconds
without a successful check. JWT expiry closes the connection independently. The
shared client reconnects with a current token, and backs off to the 30-second
ceiling at once when the server rejects it for authorization or capacity —
rather than retrying a standing refusal every second.

## Remaining Work

Browser-bound provider authorization and host-specific machine authentication require separate, coordinated changes.
Sensitive reproduction details remain outside this public report, which is a file in a public repository.
These areas are not certified as secure by this PR.

Operational follow-ups remain:

- Review historical associations and retained data. This patch blocks invalid access paths but does not repair or remove existing records.
- Credential rotation is tracked in private operational records, not here.
- Make webhook retention pending-aware. Source-stream length trimming can remove retry payloads during prolonged, high-volume outages.
- Validate authorization retries with a live Redis service. Local recovery tests mock Redis commands.
- Verify ingress, egress, database roles, active provider grants, and production secret configuration independently.
- Audit the external fleet gateway, host isolation, microVM runtime, and credential proxy separately.
- Treat repository content, comments, and agent instructions as untrusted input. Prompt wording cannot replace runtime isolation.
