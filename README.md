# Talyn

**Mission control for your GitHub PRs, powered by cloud coding agents.**

Talyn is a desktop app that tracks your open and review-requested pull requests, surfaces the ones that need attention (new reviews, comments, CI failures, merge conflicts), and lets you hand the routine work — fixing failing CI, addressing review comments, drafting a review — to **cloud coding agents** that run on their own sandbox and open a PR for you. Flag a PR and Talyn keeps it mergeable on its own, firing a cloud fix run whenever it falls behind or goes red.

If you live in GitHub PRs and want to delegate the rote drudgery without babysitting a local agent, Talyn is for you.

**→ Download the app at [talyn.dev](https://talyn.dev)** (macOS, Apple silicon). The rest of this README is for working on Talyn itself.

---

## Why Talyn

Keeping on top of your PRs today means:

- Refreshing GitHub to see which PRs got a review, a comment, or a red check
- Context-switching back into a branch just to push a one-line CI fix
- Manually kicking off an agent, then watching it, then opening the PR yourself

Talyn consolidates that:

- **A live PR dashboard.** Every watched repo's PRs with a check-rollup status pill, review status, and a detail sheet (summary / checks / files / conversation). Needs-attention / Mine / Review buckets keep the list triaged, stacked PRs group under their parent, and you merge straight from the app. Updates arrive webhook-first, so the dashboard tracks GitHub in near-real-time.
- **Delegate to a cloud agent.** From a PR row ("fix this PR") or as a freeform task on a repo, Talyn hands the prompt to a cloud provider. The provider runs the whole agent loop on its own sandbox and opens a PR; Talyn streams the transcript back and links the resulting PR.
- **Self-fixing PRs.** Queue a PR for merge or flag it *keep mergeable*, and Talyn watches it: when it falls behind, hits a conflict, or fails CI, it automatically dispatches a cloud fix run — and the merge queue lands it once it's green (re-running flaky checks and updating the branch itself where GitHub allows).
- **Run skills on a PR.** Point an agent skill (a `SKILL.md`) at any PR — discovered from the PR's repo (`.claude/skills/`), your machine (`~/.claude/skills`), or skills saved to your Talyn workspace.

There is **no local execution** — no daemon, no SSH, no `claude` CLI to install, nothing running on your machine. The agent runs in the cloud.

---

## Expected workflow

1. **Open Talyn.** The GitHub panel's needs-attention bucket shows what came in — a review on one of your PRs, a failing check on another, a PR that's now mergeable.
2. **Triage the dashboard.** Your PRs are listed with live status pills. Open one to see checks, the diff, and the conversation. Merge the ready ones.
3. **Delegate the rest.** On a PR that needs work, kick off a cloud task (fix CI / address review), queue it for merge, or flag it keep-mergeable and let the auto-fix loop handle future breakage. Or compose a freeform task: pick a repo, write a prompt.
4. **Watch it run.** Click an in-progress task to see the streamed transcript. When the provider opens a PR, Talyn links it onto the task and the GitHub dashboard.
5. **Review on GitHub.** The agent's work lands as a normal PR — review and merge it like any other.

---

## Cloud providers

Talyn delegates work through a pluggable **cloud task provider** interface (`packages/backend/src/services/cloudProviders/`). A provider runs the agent loop on its own sandbox and opens a PR; Talyn creates the remote run, polls its status, and ingests the transcript.

Two providers are live — bring your own credentials for either (or both):

- **PostHog Code** — connect a PostHog personal API key + project id in **Settings → Integrations**.
- **Claude Code** (Anthropic Managed Agents) — connect an Anthropic API key; the agent reuses the workspace's GitHub connection.

A per-workspace default (or "Ask every time" picker) decides which provider each task goes to. **OpenAI Codex Cloud** is deferred — OpenAI exposes no server-to-server cloud-task API yet. See [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md).

---

## Getting started

Clone and install (monorepo — npm workspaces):

```bash
git clone git@github.com:Gilbert09/talyn.git
cd talyn
npm install
```

Run the app (starts the backend and the Electron desktop shell in parallel):

```bash
npm run dev
```

The backend listens on `localhost:4747`. See [`docs/SETUP.md`](./docs/SETUP.md) for environment/account setup (Supabase auth, hosted backend, database).

### Requirements

- Node.js ≥ 18 (22 recommended)
- A GitHub account (Talyn connects via a GitHub App installation)
- A cloud provider credential (a PostHog Code API key or an Anthropic API key) to actually run tasks

### Integrations

Configured from **Settings → Integrations** inside the app (the onboarding wizard walks through the same steps):

- **GitHub**: installs the Talyn GitHub App on your account/org — enables webhook-driven PR monitoring, the PR dashboard, merging, and PR review/response tasks.
- **PostHog Code**: a personal API key + project id — enables cloud task delegation.
- **Claude Code**: an Anthropic API key — same, via Anthropic's Managed Agents.

---

## Architecture at a glance

- **`apps/desktop/`** — Electron + React 19 + Tailwind + shadcn/ui. Talks to the backend over HTTP + WebSocket; renders the PR dashboard and cloud task transcripts.
- **`packages/backend/`** — TypeScript + Express + Postgres (Drizzle). Ingests GitHub webhooks (with polling reconciliation as the safety net), caches PRs, runs the merge queue + auto-keep-mergeable watcher, and delegates tasks to cloud providers via the `CloudTaskProvider` registry + poller.
- **`packages/cli/`**, **`packages/mcp-server/`** — thin `talyn` CLI + stdio MCP surface for tasks.
- **`packages/shared/`** — shared TypeScript types.

See [`CLAUDE.md`](./CLAUDE.md) and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full treatment.

---

## Commands

| Command                 | What it does                                                    |
| ----------------------- | --------------------------------------------------------------- |
| `npm run dev`           | Run backend + desktop in dev mode with hot reload.              |
| `npm run dev:backend`   | Backend only (watches `packages/backend`).                      |
| `npm run dev:desktop`   | Desktop only.                                                   |
| `npm run build`         | Build shared → backend → desktop in order.                      |
| `npm run lint`          | Lint all workspaces that have a `lint` script.                  |
| `npm run typecheck`     | Strict TypeScript type-check of all packages (no emit).         |
| `npm test`              | Run all workspace `test` scripts.                               |
| `npm run package`       | Package the desktop app for the local platform.                 |

---

## Project status

Talyn is under active development. In June 2026 it pivoted to a **cloud-only PR-management** app — the previous local-execution model (bundled daemon, local/SSH environments, in-process Claude agents, approval gates) was removed. See [`CLAUDE.md`](./CLAUDE.md) for orientation and active priorities, [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md) for the provider abstraction + roadmap, and [`docs/SESSIONS.md`](./docs/SESSIONS.md) for recent session notes.

Shipped: GitHub App connection with webhook-first PR monitoring, the PR dashboard (status pills, stacked PRs, detail sheet, merge), merge queue + auto-keep-mergeable self-fix runs (including flaky-check re-runs and branch updates), two cloud providers behind the `CloudTaskProvider` abstraction (PostHog Code + Claude Code) with a per-task provider picker, agent skills on PRs, live transcript streaming, PR linking, OS notifications, signed + notarized macOS builds with auto-update.

In flight: additional providers as server-side APIs appear (Codex Cloud is deferred — no server-to-server API), desktop test coverage, invite-based access.

---

## License

MIT © Talyn contributors.
