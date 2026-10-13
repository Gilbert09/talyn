# Workbenches — a sandbox-native Conductor inside Talyn

> Status: **exploration on branch `tom/workbenches`**. Not on `main`, not deployed.
> Companion fleet branch: `yetanothersandbox-dev/yas` → `tom/workbench-endpoints` (not deployed).

## What it is

A **Workbench** is a Conductor.build-style "workspace": one branch of one repository, with
a long-running chat with a coding agent (Claude Code or Codex), a live diff, a terminal,
setup/run/archive scripts, checkpoints, and a Create PR → Fix checks → Merge → Archive flow.
("Workspace" already means a group of repos in Talyn, so this unit is a *Workbench*.)

A workbench has a **runtime**:

- **`sandbox`** (the default) — one long-lived, non-ephemeral Talyn Fleet microVM per
  workbench. The backend drives it.
- **`local`** — a `git worktree` on the user's machine, driven by the Electron main process.
  Desktop only.

Both runtimes sit behind one UI and one set of shared primitives (`packages/shared`).

## Phase 0 spike result (2026-10-13)

Run against the production fleet with the `yas` CLI, on a fresh anthropic-provider box:

| Check | Result |
|---|---|
| Box create (`yas new`) | up in **~1 s** |
| `git clone https://github.com/<repo>` inside the box | works — the guest's git config rewrites github.com to the proxy (`http://127.0.0.1:8080/gh/`) |
| `claude -p … --output-format stream-json --verbose` (Claude Code 2.1.x) | works; credentials attached by the proxy, nothing in the guest. Clone + first turn: 8.8 s |
| Turn 2 with `--resume <session_id>` in a NEW exec | **recalls turn 1** (codeword test). 3.6 s |
| `suspend` the box, then a turn-3 exec | auto-resumes; recall still works; 6.3 s end to end |
| Codex in an `openai`-provider box | **not verified** — blocked by the local auto-mode guard on the `--dangerously-bypass-approvals-and-sandbox` flag. Expected to work the same way (`codex exec --json`, then `codex exec resume <id> --json`). |
| Fleet `POST /tasks` (pi harness) | **not spiked** — option A passed every criterion and gives parity the pi harness cannot (plan mode, slash commands, skills, the same parser as local mode). |

**Decision: Option A — the real `claude` / `codex` CLIs, one process per turn, run via
`POST /v1/sandboxes/{id}/exec?follow=1` in a sandbox and via `child_process.spawn` locally.**
One stream parser (`packages/shared/src/agentStream.ts`) serves both runtimes.

Consequences to respect:

- **A sandbox's LLM vendor is fixed at create** (`provider` decides the box's egress route
  table). A workbench therefore has ONE agent vendor for its sandbox; a chat tab on the other
  vendor needs a second sandbox or is refused. v1: the workbench's `agent` is fixed at
  creation for sandbox workbenches; local workbenches may mix.
- **exec has no stdin**: no mid-turn steering in the sandbox. Messages sent while a turn runs
  are QUEUED and drained when it ends. (`--permission-mode` is chosen per turn; interactive
  permission prompts are local-only.)
- **exec output goes into the sandbox's events ring** as
  `{type:"exec_output", subtype:"stdout"|"stderr", raw:{stream, data}}` frames, then exactly
  one `{type:"exec_exit", raw:{exitCode, signal?, timedOut?}}` (or `exec_error`). `data` is an
  arbitrary chunk — **buffer stdout and split on `\n`** before JSON-parsing stream-json lines.
  Use the cursor returned by the exec to read only that command's frames.
- Workbench sandboxes are created **without `ephemeral`** so they survive turns; the fleet
  suspends them after 600 s idle and auto-resumes on the next exec/task/ssh.

## Fleet API used (production, today)

All under the gateway with the tenant bearer token (`FleetClient` in
`packages/backend/src/services/selfHosted/client.ts`):

- `POST /v1/sandboxes` — create. Workbench body: `{ id, workspaceId, provider, githubToken,
  anthropicKey|openaiKey, policy, mcpServers?, gitAuthorName?, gitAuthorEmail? }` with NO
  `task` and NO `ephemeral` (bare, long-lived). The repo is cloned by the first exec.
- `POST /v1/sandboxes/{id}/exec[?follow=1]` — body `{cmd: string[], shell?, cwd?, env?, timeoutMs?}`.
- `GET /v1/sandboxes/{id}/events?after=N[&follow=1]`.
- `POST /v1/sandboxes/{id}/ssh` `{publicKeys: string[]}` + `GET /v1/sandboxes/{id}/ssh-stream`
  (HTTP upgrade spliced onto guest sshd) — the terminal fallback.
- `POST /v1/sandboxes/{id}/suspend`, `POST /v1/sandboxes/{id}/resume`, `DELETE /v1/sandboxes/{id}`.

New on the YAS branch (probed; Talyn falls back on 404): `GET /diff`, `GET /files`,
`GET /pty` (websocket PTY), `ANY /ports/{port}/*` (preview), `exec` with `quiet:true`,
per-sandbox `idleTtlSec`.

## Data model (migration `0076_workbenches.sql`)

- `workbenches` — `id, workspace_id, repository_id, name (city), branch, base_branch,
  runtime ('sandbox'|'local'), agent ('claude'|'codex'), device_id, local_path, sandbox_id,
  sandbox_state, status, pull_request_id, settings jsonb, archived_at, created_at, updated_at`.
- `workbench_chats` — `id, workbench_id, title, agent, model, effort, plan_mode,
  agent_session_id, status ('idle'|'running'|'awaiting_input'|'error'), queued_messages jsonb,
  created_at, updated_at`.
- `workbench_events` — APPEND-ONLY `(chat_id, seq)` unique, `turn int, event jsonb, created_at`.
  Never a growing jsonb column on a row (the transcript disk-IO lesson). Paged by `seq`.
- `workbench_checkpoints` — `chat_id, turn, ref, sha, created_at`.

## Shared primitives (`packages/shared`)

- `workbench.ts` — types, statuses, `WorkbenchRuntime` interface, city names, `nextAction()`.
- `workbenchGit.ts` — git operations as **argv lists + output parsers**, executed by either
  runtime (local `execFile`, sandbox `/exec`). Diff vs base, numstat, status, checkpoint
  create/restore (hidden commits under `refs/talyn/checkpoints/<chat>/<turn>`, never touching
  the branch or the index), branch rename, conflict detection.
- `agentStream.ts` — claude stream-json + codex `--json` → Talyn `AgentEvent`, plus derived
  session id, todos (TodoWrite), context usage, final result. CLI argv builders for both agents.
- `workbenchConfig.ts` — `.talyn/settings.toml` → `conductor.json` → `.conductor/settings.toml`:
  setup/run/archive scripts, named run scripts, `run_mode`, files-to-copy; env vars
  `TALYN_WORKBENCH_PATH`, `TALYN_WORKBENCH_NAME`, `TALYN_ROOT_PATH`, `TALYN_PORT`..+9
  (and the `CONDUCTOR_*` aliases, so existing Conductor scripts work unchanged).

## Gate

`workbenches` PostHog flag, `fallback: false`, `availability: 'gated'`, env override
`WORKBENCHES_ENABLED` (so it can run locally with no PostHog project). Every route and the
terminal WS bridge gate server-side. Billing gates: deliberately out of scope for the
exploration (follow-up).

## Follow-ups / known gaps

- Web app (`apps/web`) and mobile.
- Billing: a workbench turn spends the user's own subscription; decide whether sandboxes count
  against the plan.
- Codex-in-sandbox verification.
- Deploy the YAS branch endpoints; until then diff/files run through `exec` (and their frames
  land in the events ring) and the terminal goes over ssh-stream.

## State of the build (2026-10-13)

Built on `tom/workbenches`, in five parts:

| Part | Where | Verified by |
|---|---|---|
| Shared core, flag, client contract | `packages/shared/src/{workbench,workbenchGit,agentStream,workbenchConfig}.ts`, `packages/client` | 508 unit tests, real-git checkpoint test |
| Backend sandbox runtime | `packages/backend/src/services/workbenches/`, `routes/workbenches.ts`, migration `0076` | 1035 tests against a FAKE fleet |
| Local worktree runtime | `apps/desktop/src/main/workbench/` | 44 jest tests, real temp git repos, fake CLI |
| Desktop UI | `apps/desktop/src/renderer/components/workbench/` | 75 new jest tests |
| Fleet endpoints | yas `tom/workbench-endpoints` | Go tests, macOS + Linux container, no microVM |

**Not yet done: a full run of the app against a real sandbox.** The spike proved the
primitives (create, clone, claude turn, resume, suspend) and the guest has the tools the
exec wrapper needs (`sed -u`, `base64 -w`, `tmux`, `setsid`, `pkill`; the guest user is
`fleet`). The backend, the UI and the fleet together have not run end to end.

### How to run it locally

1. `npm run dev:db` (local Supabase), then apply migrations.
2. Backend env: `WORKBENCHES_ENABLED=true`, `FLEET_ENABLED=true`, and the fleet gateway
   variables (`FLEET_PINNED_ENDPOINT`, `FLEET_GATEWAY_TOKEN` / `FLEET_API_TOKEN`). The local
   `.env` has no fleet variables today.
3. Connect a Claude subscription in Settings, so the workspace has a fleet credential.
4. Start the desktop app. "Workbenches" shows in the sidebar.
5. Local mode needs `claude` or `codex` on the PATH, and `node-pty` rebuilt for Electron
   (`npm run rebuild` in `apps/desktop/release/app`).

### Backend decisions that differ from the plan

- **Tagged exec framing.** The events ring is per sandbox, so two commands that run at the
  same time mix their output. Each exec is wrapped: every line carries a nonce tag, and a
  tagged trailer gives the exit code (`services/workbenches/execFraming.ts`).
- **The router is mounted before `ownerScope`**, like billing. Handlers wait on the fleet,
  and a scoped transaction would hold a pool connection for that time.
- **Seq allocation** is one CTE statement on `workbench_chats.next_seq`. No advisory lock.
- **Archive** pushes commits to the branch (never forced) and saves uncommitted work as a
  hidden commit at `refs/talyn/archive/<id>`. A failed save keeps the sandbox.
- **Terminal**: the fleet `/pty` first; on `409 pty_unsupported`, `ssh2` over `ssh-stream`.

### Known gaps

- The boot sweep that stops orphaned turns assumes ONE backend replica. A deploy overlap
  would stop a live replica's turns. Fix this before any production use.
- The preview proxy needs a Bearer token, so an iframe cannot load it directly.
- `stream_event` deltas are stored without pruning.
- `openSshStream` and `openPty` do not use `FLEET_HTTP_PROXY`.
- Sandbox: pasted images are not sent. Local: archive does not remove the worktree.
- macOS: the menu's close item takes ⌘W before the renderer sees it.
- No billing gates. Not verified on a real fleet: Codex in a sandbox, and GitHub accepting a
  push to `refs/talyn/*`.
- The new fleet routes `/pty` and `/ports` need guests booted from a newly baked golden.
