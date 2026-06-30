# FastOwl

**Mission control for your GitHub PRs, powered by cloud coding agents.**

FastOwl is a desktop app that tracks your open and review-requested pull requests, surfaces the ones that need attention (new reviews, comments, CI failures, merge conflicts), and lets you hand the routine work — fixing failing CI, addressing review comments, drafting a review — to **cloud coding agents** that run on their own sandbox and open a PR for you. Flag a PR and FastOwl keeps it mergeable on its own, firing a cloud fix run whenever it falls behind or goes red.

If you live in GitHub PRs and want to delegate the rote drudgery without babysitting a local agent, FastOwl is for you.

---

## Why FastOwl

Keeping on top of your PRs today means:

- Refreshing GitHub to see which PRs got a review, a comment, or a red check
- Context-switching back into a branch just to push a one-line CI fix
- Manually kicking off an agent, then watching it, then opening the PR yourself

FastOwl consolidates that:

- **A live PR dashboard.** Every watched repo's PRs with a check-rollup status pill, review status, and a detail sheet (summary / checks / files / conversation). Needs-attention / Mine / Review buckets keep the list triaged. Merge straight from the app.
- **Delegate to a cloud agent.** From a PR row ("fix this PR") or as a freeform task on a repo, FastOwl hands the prompt to a cloud provider. The provider runs the whole agent loop on its own sandbox and opens a PR; FastOwl streams the transcript back and links the resulting PR.
- **Self-fixing PRs.** Queue a PR for merge or flag it *keep mergeable*, and FastOwl watches it: when it falls behind, hits a conflict, or fails CI, it automatically dispatches a cloud fix run — and the merge queue lands it once it's green.

There is **no local execution** — no daemon, no SSH, no `claude` CLI to install, nothing running on your machine. The agent runs in the cloud.

---

## Expected workflow

1. **Open FastOwl.** The GitHub panel's needs-attention bucket shows what came in — a review on one of your PRs, a failing check on another, a PR that's now mergeable.
2. **Triage the dashboard.** Your PRs are listed with live status pills. Open one to see checks, the diff, and the conversation. Merge the ready ones.
3. **Delegate the rest.** On a PR that needs work, kick off a cloud task (fix CI / address review), queue it for merge, or flag it keep-mergeable and let the auto-fix loop handle future breakage. Or compose a freeform task: pick a repo, write a prompt.
4. **Watch it run.** Click an in-progress task to see the streamed transcript. When the provider opens a PR, FastOwl links it onto the task and the GitHub dashboard.
5. **Review on GitHub.** The agent's work lands as a normal PR — review and merge it like any other.

---

## Task types

Every task is delegated to a cloud provider.

| Type           | Typical use                                                        |
| -------------- | ------------------------------------------------------------------ |
| `code_writing` | Freeform: pick a repo, write a prompt. The agent opens a PR.       |
| `pr_response`  | Fix failing CI / address review comments on one of your open PRs.  |
| `pr_review`    | Draft review comments on a PR.                                     |

---

## Cloud providers

FastOwl delegates work through a pluggable **cloud task provider** interface (`packages/backend/src/services/cloudProviders/`). A provider runs the agent loop on its own sandbox and opens a PR; FastOwl creates the remote run, polls its status, and ingests the transcript.

- **PostHog Code** — the live provider today. Connect a personal API key + project id in **Settings → Integrations**.
- **OpenAI Codex Cloud**, **Claude Code Routines** — planned drop-ins behind the same interface. See [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md).

---

## Getting started

Clone and install (monorepo — npm workspaces):

```bash
git clone git@github.com:Gilbert09/owl.git fastowl
cd fastowl
npm install
```

Run the app (starts the backend and the Electron desktop shell in parallel):

```bash
npm run dev
```

The backend listens on `localhost:4747`. See [`docs/SETUP.md`](./docs/SETUP.md) for environment/account setup (Supabase auth, hosted backend, database).

### Requirements

- Node.js ≥ 18 (22 recommended)
- A GitHub account (connected via OAuth from Settings)
- A cloud provider account (e.g. PostHog Code) to actually run tasks

### Integrations

Configured from **Settings → Integrations** inside the app:

- **GitHub**: OAuth flow — enables PR monitoring, the PR dashboard, and PR review/response tasks.
- **PostHog Code**: a personal API key + project id — enables cloud task delegation.

---

## Architecture at a glance

- **`apps/desktop/`** — Electron + React 19 + Tailwind + shadcn/ui. Talks to the backend over HTTP + WebSocket; renders the PR dashboard and cloud task transcripts.
- **`packages/backend/`** — TypeScript + Express + Postgres (Drizzle). Monitors GitHub, caches PRs, runs the merge queue + auto-keep-mergeable watcher, and delegates tasks to cloud providers via the `CloudTaskProvider` registry + poller.
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

FastOwl is under active development. As of June 2026 it pivoted to a **cloud-only PR-management** app — the previous local-execution model (bundled daemon, local/SSH environments, in-process Claude agents, approval gates) was removed. See [`CLAUDE.md`](./CLAUDE.md) for orientation and active priorities, [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md) for the provider abstraction + roadmap, and [`docs/SESSIONS.md`](./docs/SESSIONS.md) for recent session notes.

Shipped: GitHub OAuth + PR monitoring + PR dashboard (status pills, detail sheet, merge), merge queue + auto-keep-mergeable self-fix runs, cloud task delegation via the `CloudTaskProvider` abstraction (PostHog Code), live transcript streaming, PR linking.

In flight: additional providers (Codex Cloud, Claude Routines), per-provider Settings/composer UI.

---

## License

MIT © FastOwl contributors.
