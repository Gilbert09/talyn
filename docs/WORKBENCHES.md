# Workbenches — a sandbox-native Conductor inside Talyn

> Status: **exploration on branch `tom/workbenches`**. Not on `main`, not deployed.
> Fleet: `tom/workbench-endpoints` and the Claude Code 2.1.296 image are deployed on YAS `main`.
> `tom/bare-box-repo` is not.
>
> **Name.** Users see "session" (from 2026-10-14). The code, routes, tables, IPC channels and
> these docs keep "workbench".

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

## Your instruction files in sandboxes (migration `0077_workbench_instruction_files.sql`)

A local session reads the user's `~/.claude/CLAUDE.md` and friends from disk. A sandbox does
not have them, so Settings → Sessions → "Your instructions" lists them (desktop only, via the
`workbench:instruction-files` IPC: `~/.claude/CLAUDE.md`, `~/.claude/rules/**/*.md`,
`~/.codex/AGENTS.md`, and `CLAUDE.local.md` in each repo with a chosen local folder). Claude
`@path` imports are inlined on the Mac (`inlineInstructionImports` in
`shared/workbenchInstructions.ts`), because the box has none of the imported files. A file the
user switches on is uploaded to `workbench_instruction_files` (content only there, never in
`workspaces.settings`; the list route never returns it; 256 KB cap, about 64k tokens of every
turn). Switching off keeps the row with empty content, so the next turn removes the copy. The
desktop re-uploads a switched-on file whose hash changed, at start and when the section opens.
Before each sandbox turn, `syncInstructionFiles` (non-fatal) writes the session agent's files
with base64 in exec env chunks (`sandboxFiles.ts`, shared with attachments): Claude files go
to `$HOME/.claude/rules/talyn-<slug>.md` (stale `talyn-*.md` removed; the fleet's own
`$HOME/.claude/CLAUDE.md` is never touched), a repo's `CLAUDE.local.md` goes in the repo and
into `.git/info/exclude`; Codex gets one `<!-- talyn:instructions:start/end -->` block at the
end of `$HOME/.codex/AGENTS.md`, replaced on every turn because a reboot rewrites that file. A
workspace that never stored a file for the agent pays no exec.

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

## Previews: run a session's app and open it (2026-10-24)

A session can run its repository's app and open it in a browser. Each repository has a
**preview target**: `sandbox`, `coder` or `off`. The `workbenches` flag gates previews. They
have no flag of their own.

- **Target and ports.** `repositories.settings` (migration `0082`) stores the person's choice
  and the detected answer. The choice wins over `.talyn/settings.toml` `[preview]`, and the file
  wins over detection. `detectPreview` (`packages/shared/src/previewDetect.ts`) reads a fixed
  list of files from the default branch. Detection is cached by the branch SHA. Coder signals
  are `[preview.coder]`, `hogli.yaml` `coder_url`, a `.coder/` directory and Coder Terraform.
  Port signals are `[preview].ports`, devcontainer `forwardPorts`, compose ports and the dev
  server defaults in `package.json`.
- **Sandbox target (desktop).** `main/workbench/previewForward.ts` starts a server on
  `127.0.0.1` with the same port number when it is free. It forwards HTTP and WebSocket
  requests to `/workbenches/:id/ports/:port/*` with the person's Bearer token. The backend
  splices WebSockets to the fleet route (`services/preview/portsWs.ts`), so dev-server HMR
  works. The forward accepts only loopback Host and Origin headers, and it removes the
  browser's cookies.
- **Coder target (desktop only).** A Coder deployment such as PostHog's is on the person's
  tailnet, so the backend cannot reach it. The desktop uses the person's own `coder` CLI
  (`main/workbench/coder.ts`). Talyn stores no Coder token. The flow makes a worktree at
  `~/.talyn/previews/<session>` from the repository checkout in the Coder workspace. It applies
  `GET /workbenches/:id/patch` (the session's changes against its base, untracked files
  included) after `git reset --hard <base>` and `git clean -fdq`. It runs the run command in
  tmux, and opens the template's app URL or a `coder port-forward`. It syncs again after each
  turn. One preview runs per Coder workspace, because the stack uses fixed ports.
- **Hosted URLs** on `*.preview.talyn.dev` are not built. They are for the web app and for
  share links: a one-time ticket sets a host-only cookie on a random host name.

Known gaps: not run end to end on a real repository. A new Coder worktree has no
`node_modules` or Python environment, so the first run must install them. Two compose stacks
can start if the project name comes from the directory name.

## Follow-ups / known gaps

- Web app (`apps/web`) and mobile.
- Billing: a workbench turn spends the user's own subscription; decide whether sandboxes count
  against the plan.
- Codex-in-sandbox verification.
- Deploy the YAS branch endpoints; until then diff/files run through `exec` (and their frames
  land in the events ring) and the terminal goes over ssh-stream.

## State of the build (2026-10-14)

The desktop app is now code-first: it opens on workbenches, and the PR features are one area
inside it.

| Part | Where |
|---|---|
| Shell | `layout/AppShell.tsx`, `AppSidebar.tsx`, `stores/navigation.ts` (route union), `lib/shortcuts.ts` + `layout/appShortcuts.ts`, `CommandPalette.tsx` (⌘K) |
| Menu chords | `main/menuCommands.ts`: the Electron menu owns ⌘N, ⌘W, ⌘T and the rest, and sends `menu:command` to the renderer. Close Window is ⌘⇧W. |
| Home | `pages/NewWorkbenchPage.tsx`: one composer. Enter creates the workbench and starts it. Names come from the task (`workbenchNameFromTask`). |
| Workbench | `WorkbenchView.tsx`, `WorkbenchHeader.tsx` (one action button: Create PR → Resolve conflicts → Fix checks → Merge → Archive), `GitPanel.tsx` (All files / Changes / Checks, terminal dock) |
| Other pages | `pages/HistoryView.tsx`, `PullRequestsView.tsx` (the five PR panels), `AutomationsView.tsx` (Workflows, Loops, MCP servers) |
| Readiness | `GET /workbenches/readiness` + Electron `workbench:readiness`, merged by `lib/readiness.ts`. A choice that cannot run is disabled with its reason, and create refuses before it inserts a row. |
| Failure handling | One provisioning failure path (status and sandbox state `error`, a readable reason, queued messages cleared). `POST /workbenches/:id/retry`. |

**Verified against the real fleet (2026-10-14), through the local backend's API:** readiness,
retry, provisioning (about 10 s with the clone), two turns with recall, a file edit, changes,
diff, file list and read, the terminal (as user `fleet`), and checkpoint restore.

**Also on 2026-10-14:**
- **A hibernated box resumes by itself.** When a box has been idle for some time, the fleet
  moves it to object storage. It then answers every call with 409 `remote_resume_required`
  until somebody calls `POST /resume`. The workbench fleet client (`withWake` in
  `sandboxRuntime.ts`) now resumes the box once, and then sends the call again. One resume
  runs for many calls at the same time. `NO_WAKE` lists the calls that must never resume a
  box (create, suspend, resume and delete). A resume can take minutes for a large box, and
  the panels only show "loading" for that time.
- **Claude Code in the image is 2.1.296.** 2.1.245 refused Opus 5.5 with a 400. A box keeps
  the disk it was created with, so a box from before the change keeps the old CLI.
- **Chat totals.** Each turn that completes has no footer of its own now. One bar under the
  transcript shows the turns, the cost and the tokens for the chat (`chatTotals`). "In"
  includes cache reads and writes. A turn that ends with an error keeps its footer.
- **CI.** The branch failed CI on every push until `400fd89dc5`. The cause was a `node-pty`
  type import from `release/app/node_modules`, which CI does not install. Two more causes were
  found after it: route wiring that ran when `stores/navigation.ts` loaded (now
  `installNavigation()`, called from `index.tsx`), and the data API boundary test, which did
  not list the session tables' grants.

**Not verified:** Create PR. The push was refused because the local-dev GitHub App
`talyn-app-dev` has Contents: read. The production App has write. Merge and Archive from the new
header have not run against a real PR.

**Create PR goes through the chat, but the agent does not push.** The button sends the short
message "Create a pull request" with the `create_pr` intent (a running turn queues it). The
transcript shows only that text. The agent also gets Talyn's instructions: Claude through
`--append-system-prompt` for that turn, Codex in front of the prompt argument. The instructions
tell it to read the branch's changes and the PR template, not to commit, push or run `gh`, and
to end its reply with a ```` ```talyn-pr ```` block (`title`, `body`, `commitMessage`, `draft`).
When the turn ends well, Talyn parses the last such block and commits what is uncommitted,
checks that the branch is ahead of the base, pushes and opens the PR through the GitHub API, and
links it. A sandbox does this in `services/workbenches/pullRequest.ts`
(`openPullRequestFromTurn`, called from `turns.ts`). A local session does it in
`LocalTurnController.handleTurnEnd`: it commits and pushes with the user's own git credentials,
then calls `POST /workbenches/:id/pull-request` with `pushed: true`. The chat stays `running`
until this is done, so a queued message cannot change what is committed. The outcome goes into
the thread as a `talyn_pr` event (the PR link, or the error such as the GitHub App's
Contents: write message), and a failure also shows a toast. A failed or cancelled turn opens
nothing. The instructions, the git steps and the parser are in `@talyn/shared`
`workbenchPullRequest.ts`. `settings.prompts.create_pr` is extra instructions, appended to
Talyn's.

### How to run it locally

1. `npm run dev:db` and `npm run dev:redis`.
2. Backend env (local-dev `.env` only): `FLEET_PINNED_ENDPOINT=https://api.yetanothersandbox.dev`
   and `FLEET_GATEWAY_TOKEN` (a key from `yas keys create <name>`). Start the backend with
   `WORKBENCHES_ENABLED=true FLEET_ENABLED=true FLEET_ALLOWED=true npm run dev:backend`.
3. Connect a Claude subscription in Settings → Talyn Fleet.
4. `npm run dev:desktop`. Local mode needs `claude` or `codex` on the login PATH and `node-pty`
   built for Electron (`npm run rebuild` in `apps/desktop/release/app`).
5. To push from a sandbox, the GitHub App needs Contents: Read & write (and Workflows write for
   workflow files).

### Fleet changes this needs

- `tom/workbench-endpoints` (quiet exec, diff, files, pty, ports, idle TTL): merged and deployed
  on 2026-10-14.
- `tom/bare-box-repo` (a top-level `repo` on a bare create, so the proxy scopes the token and
  serves the commit, checks and review-thread endpoints): on a branch, NOT deployed. Talyn sends
  the field already; a fleet without it ignores it.
- Sandbox ids must be 40 characters or fewer. `sandboxIdFor` uses 24 hex digits of the uuid.

### Backend decisions that differ from the plan

- **Tagged exec framing.** The events ring is per sandbox, so two commands that run at the
  same time mix their output. Each exec is wrapped: every line carries a nonce tag, and a
  tagged trailer gives the exit code (`services/workbenches/execFraming.ts`).
- **The router is mounted before `ownerScope`**, like billing. Handlers wait on the fleet,
  and a scoped transaction would hold a pool connection for that time.
- **Seq allocation** is one CTE statement on `workbench_chats.next_seq`. No advisory lock.
- **Archive** saves the work (uncommitted changes and commits that were not pushed) as a git
  bundle in Talyn's storage. It pushes nothing. A failed save keeps the sandbox. See "Saved work"
  below.
- **Terminal**: the fleet `/pty` first; on `409 pty_unsupported`, `ssh2` over `ssh-stream`.

### Saved work: checkpoints, archives and recovery (2026-10-29)

A sandbox can be lost with work in it (in one incident, a guest ran out of memory three times, the
fleet stopped it as wedged, and 30 minutes of uncommitted work went with it). Talyn now keeps each
session's unsaved work in **Talyn storage**, never in a git ref: nothing is pushed to save work.
The only pushes left are the ones a person asks for (Create PR, auto-PR, the agent's own push).
Code: `services/workbenches/workCheckpoint.ts`, `workCheckpointScripts.ts`, `workStorage.ts`.

- **Format.** In the box, the work tree is staged into a temporary copy of the index (`add -A`, so
  untracked files that are not ignored are included), written as a tree, and committed with HEAD
  as its parent. The branch, HEAD, the real index and the work tree are never touched. That commit
  goes into a `git bundle` that excludes `origin/<base>` (a full bundle when the box does not know
  the base), so the bundle also carries every commit that was not pushed. The bundle is staged on
  `/dev/shm`.
- **Transport.** The bundle leaves the box through quiet exec, 2 MiB at a time (the move's
  `moveReadChunkScript`). Each part is uploaded as it arrives, so the backend holds one part, not
  the bundle. A restore reverses this: each part is downloaded and written into the new box
  (`writeSandboxFiles`), then size and SHA-256 are checked before git reads it.
- **Storage.** Supabase Storage, private bucket `workbench-work`, used only from the backend with
  the service-role key. No public or signed URLs. Keys:
  `<workspaceId>/<workbenchId>/<checkpoint|archive>/meta.json` (sha, base, branch, takenAt,
  size, sha256, parts, generation) and `.../<generation>/part-NNNNN`. A save writes a new
  generation, then replaces `meta.json`, then deletes the old generation. A save that fails
  half-way leaves the last whole one in place.
- **Limit.** 96 MiB compressed (`WORK_BUNDLE_MAX_BYTES`), the most a move carries over the same
  exec channel. Parts stay far under Storage's per-object limit. A larger checkpoint is refused,
  with one chat note until a save works again. A larger archive keeps the sandbox and says why.
- **Checkpoint triggers.** After every turn (`afterTurn`), and during a turn at most once a minute
  after the agent used a tool that can change files (anything but read-only and MCP tools).
  When a save takes more than 12 seconds, the next gap is five times its duration, up to five
  minutes. A box whose HEAD and tree match the recorded checkpoint saves nothing. A box with no
  uncommitted work and no unpushed commit deletes the stored checkpoint. Bounded and best effort:
  never fails or delays a turn. The same tool signal refreshes the sidebar's diff stat at most
  every 20 s, and the Changes route stores and broadcasts the stat it reads.
- **Record.** `workbenches.work_checkpoint_sha`, `work_checkpoint_at` and
  `work_checkpoint_bytes` (migration `0094`), written only while the row still names the box the
  checkpoint came from.
- **Restore.** A lost box's replacement (`provisionWorkbench`, and a move whose old box went away
  during the export or the transfer) reads the checkpoint after the clone. An archive restore
  reads the archive, then takes a checkpoint of the restored work. When the branch on GitHub is
  the saved commit's parent or behind it (or does not exist), the branch is moved to the parent,
  which keeps the commits that were not pushed, and the saved tree is written as uncommitted
  changes. When the branch on GitHub moved past it, the work is not applied, because it would undo
  the newer commits; it stays in storage. The chat note says which case happened and the
  checkpoint's time. With no checkpoint, the note says that changes that were not pushed are lost.
- **Cleanup.** An archive deletes the session's checkpoint (the archive supersedes it). Deleting a
  session deletes every stored object of it, before the row.
- **The old box first.** Before replacing a box, `recoverLostSandbox` asks the fleet
  (`getSandbox`). A `suspended` box (also hibernated) is resumed and kept. Only a box that is gone,
  retired, terminal or in another state is replaced.
- **Signed-commit repositories** no longer matter here: nothing is pushed to save work.

### Known gaps

- The boot sweep that stops orphaned turns assumes ONE backend replica. A deploy overlap
  would stop a live replica's turns. Fix this before any production use.
- The preview proxy needs a Bearer token, so an iframe cannot load it directly. The
  desktop forward adds the token; the web app waits for hosted preview URLs.
- `stream_event` deltas are stored without pruning.
- `openSshStream` and `openPty` do not use `FLEET_HTTP_PROXY`.
- Sandbox: pasted images are not sent. Local: archive does not remove the worktree.
- Fix checks for a local workbench sends the plain prompt without the check list. No failing
  log excerpts are included for either runtime.
- `stores/workspace.ts` keeps `setActivePanel` / `openSettings` as adapters over the route store.
- `apps/web` has none of this; it is a separate fork.
- No billing gates. Not verified on a real fleet: Codex in a sandbox, and a saved-work round
  trip through real Supabase Storage.
- The new fleet routes `/pty` and `/ports` need guests booted from a newly baked golden. The
  golden was baked again on 2026-10-14 for Claude Code 2.1.296. This is not checked yet.
- A box keeps the Claude Code version it was created with, and nothing updates it.
- Not run end to end: the local runtime, Codex in a sandbox, a real PR (Create PR, Fix checks,
  Resolve conflicts, Merge), restore of an archived workbench, the port preview, and a packaged
  release build. The UI was checked through the API and screenshots only.
