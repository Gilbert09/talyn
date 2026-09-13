# Backend Security Review

Date: 2026-09-12. Base revision: `997a442002f1ce48532f202c7e04cabdfd23798d`.

This review found and corrected authorization defects. It does not certify that Talyn has no vulnerabilities.
The review used source tracing, local fixtures, database tests, and mocked external services.
It did not access production data, credentials, or infrastructure.

## Scope

- REST route mounting, JWT verification, owner scoping, and database row-level security.
- Workspaces, repositories, tasks, pull requests, environments, skills, and workflows.
- GitHub credentials, installation callbacks, repository access, webhooks, and background processing.
- Cloud dispatch, remote task associations, transcript retrieval, cancellation, and credential restoration.
- PostHog destinations, OAuth request handling, encrypted credentials, and error responses.
- WebSocket authentication, subscriptions, broadcasts, admin access, and MCP tokens.
- External queue evidence and installed backend runtime dependencies.

## Implemented Controls

| Area | Control |
| --- | --- |
| GitHub authorization | Workspace operations use user credentials, never globally selected installation credentials. |
| Credential freshness | Database state controls access. Conditional rotation cannot overwrite replacement or revoked credentials. |
| Diagnostics | Rate-account identifiers use a digest instead of a token when the login is unknown. |
| Installation callbacks | Installation hints require user-authorized discovery. Expiry is checked during state redemption. |
| Repository access | Registration and webhook recipients require current repository access. Cross-workspace response sharing is removed. |
| Task relationships | Creation, dispatch, and result linking reject foreign repository and PR references. |
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
- `npm run typecheck` passed for all configured packages and applications.
- ESLint passed for all 63 changed or new TypeScript files, without warnings.
- `npm audit --omit=dev --workspace=@talyn/backend` reported zero vulnerabilities.
- `git diff --check` passed.

The complete package suites were not run locally. CI supplies the full cross-platform checks.
A clean dependency scan covers published advisories only. It does not prove that each reachable path is safe.

## Rollout Requirements

1. Review the loss of installation rate budgets before release. Workspace operations now consume user budgets.
2. Configure `POSTHOG_ALLOWED_ORIGINS` before release if trusted custom PostHog instances are in use.
3. Confirm Redis 6.2 or later for pending-delivery recovery through `XAUTOCLAIM`.
4. Monitor repository authorization failures and `gh:webhooks:authorization-failed`. Exhausted retries require operator replay.
5. Keep the backend behind the expected single trusted proxy. Do not expose its Node listener directly.
6. Grant existing administrators explicitly. `TALYN_ADMIN_EMAILS` now applies only when inserting a new user.
7. Validate normal GitHub, PostHog, and fleet operations in staging before merging this production release.

Socket limits are per replica: 20 per owner, 50 per source address, and 1,000 total.
Authorization refreshes every 15 seconds and expires after 30 seconds without a successful check.
JWT expiry closes the connection independently. The shared client reconnects with a current token.

## Remaining Work

Browser-bound provider authorization and host-specific machine authentication require separate, coordinated changes.
Sensitive reproduction details remain outside this public report. These areas are not certified as secure by this PR.

Operational follow-ups remain:

- Review historical associations and retained data. This patch blocks invalid access paths but does not repair or remove existing records.
- Review credential exposure and rotation requirements using private operational records. This review did not establish whether exploitation occurred.
- Make webhook retention pending-aware. Source-stream length trimming can remove retry payloads during prolonged, high-volume outages.
- Validate authorization retries with a live Redis service. Local recovery tests mock Redis commands.
- Verify ingress, egress, database roles, active provider grants, and production secret configuration independently.
- Audit the external fleet gateway, host isolation, microVM runtime, and credential proxy separately.
- Treat repository content, comments, and agent instructions as untrusted input. Prompt wording cannot replace runtime isolation.
