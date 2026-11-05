---
title: Repository setup
description: Install dependencies, start your dev server and give the agent standing instructions, with .talyn/settings.toml, setup steps, dotfiles and repository instructions.
---

A new sandbox starts with your repository checked out. To be useful, it usually also needs your dependencies installed, a way to start your app, and some notes for the agent. This page covers each of those.

## Scripts in `.talyn/settings.toml`

Commit a file at `.talyn/settings.toml` to tell Talyn how to set up and run your repository:

```toml
[scripts]
setup = "pnpm install --frozen-lockfile"
run = "pnpm dev"
archive = "./scripts/cleanup.sh"
```

| Key | What it does |
| --- | --- |
| `setup` | Runs when a session's sandbox is set up. Install dependencies here. |
| `run` | Starts your app. The **Run** button in the terminal dock starts it. |
| `archive` | Runs when you archive the session. |
| `run_mode` | `"concurrent"` (the default) lets several run scripts run at once. `"nonconcurrent"` stops the others when you start one. |
| `files_to_copy` | A list of git-ignored files, such as `.env`, to copy into a new local session from your main checkout. Local sessions only. |

Each script can be a string, or a table with a `command` key:

```toml
[scripts.setup]
command = "bundle install && bin/rails db:setup"
```

### More than one run script

Give each run script a name. The one marked `default = true` is the one the **Run** button starts. If none is marked, the first one is the default.

```toml
[scripts.run.web]
command = "pnpm --filter web dev"
default = true

[scripts.run.worker]
command = "pnpm --filter worker dev"
```

### Variables your scripts can read

| Variable | Value |
| --- | --- |
| `TALYN_WORKBENCH_PATH` | The path of the session's checkout. |
| `TALYN_WORKBENCH_NAME` | The session's name. |
| `TALYN_ROOT_PATH` | The path of the repository's main checkout. |
| `TALYN_PORT` | The first of 10 ports reserved for the session, `TALYN_PORT` to `TALYN_PORT + 9`. |
| `TALYN_DEFAULT_BRANCH` | The repository's default branch. |

Use `TALYN_PORT` for your dev server, so two sessions never fight over one port.

### Preview ports

To tell Talyn which ports your app serves on, add a `[preview]` table:

```toml
[preview]
ports = [3000, { port = 6006, label = "Storybook" }]
```

Ports must be from 1024 to 65535. The first port is the main one, unless you mark another with `primary = true`.

### Coming from Conductor

Talyn reads `conductor.json` and `.conductor/settings.toml` too, so a repository set up for Conductor works with no changes. If there is more than one file, Talyn uses the first that it can read, in this order: `.talyn/settings.toml`, `conductor.json`, `.conductor/settings.toml`. Each `TALYN_*` variable also has a `CONDUCTOR_*` name.

## When there is no settings file

With no settings file, Talyn looks at the files in your repository and works out the commands.

For setup, it uses the lockfile it finds:

| File | Command |
| --- | --- |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| `bun.lock` or `bun.lockb` | `bun install` |
| `yarn.lock` | `yarn install` |
| `package-lock.json` | `npm ci` |
| `package.json` only | `npm install` |
| `uv.lock` | `uv sync` |
| `poetry.lock` | `poetry install` |
| `Gemfile` | `bundle install` |
| `go.mod` | `go mod download` |
| `Cargo.toml` | `cargo fetch` |

For run, it uses the `dev` script in `package.json`, or the `start` script if there is no `dev`.

When Talyn uses a detected command, the terminal says so and offers **Save to .talyn/settings.toml**. Select it to write the commands to a file that you can edit and commit.

## Setup steps and the sandbox image

Talyn builds an image for each repository with its setup already run. A new session starts from that image, not from a clean machine, so it is ready sooner.

To see and change a repository's setup:

1. Open **Settings > Repositories** in the desktop app, or **Settings > Workspace** in the web app.
2. Find the repository and open **Setup**.

The list shows the repository's own setup command and any extra steps. Each new box runs the list in order. Steps that run in the image go into a shared image, so a new box starts with their result. Steps that run on each box run after the box starts.

Talyn can also suggest steps. When it sees your sessions run the same setup command again and again, it suggests adding it. You can accept or dismiss each suggestion. To stop new suggestions, turn off **Learn setup steps from sessions**.

A step cannot contain a secret, because the image is shared. A step that reads a secret runs on each box and never in the image.

## Dotfiles and workspace steps

**Settings > Sandbox setup** applies to every repository in the workspace.

**Dotfiles**: pick a repository with your dotfiles, an optional branch, tag or commit, and an install command such as `./install.sh`. Each image clones the repository and runs the command before any other setup step. Talyn clones a private dotfiles repository with your GitHub connection, read-only, and never stores the token in an image. The install command cannot read a secret.

**Steps**: setup steps that run for every repository, after the dotfiles and before each repository's own steps.

A change here rebuilds your images for each repository the next time you start a session there.

## Instructions for the agent

The agent reads the instruction files in your repository, such as `CLAUDE.md` or `AGENTS.md`, the same way it does on your computer.

To add instructions that are not committed to the repository, use **repository instructions**:

1. Open **Settings > Instructions**.
2. Under **Repository instructions**, pick the repository.
3. Write the instructions in Markdown, for example how to run the tests.
4. Choose which agents get them: **Claude**, **Codex**, or **Claude and Codex**.

Talyn adds them to every session on that repository. The limit is 64 KB for each repository.

### Your own instruction files

In the desktop app, **Settings > Instructions** also lists instruction files from your computer, such as `~/.claude/CLAUDE.md`, `~/.claude/rules/*.md` and `~/.codex/AGENTS.md`. Switch a file on, and Talyn copies it into your sandbox sessions before each turn. Local sessions already read these files from your computer.

## Secrets

Talyn has no setting for environment variables or secrets in a sandbox, and setup steps and dotfiles cannot read secrets. If the agent needs a service that has an MCP server, such as Linear or Sentry, connect it as an [MCP server](/docs/mcp-servers). Talyn keeps that key outside the sandbox.
