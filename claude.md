# Talyn — Claude Context

Talyn is a desktop "mission control" app for **GitHub PR management**, powered by **cloud coding agents**. It tracks your open/review-requested PRs in a prioritized GitHub panel, and delegates fix/respond/review work to cloud providers that run the agent loop on their own sandbox and open a PR. **Talyn Fleet (`selfhosted`) is the default** — Firecracker microVMs on our own hardware, running the workspace's **own Claude or Codex subscription** — with **PostHog Code** as the fall-back. Codex Cloud is deferred; Claude Code was removed.

**As of the cloud-only refactor (June 2026)** the app no longer runs anything locally: the bundled daemon, local/remote environments, in-process Claude agents, permission gates, backlog/continuous-build, and the per-task git working tree are all gone. Every task is a cloud task. See [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md).

**Target user**: engineers who live in GitHub PRs and want to hand routine PR work to cloud agents.

## Git Workflow

**Repository**: `git@github.com:Gilbert09/talyn.git` (main branch)

After completing each task: stage relevant files, commit with a descriptive message, push to main. No branches or PRs for Talyn itself. Keep commits focused and atomic.

**Commit authorship**: commits should be authored by Tom directly. Do NOT append `Co-Authored-By: Claude …` trailers or any other AI-attribution lines to commit messages in this repo.

## CI & Releases (`.github/workflows/`)

Every push to main deploys — treat a push as a production release. All deploy/publish workflows are fork-guarded with `if: github.repository == 'Gilbert09/talyn'` (these guards compare against the CURRENT repo name; update them if the repo is ever renamed, in the same push, or deploys silently skip).

- **`test.yml`** — every push + PR. 3-OS matrix (macOS/Windows/Ubuntu): full builds → `typecheck` → `lint` → `npm test`. The only gate — nothing blocks a deploy on it, so don't push red.
- **`deploy-backend.yml`** — push to main touching `packages/backend|shared`, `Dockerfile`, `railway.toml` (+ `workflow_dispatch`). Deploys to Railway via CLI token; cutover is health-gated (`/health` does a real DB check and 503s while draining), so a boot-refusing build keeps the old one serving. NOTE: every deploy briefly overlaps old+new instances — the pg advisory locks (`services/advisoryLock.ts`) exist for exactly that window.
- **`deploy-marketing.yml`** — push to main touching `apps/marketing/**`. Lint + typecheck gate, then Vercel prebuilt deploy to www.talyn.dev.
- **`publish.yml`** — the **stable release**, cut **every six hours** and on demand. The scheduled run is skipped when main has not moved since the latest stable release (`/releases/latest` + the compare API, so a run the cron misses is caught up by the next one). On demand: Actions → Publish → "Run workflow" (version input optional; empty auto-picks the next patch, and electron-builder creates the release AND the tag, so no local git needed) or push a `vX.Y.Z` tag. Builds **macOS arm64+x64 (signed + notarized), Windows NSIS, and Linux AppImage**, publishing a **full release**, which is what the updater and the talyn.dev download button follow. The tag/input is the single source of truth for the app version (baked into `release/app/package.json` at build time, never committed). A `concurrency` group queues a manual dispatch behind a scheduled run: the `version` job reads the release list at run time, so two runs in flight would stamp the same version. (`nightly.yml`, which shipped arm64-only pre-releases on the same cron to nightly-channel users only, was folded into this in Session 96.)

  **Job shape**: a `version` job resolves the version ONCE and fans it out (three legs each computing "next patch above the latest release" would race), then the **macOS leg runs alone** — it's what creates the GitHub Release (and the tag, on the schedule and dispatch paths) — and only then does a `windows-latest`/`ubuntu-latest` matrix upload into it. Keep that ordering: parallelising all three races three electron-builder processes to create the same release, and chaining means a Windows/Linux failure can't take down a macOS release that already published. **Windows ships unsigned** until an EV cert is bought (SmartScreen warns on first install); setting `CSC_LINK`/`CSC_KEY_PASSWORD` fixes it with no workflow change.

**Update channels**: the desktop picker (Settings → About; persisted in userData via `src/main/updateChannel.ts`, default `stable`) maps to electron-updater's `allowPrerelease`. Since Session 96 nothing publishes a pre-release, so both channels receive the same stable build. The picker is kept so a pre-release track can come back without a client change; removing it (and the "every build as it lands" copy) is an open follow-up.

## Testing — run the relevant tests; CI runs the rest

**Do NOT run a whole package suite locally.** `npm test` in `packages/backend` is
~7 minutes — many suites spin up a real pglite Postgres per file — and running it
after every edit is most of the loop spent waiting. Run what covers the change:

- **Backend** (`packages/backend`, Vitest): `npx vitest run <path/to/file.test.ts>`
  for the specific file(s); add paths or a glob (`npx vitest run src/__tests__/prMonitor*`)
  when a change spans related suites; `-t "<name>"` for a single `describe`/`it`.
- **Desktop** (`apps/desktop`, Jest): `npx jest <pattern>`.
- **Web** (`apps/web`, Vitest): `npx vitest run <pattern>`.

Pick by what the change can plausibly break, not by habit — and this holds for a
cross-cutting edit too. Touching `packages/shared`, a widely-imported helper or a
migration is a reason to run *more of the relevant suites*, not to run everything:
a schema change means the suites that read those tables, not `prMonitor`'s.

**The full suite is CI's job.** `test.yml` runs `typecheck` → `lint` → `npm test`
across macOS, Windows and Ubuntu on every push and PR — broader than a local run
and three platforms wider. Push and let it do that.

It is a BACKSTOP, not a fast feedback loop: that matrix takes **~30 minutes**, so
it tells you about a break long after you have moved on, and (see below) after the
backend has already deployed. Local typecheck + lint is what actually protects the
change; CI is what catches what they cannot.

**What to always run locally**, because it is seconds and catches most breakage
before it leaves the machine:

```
tsc --noEmit        # in the package(s) you touched
eslint <changed files>
```

**The consequence to respect**: nothing blocks a deploy on `test.yml` — a push to
main deploys the backend whether or not the suite has finished, let alone passed.
Combined with the ~30-minute matrix, that means a red test is discovered roughly
half an hour after the code it breaks is already serving traffic. So delegating
the suite to CI is not the same as not caring about it: **watch the run you
triggered**, and if it goes red, fixing it is immediate work rather than something
to pick up later. And when a change is risky in a way typecheck and lint cannot
see — a migration, an auth path, anything in the webhook worker — run the suites
around it locally BEFORE pushing. Half an hour of a broken backend is worse than
two minutes of waiting.

See [`docs/TESTING.md`](./docs/TESTING.md) for the broader strategy.

## Where Things Live

- **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)** — system diagram, tech stack, core concept details, key decisions, resolved questions
- **[`docs/ROADMAP.md`](./docs/ROADMAP.md)** — full phased TODO (Phase 1–20), backlog, known gaps, full priority queue
- **[`docs/SESSIONS.md`](./docs/SESSIONS.md)** — chronological session notes
- **[`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md)** — the cloud task provider abstraction (registry, per-provider modules, roadmap)
- **[`docs/QUALITY_PARITY.md`](./docs/QUALITY_PARITY.md)** — desktop polish/parity assessment vs Conductor; what's done + prioritized backlog (feed perf, PR diffs/merge, composer, tests)
- **[`docs/INCREMENTAL_CHECK_COUNTS.md`](./docs/INCREMENTAL_CHECK_COUNTS.md)** — webhook-driven incremental check counting design
- **[`docs/MCP_SERVER.md`](./docs/MCP_SERVER.md)** — the `@talyn/mcp-server` package
- **[`docs/SETUP.md`](./docs/SETUP.md)** — env vars / account setup
- **[`docs/TESTING.md`](./docs/TESTING.md)** — testing strategy + coverage

When a session lands non-trivial work, append a note to `docs/SESSIONS.md`. When a phase item changes status, update `docs/ROADMAP.md`. When a decision is revisited, update `docs/ARCHITECTURE.md`.

**Keep the session log out of this file.** A note in `docs/SESSIONS.md` is the record; this file carries only what is still true and still load-bearing — Core Concepts, the conventions above. It used to hold a summary of every recent session as well, which grew to 57% of the file: a strictly worse copy of the same notes, always behind, and loaded into every session's context whether or not it was relevant.

## Core Concepts (at a glance)

- **Workspace** — groups related repos + integrations (e.g., "PostHog" = `posthog/posthog` + `posthog/posthog.com` + `posthog/charts`). **Every owner always has at least one**: `services/workspaceBootstrap.ts` mints a `DEFAULT_WORKSPACE_NAME` one on `GET /workspaces` (the call every client makes on boot), advisory-locked per owner so concurrent first-loads cannot double-insert. Onboarding therefore opens on **Connect GitHub**, not on naming a workspace. **Consequence to respect: a workspace existing no longer means the user is set up** — both front ends read `Workspace.integrations.github` to decide "already onboarded", because keying off `workspaces.length > 0` would skip the wizard (and its required GitHub step) for every new user. See Session 106 in [`docs/SESSIONS.md`](./docs/SESSIONS.md).
- **Cloud provider** — a vendor that runs the whole agent loop on its own sandbox and opens a PR. Pluggable behind `CloudTaskProvider` (`packages/backend/src/services/cloudProviders/`): a registry + per-provider `dispatch`/`reconcile`/credentials. **Talyn Fleet** (`selfhosted`) heads `CLOUD_PROVIDER_ORDER`, **PostHog Code** is the fall-back, **Codex Cloud is deferred** (no server-to-server API), and **Claude Code was removed** (metered API credits only — the fleet runs Claude on the user's own subscription instead). See [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md).
  - **The fleet is one provider with TWO agents**, and the **model carries the vendor**: `fleetProviderForModel` reads the model id, and the fleet builds the microVM's egress route table from it, so a Codex run has no route to `api.anthropic.com` at all. Picking an agent per task is picking a model — a second field would be a second source of truth that can disagree.
  - **A dispatch always sends the workspace's own key for the vendor it runs, and suppresses the other with `policy.credentials`.** The gateway fills an *absent or blank* key from its tenant's sealed custody, so `?? ''` was a silent route to spending someone else's subscription; no credential is a **refusal**. `cloudTask.extra.llm` records the vendor, and `poller.recredential` + `resolveRunCredentials` must both read it — they used to send the Claude key unconditionally.
  - `FLEET_ENABLED` + `FLEET_ALLOWED_EMAILS` still gate it (unset = nobody). A non-allow-listed workspace has the fleet dropped from its chain and lands on PostHog Code, exactly as before.
- **Environment** — now just a **secret-free marker**, one auto-provisioned row per connected cloud provider. Its `type` (a `CloudProviderType`) is how a task resolves its provider; per-workspace credentials live on the `integrations` row. No daemon, no pairing. PostHog Code's row carries EITHER an encrypted personal API key or an encrypted OAuth token pair, decided by `config.authMethod` (absent = key), and everything downstream reads one `getToken()` from `posthogCode/credentials.ts` rather than branching — see Session 81.
- **Task** — the unit of work, always delegated to a cloud provider. Types: `code_writing` (freeform prompt on a repo), `pr_response`, `pr_review`. Lifecycle: `queued` → `in_progress` → `completed`/`failed`. The cloud poller (`cloudProviders/poller.ts`) drives status + ingests the transcript; review happens on the provider's PR (no local `awaiting_review` gate).
- **Workflow** — user-defined PR automation, **released to every workspace**. `WORKFLOWS_ENABLED=false` is a KILL SWITCH and the only knob: **absent means ON** (the opposite of how it shipped — see Session 118), and anything but an explicit `false`/`0` is on, so a typo turns it on rather than silently off. `WORKFLOWS_ALLOWED_EMAILS` is gone. A named, workspace-scoped rule: *on these PR lifecycle events, matching these conditions, do these actions* (labels, reviewers, assignees, a comment, a skill or prompt run, add to My PRs, add to the merge queue). Vocabulary + matcher + validator in `packages/shared/src/workflows.ts` (the `prFilters.ts` argument, higher stakes — a workflow comments and merges); engine in `packages/backend/src/services/workflows/`; tables `workflows` + `workflow_runs` (migration `0052`). **Four things to respect:**
  - **It reads the webhook PAYLOAD, never a `pull_requests` row**, which is what lets it fire on every PR in a watched repo including untracked ones and other people's. Hooked into `processWebhookDelivery` ABOVE the `isRefreshEvent` gate (that predicate is about refreshes, a narrower question). Where a payload is short of a fact — an `issue_comment` describes an *issue*, so no base branch / head branch / draft; a `check_suite`'s PRs are `{number, base, head}` — facts carry `unknownFields`, a condition on one **fails** rather than passing, and the engine enriches from the row first (SQL accessors into `last_summary`, never the blob).
  - **`UNIQUE (workflow_id, delivery_id)` is the concurrency design.** The run row is inserted BEFORE any action runs; a conflict means a redelivery or another replica already owns it. No advisory lock. Settling is TWO writes — outcome first, then the task/PR links best-effort — because one combined UPDATE fails the FK when a linked row has gone and strands the run at `running`.
  - **A rate-limited action is PARKED, not lost.** `pending_retry` + `retry_after` (migration `0053`) hold the instant the gate clears, and `services/workflows/retrySweep.ts` re-runs only the actions that have not already succeeded — a run whose comment posted and whose label was gated must not comment twice. NOT an inline wait: these run in the webhook worker's six-wide slow lane and the gate is per ACCOUNT, so a burst from one org would block most of the lane on one wait. `rate_gated` is the ONLY retryable code (it is the one failure that is transient AND says when it clears); the run's `facts` are stored because a `comment` action interpolates branches the webhook payload no longer has.
  - **Two loop guards, not a quota.** Self-echo suppression (skip a delivery whose actor is Talyn's own App, on the events our actions produce — App only, never the connected user; and `pr_merged` deliberately excluded) plus `max_runs_per_pr_per_hour` (default 5) counted from `workflow_runs`, with `skipped` rows excluded from the count and the refusal announced once per window.
  - **The merge action is the QUEUE, not `mergePullRequest`.** A direct merge 405s on a gated base. This is why the enqueue path moved out of `routes/pullRequests.ts` into `services/mergeQueue/membership.ts` (per-PR `applyQueueMembership` vs per-call `setQueueMembership`). `local:` skills are refused at save time — the backend cannot read `~/.claude/skills`. `GET /features` → `{ workflows }` decides only what to DRAW; every route, the engine and the task actions gate independently. See Session 117 in [`docs/SESSIONS.md`](./docs/SESSIONS.md).
- **Operator console** — `apps/admin` at admin.talyn.dev. Cross-tenant by definition; gated by `users.is_admin` + `requireAdmin`, which is the whole permission model. Its API is `/api/v1/admin` (pre-`ownerScope`). Every mutation requires a reason and writes to `admin_audit_log`.
- **Billing** — free plan = **3 active tasks** (`pending|queued|in_progress`) **and 3 merge-queue PRs** per owner across all their workspaces; **Unlimited** = $15/mo (or $150/yr) via **Polar** (merchant of record). The provider-agnostic entitlement seam is `services/billing/entitlements.ts` (task gate in `createCloudTask` + the retry/start/PATCH re-activation paths, `TaskLimitError` → 402 `code:'task_limit_reached'`; merge-queue gate in `POST /pull-requests/:id/merge-queue`, `MergeQueueLimitError` → 402 `code:'merge_queue_limit_reached'`; both open the desktop UpgradeModal via `maybeHandleBillingLimit`); Polar specifics live only in `services/billing/{polar,webhook}.ts` (webhook: `/api/v1/webhooks/polar`, raw-body, idempotent + order-safe). Enforcement runs ONLY when the all-or-nothing `POLAR_*` env group is set (absent = limits off — the dev default and the prod kill switch). **Both gates now run unconditionally — there is no per-caller exemption.** `services/billing/clientGate.ts` used to wave through any client identifying as a build older than the release that shipped each paywall UI; it was deleted in Session 104 once the only thing still claiming it was an unstamped LOCAL build reporting the `0.1.0` placeholder from `release/app/package.json` (see `apps/desktop/.erb/configs/appVersion.ts`, which now reports `dev` instead). `X-Talyn-Client-Version` is still sent, but nothing in billing reads it. **The gate you cannot see is the watchers**: a merge-queue or auto-keep fix run that hits the task cap is deferred server-side (`deferred_task_limit`), not 402'd — there is no request to answer, so no UpgradeModal and no `paywall_shown`. For a merge-queue-heavy user that is the *dominant* path, and it is why the paywall reads as never firing. **A third gate is a FEATURE gate, not a cap**: turning ON the workspace default "keep new PRs green" (`settings.defaultAutoKeepMergeable`) needs Unlimited — `AutoKeepDefaultPlanError` → 402 `code:'auto_keep_default_requires_unlimited'`, asserted in the workspaces PATCH on the OFF→ON **transition only**, which is what grandfathers a free workspace that already has it on (turning it off gives that up). The modal's pitch is derived from usage, so the billing store carries an `upgradeReason` and the feature branch is checked before the usage ones. Comp an account with `UPDATE users SET plan_override='unlimited' WHERE email='…'` — webhooks never touch that column. See Sessions 68 + 70 + 104 + 105 in [`docs/SESSIONS.md`](./docs/SESSIONS.md).
- **GitHub/PR core** — `services/{github,githubGraphql,prMonitor,prCache,prFocus}.ts` + `routes/{github,pullRequests,repositories}.ts` + the desktop GitHub panel / PR pills / detail sheet. This is the heart of the app. (The standalone **Inbox** — a prioritized queue of PR items needing attention — was removed; PRs needing attention surface directly in the GitHub panel's "Needs attention" / Mine / Review buckets.)

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full treatment.

## Debug Tooling — keep it current

The **Debug** panel now lives ONLY on the operator console (admin.talyn.dev → Ops → Debug). It was removed from `apps/web` and `apps/desktop` in Session 80: it streams backend internals across every account, so it belongs on an admin-gated surface rather than in the product. It surfaces app internals live: outbound HTTP, poll-loop ticks, WebSocket traffic, and domain events. It's powered by an in-process `debugBus` (`packages/backend/src/services/debugBus.ts`, ring buffer + counters + poller registry) that records metadata only (URLs are query-stripped; no headers/bodies/tokens) and streams over the existing WS as `debug:event`. UI lives in `apps/admin/src/components/panels/DebugPanel.tsx` (one copy — the desktop/web duplicates are gone).

**When you add or change a subsystem, wire it into the bus so the panel stays honest:**
- **New outbound HTTP** (a new external API/integration) → time the call and `debugBus.recordHttp({ service, method, url, status, durationMs, ok, error? })` at the central request funnel (see `github.ts` `apiRequest`/`executeGraphql`, `posthogCode/client.ts` `request`). Add a one-liner to `SERVICE_INFO` in `DebugPanel.tsx`.
- **New poll loop** → `debugBus.registerPoller(name, intervalMs, description)` in `init()` (the `description` arg is required — that's the tooltip) and `debugBus.pollerTick(name, { durationMs, ok, error? })` in the tick's `finally`.
- **New WebSocket message/broadcast or domain event** → `debugBus.recordWs(...)` / `debugBus.recordEvent(...)`. If it's a new outbound broadcast type, keep the `event.type !== 'debug:event'` loop-guard in `websocket.ts` intact.
- **New `DebugCategory`** → extend the shared type, `CATEGORY_INFO`, `CATEGORY_LABEL`, `categoryClasses`, the filter chips in `DebugPanel.tsx`, **and the `CATEGORIES` allowlist in `routes/debug.ts`** — an unlisted value there is not rejected, it silently falls through to "no filter", so the chip appears to do nothing rather than to fail. (`db` and `webhook` were missing for exactly that reason until Session 80.)

**GraphQL budget cards** ("GraphQL budget" row in the panel) show GitHub's per-account GraphQL points budget (`inst:<id>` for an App installation, else login), fed by `services/graphqlBudget.ts`. The budget is read off the free `rateLimit { limit cost remaining resetAt }` field spliced into every batched query (`githubGraphql.ts` `RATE_LIMIT_FIELD`); `github.ts` `executeGraphql` captures it via `graphqlBudget.record(accountKey, …)`. The tracker is **pure / debug-bus-independent on purpose** — it also drives a proactive deferral: the reconcile sweep (`prReconcileSweep.ts`) calls `graphqlBudget.shouldDefer(accountKey)` and skips an account whose remaining points are in the reserve (`RESERVE_POINTS`), so webhooks / merge queue / manual refresh keep flowing until the window resets. `debugBus.snapshot()` just reads `graphqlBudget.snapshot()` for display. Tests: `graphqlBudget.test.ts`.

Tests live in `packages/backend/src/__tests__/debugBus.test.ts` — extend them alongside changes.

## Database Egress — keep queries lean

The backend runs against Supabase Postgres and we pay for DB egress (result-row bytes shipped DB→backend). A bare Drizzle `.select()` is `SELECT *` — it ships **every** column, including large jsonb blobs the caller usually doesn't touch. The two expensive columns are **`tasks.transcript`** (the cloud-run conversation log, often MBs) and **`pull_requests.lastSummary`** (~2KB, but multiplied across every tracked PR on the poll loops). The DB-egress tile in the Debug panel (fed by `instrumentEgress` in `db/client.ts`, which records per-query `bytes`/`rows`/`table`) is how you spot regressions — watch it after touching any read.

**Rules of thumb when writing or reviewing a query:**

- **Never `.select()` (= `SELECT *`) unless the caller genuinely uses every column.** Default to an explicit column list. This is most critical on anything that (a) runs in a poll loop or per-request hot path, or (b) reads a table with a large jsonb column (`tasks`, `pull_requests`, `workspaces.logo`, `integrations.config`).
- **Reuse the established projection helpers — don't invent new shapes:**
  - `services/taskSerialize.ts` → `taskColumnsNoTranscript` (every `tasks` column except `transcript`) + `rowToTask(row, { includeTranscript? })`. Any task read that doesn't render the transcript should use this. Only `GET /tasks/:id` and `POST /tasks/:id/message` select the full row.
  - For poll-loop / hot-path reads on `pull_requests`, define an `as const` projection object next to the consumer and type the row as `Pick<typeof table.$inferSelect, keyof typeof PROJECTION>`. Existing examples: `QUEUE_COLUMNS` (`mergeQueueProcessor.ts`), `WATCH_COLUMNS` (`prAutoMergeWatcher.ts`), `PR_CACHE_COLUMNS` (`prCache.ts`), `BROADCAST_COLUMNS` (`mergeQueueBroadcast.ts`), `PR_LOOKUP_COLUMNS`/`PR_FLAG_COLUMNS` (`routes/pullRequests.ts`), `CLOUD_ENV_COLUMNS` (`taskQueue.ts`). The `Pick` type is the regression guard — `tsc` fails if a consumer later reads a column the projection drops, so it can never silently re-bloat.
- **If you only need a scalar/boolean derived from a big jsonb, compute it in SQL — don't fetch the blob.** Use a `sql<...>` expression so the column never ships. Precedents: `cloudProviders/poller.ts` derives `transcriptEmpty` with a `CASE … jsonb_array_length(transcript) …`; `prMonitor.fastPollWorkspace` derives the in-flight check count with `COALESCE((last_summary -> 'checks' ->> 'inProgress')::int, 0)` instead of selecting `lastSummary`. When you do this, **pin the SQL to the JS semantics it replaces with a pglite test** (see `cloudPollerEgress.test.ts`, `prMonitorFastPollEgress.test.ts`) — keep the JS helper exported as the canonical definition the SQL must match.
- **Don't fetch a column to read it once for a rare branch.** If a loop reads N rows but only needs an expensive column for the few that hit a condition (e.g. `reconcileRelationshipFlags` only needs `lastSummary` for rows whose flags changed), drop it from the bulk select and re-fetch it per-row inside the branch — N blob fetches/tick become K (usually 0).
- **The same discipline applies to what leaves the backend.** WS broadcasts and REST responses should serialize a crafted shape, never a raw full row (see `emitPullRequestUpdated` / `rowToPublicShape`). Don't echo `transcript` or unread jsonb to the desktop.

When in doubt, add a `.toSQL()` assertion (`expect(query.toSQL().sql).not.toContain('transcript')`) — it proves the projection excludes the blob without a live DB (see `projectionEgress.test.ts`).

## Active Priorities

> Full list in [`docs/ROADMAP.md`](./docs/ROADMAP.md). The active direction is the cloud-provider abstraction in [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md). (The daemon-everywhere / continuous-build / local-execution era docs were deleted in July 2026 — see `docs/SESSIONS.md` history if you need them.)

1. **Cloud provider abstraction** — the seam is **done** and has two live providers: **Talyn Fleet** (`services/selfHosted/*` + `cloudProviders/selfhosted/provider.ts`, the default) and **PostHog Code**. **Codex Cloud is deferred** — OpenAI exposes no server-to-server cloud-task API (only the `codex cloud` CLI or `@codex` GitHub mentions); note this is a different thing from running **Codex on the fleet**, which works. Each provider is a self-contained `client + credentials + executor + poller + provider` module — no core changes. Selection is generic: `defaultCloudProvider` (`selfhosted | posthog_code | ask`) drives the backend resolver (`resolveCloudEnvChain`) and both front ends, with an "Ask every time" per-task **agent menu** on each PR row (the fleet contributes one entry per connected subscription, each carrying its model). Follow-ups: the deferred `TranscriptSource`/`TranscriptConverter` generalisation; measuring the real ChatGPT access-token lifetime, which decides whether server-side Codex refresh is worth its ToS exposure.
2. **Desktop polish** — the composer still has no freeform task entry; every task starts from a PR row or the skill picker. (The dead local-task UI — TaskFilesPanel/TaskGitPanel/awaiting_review flow — was removed in Session 52.)
3. **Phase 18.2 polish** — proper `talyn login` PKCE flow, CLI refresh-token rotation, invite flow.

**Recent work**: see [`docs/SESSIONS.md`](./docs/SESSIONS.md), newest first — one note per session, with the reasoning and the things that turned out not to work.

## File Structure

```
fastowl/
├── apps/
│   ├── desktop/                  # Electron desktop app
│   │   └── src/
│   │       ├── main/             # main + preload
│   │       └── renderer/         # React frontend (components, hooks, stores, lib)
│   ├── web/                      # @talyn/web — browser app (app.talyn.dev), Vite + React 19
│   └── admin/                    # @talyn/admin — operator console (admin.talyn.dev), Vite + React 19
├── packages/
│   ├── backend/                  # Express + WS server, DB, services
│   ├── cli/                      # @talyn/cli — `fastowl` binary
│   ├── client/                   # @talyn/client — REST + WS transport, shared by every front end
│   ├── mcp-server/               # @talyn/mcp-server — stdio MCP for child Claudes
│   └── shared/                   # Shared TS types
│   # (packages/daemon removed in the cloud-only refactor)
├── docs/                         # ARCHITECTURE, ROADMAP, SESSIONS, CLOUD_PROVIDERS, SETUP, etc.
├── supabase/                     # Local dev Supabase stack: `npm run dev:db` (config.toml +
│                                 # gitignored .env). Local dev must NEVER point at the prod
│                                 # DB / GitHub OAuth app — see docs/SETUP.md §0 for the why.
├── CLAUDE.md                     # This file
└── package.json                  # npm workspace root
```

Inside `packages/backend/src/`: `db/` (migrations + Drizzle schema/client), `routes/` (REST), `services/` (`taskQueue`, `cloudProviders/` (registry + poller + posthog/claude providers), `posthogCode/` (client/executor/streamer/converter), `claudeCode/` (client/credentials/executor/poller/converter — Anthropic Managed Agents, poll-based transcript), `github`, `prMonitor`, `prCache`, `taskPullRequest`, `events`, `websocket`), `__tests__/` (Vitest).

Inside `apps/desktop/src/renderer/components/`: `layout/`, `modals/`, `panels/`, `terminal/`, `widgets/`, `ui/` (shadcn).

**`apps/web` is a deliberate FORK of the desktop renderer, not a shared build of it.** Tom's call: every UI feature gets built twice from here on, in exchange for the two clients being able to diverge freely. What is NOT forked is the backend contract — both import `@talyn/client` — because two copies of that drift into runtime bugs rather than type errors. Three things the fork must keep straight, all verified with a spike before the app existed:
- **Env is `import.meta.env.VITE_*`, never `process.env.*`.** Vite's `define` entries are *"defined as globals during dev and statically replaced during build"*, so mirroring webpack's `EnvironmentPlugin` with a `define` of `process.env.TALYN_API_URL` serves the dev browser an unsubstituted expression that throws on the missing `process` global. `vite.config.ts` fails a production build outright when a required key is empty (a white screen on a public URL is much worse than the desktop's runtime throw) and refuses any value containing `service_role`.
- **OAuth is a full-page redirect** — `signInWithOAuth` with no `skipBrowserRedirect`, plus `detectSessionInUrl: true`. The desktop's `openExternal(data.url)` fires after two `await`s, so its `window.open` fallback has lost user activation and Safari/Firefox block it, silently, on the sign-in screen.
- **Never carry `migrateLegacyAuthFromLocalStorage` across.** On web the "bridge" IS localStorage, so its `setItem`-then-`removeItem` on the same key wipes the session every page load.

`packages/client` ships **dual-format** (`dist/cjs` + `dist/esm`, picked by the `exports` map) because Rollup cannot statically see the re-exports `tsc`'s CommonJS output emits as `Object.defineProperty(exports, …)` getters — Vite fails with *"not exported by"* — while the desktop's jest suite still needs CJS. Don't collapse it to one format without checking both.

**Browser-origin surface** (all inert until `app.talyn.dev` exists): `services/originPolicy.ts` is the one answer to "may this origin talk to us", shared by the REST CORS gate and the WS upgrade — **exact string match, never a pattern** (`ALLOWED_ORIGINS`), because a prefix/suffix rule is how `https://app.talyn.dev.evil.com` gets in. A rejected origin now denies by *omitting* the header (`cb(null, false)`) instead of throwing a 500, CORS is `credentials: false` (the API is Bearer-only, so CSRF-immunity is structural) with `maxAge: 86400` (the non-safelisted client-version header preflights every request). The `null`-origin concession for the packaged renderer's `file://` WS handshake is forgeable by any page and sits behind `TALYN_ALLOW_NULL_ORIGIN_WS` — **flip it to `0` the day anything moves to cookie auth**, or it becomes a live cross-site WebSocket hijack. `services/webApp.ts` owns `WEB_APP_URL`: read only from env, validated at boot, and `webAppUrl()` refuses any path that isn't single-slash-relative — it's the GitHub App callback's redirect target, and an open redirect there turns a login flow into a phishing hop. The callback ends per-client (browser → 302 home, desktop → close-this-tab page), decided by the Origin recorded server-side when the state was minted.

**`packages/client` is the single definition of the backend contract** — every route signature, every WS event type, the 401-refresh-and-replay, the reconnect backoff. Anything that talks to the backend imports it, so a route change can't be applied to one front end and forgotten in the other. It knows nothing about how a host stores a session or where its build-time env came from: hosts call `configureApiClient({ baseUrl, clientVersion, getAccessToken, recoverSession })` once at module scope. The desktop's binding is `apps/desktop/src/renderer/lib/api.ts` — ~50 lines of Supabase/`process.env` glue plus `export * from '@talyn/client'`, so the ~40 files importing `'../lib/api'` never had to move. **Add new endpoints here, not in a host app**, and remember it compiles to `dist` (`lib: ["ES2022", "DOM"]`), so it must be built before the desktop build, the typecheck, or jest.
