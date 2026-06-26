# FastOwl — Claude Context

FastOwl is a desktop "mission control" app for **GitHub PR management**, powered by **cloud coding agents**. It tracks your open/review-requested PRs in a prioritized GitHub panel, and delegates fix/respond/review work to cloud providers (PostHog Code + Claude Code live; Codex Cloud deferred) that run the agent loop on their own sandbox and open a PR.

**As of the cloud-only refactor (June 2026)** the app no longer runs anything locally: the bundled daemon, local/remote environments, in-process Claude agents, permission gates, backlog/continuous-build, and the per-task git working tree are all gone. Every task is a cloud task. See [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md).

**Target user**: engineers who live in GitHub PRs and want to hand routine PR work to cloud agents.

## Git Workflow

**Repository**: `git@github.com:Gilbert09/owl.git` (main branch)

After completing each task: stage relevant files, commit with a descriptive message, push to main. No branches or PRs for FastOwl itself. Keep commits focused and atomic.

**Commit authorship**: commits should be authored by Tom directly. Do NOT append `Co-Authored-By: Claude …` trailers or any other AI-attribution lines to commit messages in this repo.

## Testing — run only the relevant tests while iterating

**Do NOT run the whole test suite on every change.** It's slow (many backend suites spin up a real pglite Postgres per file) and wastes the loop. Run only the tests that cover what you actually touched, picked by what the change can plausibly break — not by habit:

- **Backend** (`packages/backend`, Vitest): `npx vitest run <path/to/file.test.ts>` for the specific file(s); add more paths or a glob (e.g. `npx vitest run src/__tests__/prMonitor*`) when a change spans a few related suites; use `-t "<name>"` to target a single `describe`/`it`.
- **Desktop** (`apps/desktop`, Jest): `npx jest <pattern>` for the matching test(s).

Run the **full** package suite (`npm test`) only when wrapping up a change, or when the edit is genuinely cross-cutting — shared types (`packages/shared`), a widely-imported helper, or DB schema/migrations. Always pair the run with `tsc --noEmit` + `eslint` on the changed files. See [`docs/TESTING.md`](./docs/TESTING.md) for the broader strategy.

## Where Things Live

- **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)** — system diagram, tech stack, core concept details, key decisions, resolved questions
- **[`docs/ROADMAP.md`](./docs/ROADMAP.md)** — full phased TODO (Phase 1–20), backlog, known gaps, full priority queue
- **[`docs/SESSIONS.md`](./docs/SESSIONS.md)** — chronological session notes
- **[`docs/CONTINUOUS_BUILD_ROADMAP.md`](./docs/CONTINUOUS_BUILD_ROADMAP.md)** — active "production ready" plan (hosted backend, daemon split, etc.)
- **[`docs/DAEMON_EVERYWHERE.md`](./docs/DAEMON_EVERYWHERE.md)** — active refactor: daemon becomes a bundled OS-level user service; collapses local/ssh/daemon into one transport; fixes backend-restart session loss
- **[`docs/QUALITY_PARITY.md`](./docs/QUALITY_PARITY.md)** — desktop polish/parity assessment vs Conductor; what's done + prioritized backlog (feed perf, PR diffs/merge, composer, tests)
- **[`docs/CONTINUOUS_BUILD.md`](./docs/CONTINUOUS_BUILD.md)** — user-facing feature doc
- **[`docs/SSH_VM_SETUP.md`](./docs/SSH_VM_SETUP.md)** — running against a remote VM
- **[`docs/SETUP.md`](./docs/SETUP.md)** — env vars / account setup
- **[`docs/TESTING.md`](./docs/TESTING.md)** — testing strategy + coverage
- **[`docs/AUTONOMOUS_BUILD.md`](./docs/AUTONOMOUS_BUILD.md)** — design doc for self-building loops
- **[`docs/SUPACODE_COMPARISON.md`](./docs/SUPACODE_COMPARISON.md)** — internals comparison vs supabitapp/supacode (worktrees, gh-CLI auth, batched GraphQL, adaptive polling)

When a session lands non-trivial work, append a note to `docs/SESSIONS.md`. When a phase item changes status, update `docs/ROADMAP.md`. When a decision is revisited, update `docs/ARCHITECTURE.md`.

## Core Concepts (at a glance)

- **Workspace** — groups related repos + integrations (e.g., "PostHog" = `posthog/posthog` + `posthog/posthog.com` + `posthog/charts`)
- **Cloud provider** — a vendor that runs the whole agent loop on its own sandbox and opens a PR. Pluggable behind `CloudTaskProvider` (`packages/backend/src/services/cloudProviders/`): a registry + per-provider `dispatch`/`reconcile`/credentials. **PostHog Code** and **Claude Code** (Anthropic Managed Agents) are live; **Codex Cloud is deferred** (no server-to-server API — see [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md)).
- **Environment** — now just a **secret-free marker**, one auto-provisioned row per connected cloud provider. Its `type` (a `CloudProviderType`) is how a task resolves its provider; per-workspace credentials live on the `integrations` row. No daemon, no pairing.
- **Task** — the unit of work, always delegated to a cloud provider. Types: `code_writing` (freeform prompt on a repo), `pr_response`, `pr_review`. Lifecycle: `queued` → `in_progress` → `completed`/`failed`. The cloud poller (`cloudProviders/poller.ts`) drives status + ingests the transcript; review happens on the provider's PR (no local `awaiting_review` gate).
- **GitHub/PR core** — `services/{github,githubGraphql,prMonitor,prCache,prFocus}.ts` + `routes/{github,pullRequests,repositories}.ts` + the desktop GitHub panel / PR pills / detail sheet. This is the heart of the app. (The standalone **Inbox** — a prioritized queue of PR items needing attention — was removed; PRs needing attention surface directly in the GitHub panel's "Needs attention" / Mine / Review buckets.)

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full treatment.

## Debug Tooling — keep it current

There's a developer-only **Debug** panel (Settings → Developer → "Debug tools", then a Debug sidebar entry) that surfaces app internals live: outbound HTTP, poll-loop ticks, WebSocket traffic, and domain events. It's powered by an in-process `debugBus` (`packages/backend/src/services/debugBus.ts`, ring buffer + counters + poller registry) that records metadata only (URLs are query-stripped; no headers/bodies/tokens) and streams over the existing WS as `debug:event`. UI lives in `apps/desktop/src/renderer/components/panels/DebugPanel.tsx`.

**When you add or change a subsystem, wire it into the bus so the panel stays honest:**
- **New outbound HTTP** (a new external API/integration) → time the call and `debugBus.recordHttp({ service, method, url, status, durationMs, ok, error? })` at the central request funnel (see `github.ts` `apiRequest`/`executeGraphql`, `posthogCode/client.ts` `request`). Add a one-liner to `SERVICE_INFO` in `DebugPanel.tsx`.
- **New poll loop** → `debugBus.registerPoller(name, intervalMs, description)` in `init()` (the `description` arg is required — that's the tooltip) and `debugBus.pollerTick(name, { durationMs, ok, error? })` in the tick's `finally`.
- **New WebSocket message/broadcast or domain event** → `debugBus.recordWs(...)` / `debugBus.recordEvent(...)`. If it's a new outbound broadcast type, keep the `event.type !== 'debug:event'` loop-guard in `websocket.ts` intact.
- **New `DebugCategory`** → extend the shared type, `CATEGORY_INFO`, `CATEGORY_LABEL`, `categoryClasses`, and the filter chips in `DebugPanel.tsx`.

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

> Full list in [`docs/ROADMAP.md`](./docs/ROADMAP.md). Definition of done for "production ready" is in [`docs/CONTINUOUS_BUILD_ROADMAP.md`](./docs/CONTINUOUS_BUILD_ROADMAP.md).

> **Superseded (June 2026):** the daemon-everywhere / continuous-build / local-execution roadmap is retired. FastOwl is now a cloud-only PR-management app. The active direction is the cloud-provider abstraction in [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md).

1. **Cloud provider abstraction** — Phases 1–2 (registry + interface, PostHog Code under it, generic credentials/routes) are **done**. **Claude Code (Managed Agents) shipped** as the 2nd provider (`services/claudeCode/*` + `cloudProviders/claude/provider.ts`). **Codex Cloud is deferred** — OpenAI exposes no server-to-server cloud-task API (only the `codex cloud` CLI or `@codex` GitHub mentions). Each provider is a self-contained `client + credentials + converter + executor + poller + provider` module — no core changes. Provider selection is generic: a workspace `defaultCloudProvider` setting (`posthog_code | claude_code | ask`) drives both the backend auto-fix resolver (`resolveCloudEnvId`) and the desktop, with an "Ask every time" per-task **provider picker** (`providerPicker` store + `CloudProviderPickerModal`). Follow-ups: the Claude `checkout` object shape for `pr_response`/`pr_review` head-branch mounting; executor/poller DB-mocked reconcile tests; migrating the bespoke PostHog Settings card onto the generic `CloudProviderCard`.
2. **Desktop polish** — generalise the Settings card + composer to render per-provider once a 2nd provider lands. (The dead local-task UI — TaskFilesPanel/TaskGitPanel/awaiting_review flow — was removed in Session 52.)
3. **Phase 18.2 polish** — proper `fastowl login` PKCE flow, CLI refresh-token rotation, invite flow.

**Recently landed**:
- Session 52 (task-screen action audit): removed every button orphaned by the cloud-only refactor (Finish / Create PR / Reject & Requeue / Queue / Unqueue / retry-pr, the awaiting_review section + auto-commit banners, and the whole non-cloud Files/Git/Terminal tab branch); `awaiting_review` dropped from `TaskStatus`. Abort now remote-cancels the cloud run via the new optional `CloudTaskProvider.cancel()` (PostHog: PATCH the run to `cancelled`) and lands the task in `cancelled`, not `failed`.
- Session 43 (Inbox removal): ripped out the standalone Inbox end-to-end — `inbox_items` table (migration `0023`), `routes/inbox.ts`, `InboxPanel`, sidebar nav, shared `InboxItem*` types + `inbox:*` WS events, and the per-PR "unread updates" badges it powered (incl. `POST /pull-requests/:id/seen`). `prCache` still computes PR-event deltas + advances cursors; it just no longer materializes inbox rows. PRs needing attention now live only in the GitHub panel.
- Cloud-only refactor (June 2026): stripped the daemon, local/remote envs, in-process agents, permissions, backlog/continuous-build, and per-task git working tree. Built the pluggable `CloudTaskProvider` seam; made the task queue + poller cloud-only; collapsed the DB schema (dropped agents/backlog tables, slimmed environments to a marker, wiped tasks); removed the `@fastowl/daemon` package. The app is now: PR dashboard + cloud task delegation.
- Session 17 (Phase 17.3 — notifications quick win): desktop OS notification fires when a task transitions into `awaiting_review`. Toggle + permission hint in Settings → Appearance → Notifications. Uses renderer `Notification` API — Electron bridges to the native OS surface.
- Session 17 (Phase 18.3.B): SSH auto-install. Desktop "Add Environment → Remote VM (FastOwl daemon)" with two modes (auto-install over SSH, manual one-liner). Backend dials the target via ssh2, pipes `curl /daemon/install.sh | bash`, the script builds `@fastowl/daemon` + writes a systemd/launchd unit, daemon pairs + dials back, modal polls for `connected`.
- Session 16 (Phase 18.3.B foundation): daemon relay layer + daemon envs first-class in scheduling + CI hygiene. Daemon runs a local HTTP proxy; child processes' REST calls tunnel over its WS. Backend accepts internal-auth headers in parallel with JWT. No user JWT on the VM. Scheduler/backlog fall back to any connected daemon when no env is pinned.
- Session 15 (Phase 18.3.A): daemon split foundation — new `packages/daemon`, `/daemon-ws` endpoint, `daemon` env type. Daemon can pair with the backend and proxy exec/spawn/git.
- Session 14 (Phase 18.4): backend deployed to Railway at `https://fastowl-backend-production.up.railway.app`. Dockerfile + railway.toml + CI workflow. Desktop `.env` now points at hosted backend.
- Session 13 (Phase 18.2): end-to-end auth — Supabase GitHub OAuth, JWT middleware, `owner_id` scoping, RLS defense in depth, desktop login + CLI/MCP bearer tokens.

## File Structure

```
fastowl/
├── apps/
│   └── desktop/                  # Electron desktop app
│       └── src/
│           ├── main/             # main + preload
│           └── renderer/         # React frontend (components, hooks, stores, lib)
├── packages/
│   ├── backend/                  # Express + WS server, DB, services
│   ├── cli/                      # @fastowl/cli — `fastowl` binary
│   ├── mcp-server/               # @fastowl/mcp-server — stdio MCP for child Claudes
│   └── shared/                   # Shared TS types
│   # (packages/daemon removed in the cloud-only refactor)
├── docs/                         # ARCHITECTURE, ROADMAP, SESSIONS, CONTINUOUS_BUILD*, SETUP, etc.
├── supabase/                     # Local dev Supabase stack: `npm run dev:db` (config.toml +
│                                 # gitignored .env). Local dev must NEVER point at the prod
│                                 # DB / GitHub OAuth app — see docs/SETUP.md §0 for the why.
├── scripts/
│   └── bootstrap-vm.sh           # One-command SSH VM install
├── CLAUDE.md                     # This file
└── package.json                  # npm workspace root
```

Inside `packages/backend/src/`: `db/` (migrations + Drizzle schema/client), `routes/` (REST), `services/` (`taskQueue`, `cloudProviders/` (registry + poller + posthog/claude providers), `posthogCode/` (client/executor/streamer/converter), `claudeCode/` (client/credentials/executor/poller/converter — Anthropic Managed Agents, poll-based transcript), `github`, `prMonitor`, `prCache`, `taskPullRequest`, `events`, `websocket`), `__tests__/` (Vitest).

Inside `apps/desktop/src/renderer/components/`: `layout/`, `modals/`, `panels/`, `terminal/`, `widgets/`, `ui/` (shadcn).
