<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/icon-liquid-glass-dark.png">
  <img src="docs/assets/icon-liquid-glass-light.png" alt="Talyn" width="128">
</picture>

# Talyn

### Give every task its own agent.

Each session is a branch with its own coding agent, diff and terminal in the cloud. Run as many as you
like at once, on the Claude or ChatGPT plan you already have. Each one can open a pull request, and
Talyn keeps that pull request green until it merges.

[**Download**](https://github.com/Gilbert09/talyn/releases/latest) · [**Open in browser**](https://app.talyn.dev) · [**talyn.dev**](https://talyn.dev) · [**Docs**](https://talyn.dev/docs)

[![Latest release](https://img.shields.io/github/v/release/Gilbert09/talyn?label=release&color=7c3aed)](https://github.com/Gilbert09/talyn/releases/latest)
[![CI](https://github.com/Gilbert09/talyn/actions/workflows/test.yml/badge.svg)](https://github.com/Gilbert09/talyn/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey)

</div>

---

## What Talyn is

Talyn is a desktop and web app for people who hand work to coding agents and then have to land it.

**Sessions.** Describe a task. Talyn makes a branch, starts a cloud sandbox and hands the task to Claude Code or Codex. You read the diff, browse the files, open a terminal or start your app. One button opens the pull request. You can run many sessions side by side, and none of them touch each other's files.

**Threads.** A thread is one conversation that runs sessions across several repositories. Give it a goal. It starts a session on each repository that needs a change, follows them, and waits for you when they stop making progress.

**Pull requests.** The GitHub panel lists every PR you own and every review you owe, blocked ones first. One click sends an agent to fix failing checks, merge conflicts or review comments. The merge queue lands a PR when it is green.

Agents run on your own Claude or ChatGPT subscription. You do not paste an API key and there is no metered token bill.

## Features

- **Sessions and threads.** Parallel agents, each with its own sandbox, branch, diff and terminal.
- **Sandboxes.** Ready in seconds from an image of your repository. An idle sandbox sleeps after 10 minutes, and a sleeping sandbox is free.
- **PR dashboard.** My PRs and Reviews, triaged worst first, with a detail sheet for the diff, checks and conversation.
- **Fix runs.** An agent fixes failing checks, conflicts and review comments and pushes to the same branch.
- **Merge queue.** Queue a ready PR. If it falls behind or breaks first, an agent fixes it.
- **Code review.** Several reviewers read a change and a final check drops what it cannot back up. Findings stay in the app unless you post them to GitHub.
- **Workflows.** Rules for pull request events, such as "when checks fail on a dependency bump, send an agent".
- **Loops.** A prompt on a schedule, such as every weekday at 9 or any cron expression.
- **Skills.** Run your `SKILL.md` playbooks on any pull request.
- **MCP servers.** Connect Linear, Sentry or your own server. The agent uses the tools and the keys stay outside the sandbox.
- **Slack.** Start a session from a reaction, a mention or a message.
- **Public API and hosted MCP server.** Start sessions and read results from your own scripts. See [`docs/PUBLIC_API.md`](./docs/PUBLIC_API.md) and [`docs/MCP_SERVER.md`](./docs/MCP_SERVER.md).

## Get Talyn

- **Desktop app** for macOS, Windows and Linux: [GitHub releases](https://github.com/Gilbert09/talyn/releases/latest) or [talyn.dev](https://talyn.dev).
- **Browser:** [app.talyn.dev](https://app.talyn.dev). Same product, same account, nothing to install.

Then sign in, connect GitHub, and connect Claude or ChatGPT when you start your first session. Read the [docs](https://talyn.dev/docs) for more.

The free plan includes the whole app with a small monthly allowance of box-hours. Prices are on [talyn.dev/pricing](https://talyn.dev/pricing).

## Status

Talyn is in public beta. It works with GitHub only.

- Windows installers are not code-signed yet, so SmartScreen warns on first install.
- The download button on talyn.dev serves the Apple silicon build for macOS. On an Intel Mac, take the x64 build from the [releases page](https://github.com/Gilbert09/talyn/releases).

---

## Development

Talyn is an npm-workspaces monorepo. You need Node.js 18 or newer (22 recommended).

```bash
git clone git@github.com:Gilbert09/talyn.git
cd talyn
npm install
npm run dev          # backend + Electron desktop shell, hot reload
```

The backend listens on `localhost:4747`. See [`docs/SETUP.md`](./docs/SETUP.md) for environment and
account setup (Supabase auth, database, GitHub App).

| Command | What it does |
| --- | --- |
| `npm run dev` | Backend and desktop in dev mode with hot reload |
| `npm run dev:backend` / `dev:desktop` / `dev:web` / `dev:admin` | A single surface |
| `npm run dev:db` | Local Supabase stack (never point dev at production) |
| `npm run build` | Build shared, client, backend and desktop, in order |
| `npm run typecheck` | Type-check every package, no emit |
| `npm run lint` | Lint every workspace with a `lint` script |
| `npm test` | Run every workspace `test` script |
| `npm run package` | Package the desktop app for the local platform |

### Layout

```
apps/desktop      Electron + React 19 + Tailwind + shadcn/ui
apps/web          app.talyn.dev, the browser app (Vite + React 19)
apps/admin        admin.talyn.dev, the operator console
apps/marketing    talyn.dev, the marketing site (Next.js)
packages/backend  Express + WebSocket + Postgres (Drizzle); webhooks, merge queue, providers
packages/client   The single definition of the backend contract, shared by every front end
packages/cli      The `talyn` CLI
packages/shared   Shared TypeScript types
```

### Docs

| Document | What is in it |
| --- | --- |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | System diagram, tech stack, key decisions |
| [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md) | The cloud task provider abstraction |
| [`docs/SETUP.md`](./docs/SETUP.md) | Environment variables and account setup |
| [`docs/TESTING.md`](./docs/TESTING.md) | Testing strategy and coverage |
| [`docs/PUBLIC_API.md`](./docs/PUBLIC_API.md) | The public REST API |
| [`docs/MCP_SERVER.md`](./docs/MCP_SERVER.md) | The hosted MCP server (`/api/v1/mcp`) and its tools |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | Phased TODO, backlog, known gaps |
| [`docs/SESSIONS.md`](./docs/SESSIONS.md) | Build notes, newest first, including what did not work |
| [`claude.md`](./claude.md) | Orientation for coding agents working on Talyn |

Contributions are welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and the
[Code of Conduct](./CODE_OF_CONDUCT.md). To report a vulnerability, see [`SECURITY.md`](./SECURITY.md).

## License

[MIT](./LICENSE).
