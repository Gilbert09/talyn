# FastOwl — Claude Context

FastOwl is a desktop "mission control" app for **GitHub PR management**, powered by **cloud coding agents**. It tracks your open/review-requested PRs, surfaces the ones needing attention in a prioritized inbox, and delegates fix/respond/review work to cloud providers (PostHog Code today; Codex Cloud / Claude Routines planned) that run the agent loop on their own sandbox and open a PR.

**As of the cloud-only refactor (June 2026)** the app no longer runs anything locally: the bundled daemon, local/remote environments, in-process Claude agents, permission gates, backlog/continuous-build, and the per-task git working tree are all gone. Every task is a cloud task. See [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md).

**Target user**: engineers who live in GitHub PRs and want to hand routine PR work to cloud agents.

## Git Workflow

**Repository**: `git@github.com:Gilbert09/owl.git` (main branch)

After completing each task: stage relevant files, commit with a descriptive message, push to main. No branches or PRs for FastOwl itself. Keep commits focused and atomic.

**Commit authorship**: commits should be authored by Tom directly. Do NOT append `Co-Authored-By: Claude …` trailers or any other AI-attribution lines to commit messages in this repo.

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
- **Cloud provider** — a vendor that runs the whole agent loop on its own sandbox and opens a PR. Pluggable behind `CloudTaskProvider` (`packages/backend/src/services/cloudProviders/`): a registry + per-provider `dispatch`/`reconcile`/credentials. PostHog Code is the only live provider; Codex Cloud / Claude Routines are drop-in (see [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md)).
- **Environment** — now just a **secret-free marker**, one auto-provisioned row per connected cloud provider. Its `type` (a `CloudProviderType`) is how a task resolves its provider; per-workspace credentials live on the `integrations` row. No daemon, no pairing.
- **Task** — the unit of work, always delegated to a cloud provider. Types: `code_writing` (freeform prompt on a repo), `pr_response`, `pr_review`. Lifecycle: `queued` → `in_progress` → `completed`/`failed`. The cloud poller (`cloudProviders/poller.ts`) drives status + ingests the transcript; review happens on the provider's PR (no local `awaiting_review` gate).
- **Inbox** — prioritized queue of PR items needing human attention (new reviews, comments, CI failures, merge-ready).
- **GitHub/PR core** — `services/{github,githubGraphql,prMonitor,prCache,prFocus}.ts` + `routes/{github,pullRequests,repositories,inbox}.ts` + the desktop GitHub panel / PR pills / detail sheet. This is the heart of the app.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full treatment.

## Debug Tooling — keep it current

There's a developer-only **Debug** panel (Settings → Developer → "Debug tools", then a Debug sidebar entry) that surfaces app internals live: outbound HTTP, poll-loop ticks, WebSocket traffic, and domain events. It's powered by an in-process `debugBus` (`packages/backend/src/services/debugBus.ts`, ring buffer + counters + poller registry) that records metadata only (URLs are query-stripped; no headers/bodies/tokens) and streams over the existing WS as `debug:event`. UI lives in `apps/desktop/src/renderer/components/panels/DebugPanel.tsx`.

**When you add or change a subsystem, wire it into the bus so the panel stays honest:**
- **New outbound HTTP** (a new external API/integration) → time the call and `debugBus.recordHttp({ service, method, url, status, durationMs, ok, error? })` at the central request funnel (see `github.ts` `apiRequest`/`executeGraphql`, `posthogCode/client.ts` `request`). Add a one-liner to `SERVICE_INFO` in `DebugPanel.tsx`.
- **Rate-limit cards** ("API rate limits" row in the panel) are fed by `debugBus.recordRateLimit({ name, description, limit, remaining, used, resetAt, resource? })`. For GitHub this comes from a dedicated `rateLimitPoller` (`services/rateLimitPoller.ts`) that polls the free `GET /rate_limit` endpoint every 30s per connected account — authoritative, returns every resource bucket at once, and doesn't depend on incidental traffic (scraping `x-ratelimit-*` off live responses made `core` look frozen and collapsed multiple accounts). Cards are keyed `<login> · <resource>`. A new provider with rate limits should follow the same pattern (poll its limit endpoint, or record off responses if that's all it exposes).
- **New poll loop** → `debugBus.registerPoller(name, intervalMs, description)` in `init()` (the `description` arg is required — that's the tooltip) and `debugBus.pollerTick(name, { durationMs, ok, error? })` in the tick's `finally`.
- **New WebSocket message/broadcast or domain event** → `debugBus.recordWs(...)` / `debugBus.recordEvent(...)`. If it's a new outbound broadcast type, keep the `event.type !== 'debug:event'` loop-guard in `websocket.ts` intact.
- **New `DebugCategory`** → extend the shared type, `CATEGORY_INFO`, `CATEGORY_LABEL`, `categoryClasses`, and the filter chips in `DebugPanel.tsx`.

Tests live in `packages/backend/src/__tests__/debugBus.test.ts` — extend them alongside changes.

## Active Priorities

> Full list in [`docs/ROADMAP.md`](./docs/ROADMAP.md). Definition of done for "production ready" is in [`docs/CONTINUOUS_BUILD_ROADMAP.md`](./docs/CONTINUOUS_BUILD_ROADMAP.md).

> **Superseded (June 2026):** the daemon-everywhere / continuous-build / local-execution roadmap is retired. FastOwl is now a cloud-only PR-management app. The active direction is the cloud-provider abstraction in [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md).

1. **Cloud provider abstraction** — Phases 1–2 (registry + interface, PostHog Code under it, generic credentials/routes) are **done**. Phase 0 spikes + Phases 3–4 (Codex Cloud, Claude Routines) are next. Each new provider is a self-contained `client + credentials + converter + transcriptSource + provider` module — no core changes.
2. **Desktop polish** — generalise the Settings card + composer to render per-provider once a 2nd provider lands; tidy the dead local-task UI left behind (TaskFilesPanel/TaskGitPanel never render now).
3. **Phase 18.2 polish** — proper `fastowl login` PKCE flow, CLI refresh-token rotation, invite flow.

**Recently landed**:
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
├── scripts/
│   └── bootstrap-vm.sh           # One-command SSH VM install
├── CLAUDE.md                     # This file
└── package.json                  # npm workspace root
```

Inside `packages/backend/src/`: `db/` (migrations + Drizzle schema/client), `routes/` (REST), `services/` (`taskQueue`, `cloudProviders/` (registry + poller + posthog provider), `posthogCode/` (client/executor/streamer/converter), `github`, `prMonitor`, `prCache`, `taskPullRequest`, `events`, `websocket`), `__tests__/` (Vitest).

Inside `apps/desktop/src/renderer/components/`: `layout/`, `modals/`, `panels/`, `terminal/`, `widgets/`, `ui/` (shadcn).
