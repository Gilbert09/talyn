<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/icon-liquid-glass-dark.png">
  <img src="docs/assets/icon-liquid-glass-light.png" alt="Talyn" width="128">
</picture>

# Talyn

### Wake up to green PRs.

**Mission control for your GitHub pull requests, powered by cloud coding agents.**

Half your pull requests are failing, out of date, or waiting on someone. Talyn puts them all in
one list, worst first, and sends an AI coding agent to fix them — the failing tests, the merge
conflicts, the review comments. Trust it with a PR and it merges that PR itself, the moment it is
ready. Overnight included.

Agents run on the **Claude or ChatGPT subscription you already pay for** — no second token bill.

[**Download**](https://talyn.dev) · [**Open in browser**](https://app.talyn.dev) · [**talyn.dev**](https://talyn.dev) · [**Docs**](./docs)

[![Latest release](https://img.shields.io/github/v/release/Gilbert09/talyn?label=release&color=7c3aed)](https://github.com/Gilbert09/talyn/releases/latest)
[![CI](https://github.com/Gilbert09/talyn/actions/workflows/test.yml/badge.svg)](https://github.com/Gilbert09/talyn/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Web-lightgrey)

</div>

---

## The problem

AI writes the change in minutes. Landing it still takes all afternoon.

- **The refresh loop.** Ten GitHub tabs, hunting for the PR that just broke, got a comment, or went out of date.
- **One-line fixes, all afternoon.** A trivial fix still means pulling the branch, re-running everything, pushing, waiting.
- **It was fine on Tuesday.** You approved it Tuesday. It is Thursday, the project moved on, and now it conflicts.
- **Watching the robot work.** You start an agent, then sit and read its output so you can press merge yourself.

Talyn closes that loop. You pick the PR; the agent does the work; the merge queue lands it.

## What Talyn does

### 📊 Every PR, triaged — no tabs required

A live dashboard sorts your work into **Needs attention**, **Mine**, and **Review**, so the pull
request that actually blocks you is always on top. Check rollups, review state, stacked PRs grouped
under their parent, and a detail sheet with the diff, the checks, and the conversation. Updates
arrive webhook-first, so it tracks GitHub in near real time.

### 🤖 Delegate to a cloud agent

Point Talyn at a broken or stale PR and it hands the job to a cloud coding agent. The agent runs the
whole loop in its **own** sandbox — nothing runs on your machine, no CLI to install — and pushes the
fix back. You watch the transcript stream in live, and what comes back is green checks.

### 🔀 A merge queue that lands PRs for you

Flag a PR **keep-mergeable** and Talyn watches it: the moment it falls behind `main`, hits a
conflict, or goes red, a fix run dispatches automatically. The merge queue then lands your PRs in
order the second they are green — rebasing, clearing conflicts, and re-running flaky checks on the
way in — and drains independent PRs concurrently so one slow branch never holds up the rest.

### ⚡ Workflows — write the rule once, it runs on every PR

*When this happens on a pull request, do these things.* Trigger on opened, checks failed, review
requested, approved, commented, or merged. Narrow it by repo, base branch, label, author, or draft
state. Then act: add labels, request reviewers, post a comment, run a skill or a prompt, or send it
straight to the merge queue. Workflows watch **every** PR in your connected repos — including the
ones you did not open — and they run whether or not the app is open.

### 🔁 Loops — work that happens on a schedule

A prompt you want run again and again: sweep yesterday's failing checks every weekday morning, keep
dependencies current every Monday, draft the release notes every Friday at five. Pick a repository,
write the prompt, choose when — hourly, daily, weekdays, weekly, or a cron expression — and an agent
does it on its own, opening a pull request when the work warrants one. Schedules run in your own
timezone and hold their time across daylight-saving changes.

### 🪄 Skills — your playbooks, runnable on any PR

Reusable agent playbooks in the standard `SKILL.md` format: a security sweep, your team's review
checklist, a changelog writer. Talyn discovers them wherever they already live — committed to the
repo (`.claude/skills/`), on your machine (`~/.claude/skills`), or saved to your workspace. Pick one
on any PR and an agent runs it, posting the review or pushing the fix.

## Getting started

1. **Get Talyn.** [Download the desktop app](https://talyn.dev) — macOS (Apple silicon and Intel),
   Windows, and Linux — or [open it in your browser](https://app.talyn.dev) with nothing to install.
   Same product, same account; your workspaces follow you between them.
2. **Connect GitHub.** Sign in and install the Talyn GitHub App on the repos you work in. Your pull
   requests appear right away.
3. **Connect an agent** when you send your first fix — not before. Sign in with Claude or ChatGPT
   to run on your own subscription, or connect PostHog Code.
4. **Delegate.** Hit *fix this PR*, run a skill, queue it for merge, or write a workflow or loop and
   stop deciding each time.

> The desktop app adds two things a browser cannot: it reads skills from `~/.claude/skills` on your
> machine, and it keeps your session in the OS keychain.

## Runs on the plan you already pay for

Talyn conducts the coding agents you already trust rather than replacing them. Every provider sits
behind one `CloudTaskProvider` interface, so you connect the one you pay for and switch per task.

### Talyn Fleet — the default

Sign in with **Claude** or **ChatGPT** and your tasks run on that subscription. No API bill on top,
no metered credits. Each task gets its own Firecracker microVM on our hardware, and your credentials
are attached by a proxy *outside* the machine, so no token is ever inside the VM running the code.
The VM is destroyed when the task ends.

### PostHog Code

Already at PostHog? Connect a personal API key and project id in **Settings → Integrations** and it
powers the lot — fixes, conflicts, and review replies, end to end. Runs happen in PostHog's cloud,
under your account.

More providers are on the way; each is a self-contained module behind the same interface. See
[`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md).

## Pricing

**Free** — the whole dashboard, every repo, all providers, skills, and the merge queue, with up to
3 tasks running, 3 PRs queued, 3 workflows, and 3 loops at a time.

**Unlimited — $15/month** (or $150/year) — removes all four caps, keeps every new PR green
automatically, and never makes automation wait for a slot. Cancel any time, in app.

Either plan, you bring your own agent: runs execute on the subscription or provider account you
connect, not on Talyn's. Full details at [talyn.dev](https://talyn.dev/#pricing).

---

## Development

Talyn is an npm-workspaces monorepo. **Node.js ≥ 18** (22 recommended).

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
| `npm run dev` | Backend + desktop in dev mode with hot reload |
| `npm run dev:backend` / `dev:desktop` / `dev:web` / `dev:admin` | A single surface |
| `npm run dev:db` | Local Supabase stack (never point dev at production) |
| `npm run build` | Build shared → backend → desktop, in order |
| `npm run typecheck` | Strict type-check of every package, no emit |
| `npm run lint` | Lint every workspace with a `lint` script |
| `npm test` | Run every workspace `test` script |
| `npm run package` | Package the desktop app for the local platform |

### Layout

```
apps/desktop      Electron + React 19 + Tailwind + shadcn/ui
apps/web          app.talyn.dev — the browser app (Vite + React 19)
apps/admin        admin.talyn.dev — operator console
apps/marketing    talyn.dev — the marketing site (Next.js)
packages/backend  Express + WebSocket + Postgres (Drizzle); webhooks, merge queue, providers
packages/client   The single definition of the backend contract, shared by every front end
packages/cli      The `talyn` CLI
packages/mcp-server  stdio MCP surface for agents
packages/shared   Shared TypeScript types
```

### Docs

| Document | What is in it |
| --- | --- |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | System diagram, tech stack, key decisions |
| [`docs/CLOUD_PROVIDERS.md`](./docs/CLOUD_PROVIDERS.md) | The cloud task provider abstraction |
| [`docs/SETUP.md`](./docs/SETUP.md) | Environment variables and account setup |
| [`docs/TESTING.md`](./docs/TESTING.md) | Testing strategy and coverage |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | Phased TODO, backlog, known gaps |
| [`claude.md`](./claude.md) | Orientation for coding agents working on Talyn |

Contributions are welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) and our
[Code of Conduct](./CODE_OF_CONDUCT.md). To report a vulnerability, see
[`SECURITY.md`](./SECURITY.md).

## Status

Talyn is in **public beta** and under active development. Shipped: webhook-first PR monitoring, the
PR dashboard, the merge queue and auto-keep-mergeable self-fix runs, cloud task delegation behind a
pluggable provider abstraction with two live providers (Talyn Fleet and PostHog Code), workflows,
loops, skills on PRs, live transcript streaming, and signed and notarized macOS builds with
auto-update.

## License

[MIT](./LICENSE).
