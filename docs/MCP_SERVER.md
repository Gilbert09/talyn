# Talyn MCP server

Drive Talyn from a Claude client (Claude Code or Claude Desktop): list the
PRs you have open or are asked to review, pull the context an agent needs
(diff, reviews, unresolved threads, checks), and act — start a cloud fix /
respond / review task, toggle the merge queue, toggle "auto keep mergeable",
or merge.

This is a **hosted** MCP server: it runs as an HTTP endpoint on the Talyn
backend (`/api/v1/mcp`, Streamable-HTTP transport), so there's nothing to
install or run locally. You connect a Claude client straight to the URL with a
personal token.

## Install

1. Open the Talyn desktop app → **Settings → MCP server**.
2. Click **Generate** to mint a personal token (90-day, revocable). Copy the
   token — it's shown once.
3. Copy the prefilled **install command** and run it:

   ```bash
   claude mcp add --transport http talyn \
     https://prod.talyn.dev/api/v1/mcp \
     --header "Authorization: Bearer <your-token>"
   ```

   (Against a local backend the endpoint is `http://localhost:4747/api/v1/mcp`.)

   **Claude Desktop** — add to `claude_desktop_config.json` instead:

   ```jsonc
   {
     "mcpServers": {
       "talyn": {
         "type": "http",
         "url": "https://prod.talyn.dev/api/v1/mcp",
         "headers": { "Authorization": "Bearer <your-token>" }
       }
     }
   }
   ```

## Auth

The endpoint authenticates with the **personal MCP token** minted in the
settings page — not a Supabase JWT. Tokens:

- are stored **hashed** (SHA-256); the plaintext is shown exactly once;
- are owner-scoped — a token only ever sees its minter's data;
- default to a **90-day** expiry and are **revocable** from the same settings
  page (revoke takes effect immediately — the next call gets a 401).

Under the hood the tool handlers call Talyn's own REST API over loopback with
internal-proxy headers, so every tool runs through the same validation and
owner-scoped RLS as the desktop app — no separate permission surface.

## Tools

The hosted server has 102 tools. Account feature flags control 52 of them (see
[Feature-gated tools](#feature-gated-tools)). A session token sees fewer tools (see
[Inside a session sandbox](#inside-a-session-sandbox)).
Every tool declares annotations for reads and actions.
Tools return text. Only workflow and loop definitions return JSON.

If you have one workspace, tools use it by default. Otherwise, pass `workspace_id`.
Use `talyn_list_workspaces` to find workspace ids.

### Workspaces

| Tool | What it does |
| --- | --- |
| `talyn_list_workspaces` | List workspaces and their repositories. |
| `talyn_get_workspace` | Read repositories, integrations, and key settings. Use `include_prompts` for prompt text. |

### Repositories

| Tool | What it does |
| --- | --- |
| `talyn_list_repositories` | List watched repositories and their ids. |
| `talyn_list_github_repos` | Find accessible GitHub repositories to add. The list shows 100 repositories at most. Use `search` to narrow it. |
| `talyn_add_repository` | Watch a repository. Accept `owner/name` or separate owner and repository fields. |
| `talyn_remove_repository` | Stop watching a repository. |
| `talyn_list_setup_steps` | List the Setup list of a repository, in order. Each step shows its id, its status (`active`, `suggested`, `dismissed` or `disabled`), where it runs (`image`, `box` or `both`), who added it (`user`, `learned` or `agent`), its name, its command, and why it has its status. Under each step: its command, how long it took, and why it has its status. The first lines show if learning is on, the repository's own setup command and how long the last setup took. Allowed for session tokens. |
| `talyn_revert_setup_step` | Dismiss one learned setup step. It stops running on new boxes, leaves the image and stays in the list as dismissed, so Talyn does not suggest it again. Talyn refuses to dismiss a person's own step. Not allowed for session tokens. |

### Pull requests

| Tool | What it does |
| --- | --- |
| `talyn_list_pull_requests` | List `mine`, `review_requested`, `watching`, `needs_attention`, or `all`. Use `task_only` for linked tasks. |
| `talyn_get_pull_request` | Read status, checks, human gates, and merge queue state. |
| `talyn_get_pull_request_description` | Read the cached description. |
| `talyn_get_pull_request_diff` | List changed files. Include patches on request. |
| `talyn_get_pull_request_reviews` | Read reviews, comments, and review threads. |
| `talyn_refresh_pull_request` | Refresh a PR from GitHub. |
| `talyn_track_pull_request` | Track a PR by URL, so it shows in the `watching` bucket. Use `add_repository` to also watch its repository. From a session token, Talyn uses the session's workspace and refuses `add_repository`. |
| `talyn_untrack_pull_request` | Stop tracking a PR. Keep its queue entry and auto-keep setting. Not allowed for session tokens. |
| `talyn_set_review_hidden` | Hide or restore a PR in the review list. |
| `talyn_set_auto_keep_mergeable` | Enable or disable automatic cloud fixes. |
| `talyn_merge_pull_request` | Merge a PR now with `merge`, `squash` or `rebase`. When the repository uses a GitHub merge queue, Talyn submits the PR to that queue. |
| `talyn_close_pull_request` | Close a PR as you, with an optional comment first. Pass `pull_request_id`, or `repository` and `number`. Talyn closes only your own PRs (the GitHub author is the connected user) or PRs a Talyn session opened. A merged PR is refused. An already closed PR is a no-op, and Talyn does not post the comment. Talyn posts the comment only when the close is allowed. If the close then fails, the error says that the comment is on the PR. From a session token, the PR must be in the session's repository, and the session's own PR is refused. |
| `talyn_fix_pull_request` | Start the standard cloud task to make a PR ready to merge. |

### Merge queue

| Tool | What it does |
| --- | --- |
| `talyn_set_merge_queue` | Add or remove one PR. Set the merge method if needed. |
| `talyn_set_merge_queue_stack` | Add or remove a stack. Optionally include descendants. |
| `talyn_get_merge_queue_timeline` | Read queue events and their reasons. |

### Code review

| Tool | What it does |
| --- | --- |
| `talyn_list_code_reviews` | List recent reviews in a workspace. |
| `talyn_get_code_review` | Read review status and findings. The default finding status is `open`. |
| `talyn_start_code_review` | Start a `quick`, `standard`, or `deep` review. Optionally reset the prior cycle. |
| `talyn_cancel_code_review` | Cancel a running review. |
| `talyn_get_code_review_finding` | Read the full body, suggestion, anchor, and verdict reason. |
| `talyn_fix_code_review_findings` | Start a cloud task for selected finding ids. |
| `talyn_dismiss_code_review_finding` | Dismiss a finding with a fixed reason. Use `undo` to restore it. |

### Tasks

| Tool | What it does |
| --- | --- |
| `talyn_create_task` | Create cloud work. Optionally link a PR and supply a structured `skill` reference. |
| `talyn_list_tasks` | List tasks with comma-separated statuses. Use `limit` and the returned `before` cursor. |
| `talyn_get_task` | Read results, human requests, quota failover, and an optional transcript. |
| `talyn_stop_task` | Cancel a running task. |
| `talyn_retry_task` | Queue a failed or cancelled task again. |
| `talyn_delete_task` | Delete saved task history. This does not cancel the remote agent. |

### Skills

| Tool | What it does |
| --- | --- |
| `talyn_list_skills` | List platform skills and optional repository skills. |
| `talyn_get_skill` | Read a platform skill by id, or a repository skill by repository and name. |
| `talyn_create_skill` | Create a platform skill. |
| `talyn_update_skill` | Update the supplied platform skill fields. |
| `talyn_delete_skill` | Delete a platform skill. |

### Workflows

| Tool | What it does |
| --- | --- |
| `talyn_list_workflows` | List definitions and run statistics. |
| `talyn_get_workflow` | Read the editable definition as JSON. |
| `talyn_get_workflow_vocabulary` | Read allowed events, conditions, and action fields. Get label, user, and branch suggestions. |
| `talyn_create_workflow` | Create a definition from the `workflow` object. |
| `talyn_update_workflow` | Merge supplied fields over the current definition before saving. |
| `talyn_set_workflow_enabled` | Enable or disable a workflow while preserving its definition. |
| `talyn_delete_workflow` | Delete a workflow and its history. |
| `talyn_list_workflow_runs` | Read run history with `limit` and `cursor`. |

### Loops

| Tool | What it does |
| --- | --- |
| `talyn_list_loops` | List recurring work and next run times. |
| `talyn_get_loop` | Read the editable definition and next run time as JSON. |
| `talyn_create_loop` | Create recurring work. Set `target` to `session` for a sandbox session, or `task` for a cloud task. Talyn gets the repository name from `repository_id`. |
| `talyn_update_loop` | Merge supplied fields over the current definition before saving. |
| `talyn_set_loop_enabled` | Enable or disable a loop while preserving its definition. |
| `talyn_delete_loop` | Delete a loop and its history. |
| `talyn_list_loop_runs` | Read run history with `limit` and `cursor`. |
| `talyn_run_loop_now` | Start a run now, through the normal session or task checks. |

### Sessions

Sessions are called workbenches in the code. These tools serve sandbox sessions.
A local session runs in the desktop app. Tools that act on one answer: "This session runs on the user's own machine in the Talyn desktop app; open it there."

| Tool | What it does |
| --- | --- |
| `talyn_list_sessions` | List sessions in a workspace. Use `include_archived` to show archived ones. |
| `talyn_get_session` | Read status, runtime, repository, branch, pull request, and chats with ids. |
| `talyn_session_sandbox_status` | Read the state of a session's sandbox in plain words: starting, running, idle (with the time it goes to sleep), asleep, asleep in storage, waking, moving, lost or failed. It also shows the fleet host and size, what runs now, when the work was last saved, what is not pushed, failed saves and the last problem. Read-only. The fleet's record is cached for 10 seconds; when the fleet does not answer, that part is unknown. From a session token: the session itself, or a session in its thread. |
| `talyn_run_background` | Start a shell command in the session's sandbox that outlives the turn. Talyn starts a new turn in the chat when it exits (`notify_on_exit`, default on). `keep_awake_seconds` (default 3600, at most a day) keeps the box awake while it runs, as billed box time. From a session token: the session itself only. |
| `talyn_list_background` | List the session's background jobs: running ones, then recent ended ones. Read-only. |
| `talyn_background_logs` | Read the last lines of a job's output (default 200, at most 2000). Records the exit if the job has exited. |
| `talyn_stop_background` | Stop a job: INT, TERM, then KILL to its process group. |
| `talyn_schedule_wakeup` | Ask Talyn to start a new turn in the chat later (`delay_seconds` or `at`, in the future, no upper bound). |
| `talyn_list_wakeups` | List the session's wake-ups: scheduled, then recent fired, cancelled or failed ones. Read-only. |
| `talyn_cancel_wakeup` | Cancel a scheduled wake-up. |
| `talyn_record_setup_step` | Add a setup step to the repository of the session. Record only a step that every session on the repository needs. Talyn refuses a step that holds a secret, pipes a downloaded script into a shell, sends data out or pushes code. The new step is `suggested`: it runs on new boxes only when a person accepts it or when enough recent sessions need it. From a session token: the session itself, or a session in its thread. |
| `talyn_create_session` | Start a sandbox session on a new branch, an existing branch, or a pull request. A `prompt` is the first message. With `space_id`, the session starts in a team space, and Talyn refuses `pull_request_id` and `auto_create_pr`. Spaces are not yet available to all accounts. |
| `talyn_list_thread_sessions` | List the sessions of a thread, newest first: status, repository, branch, chat status and pull request. From a thread, `thread_id` is the thread itself by default. Read-only. |
| `talyn_send_session_message` | Send a message to a chat. With only `session_id`, it uses the first open chat. If a turn runs, the message waits in the queue. |
| `talyn_list_accounts` | List the workspace's Claude and Codex subscriptions, in the order Talyn tries them: label, usage, and if the account is usable now. It also shows the account of a session, or of each session in a thread. It never shows secrets. Read-only. |
| `talyn_set_session_account` | Choose the Claude or Codex account that a session uses from its next turn. Use an account id from `talyn_list_accounts`, for the session's agent. A running turn does not stop. When the chosen account is rate limited at turn start, Talyn still moves to another account. From a session token: the session itself, or a session in its thread. |
| `talyn_get_session_transcript` | Read a chat as text. Output is capped. Pass the returned `cursor` for the next page. |
| `talyn_cancel_session_turn` | Stop the running turn of a chat. |
| `talyn_resize_session` | Move a session to a sandbox of another `size` after its running turn. `continue_with` sends a message that starts the next turn on the new sandbox. `remember_for_repository` also sets the repository's size. From a session token: the session itself, or a session in its thread. |
| `talyn_session_timing` | Show where a session's turns spent their time: tests, installs, builds, Docker and services, waits, git, file reads, other tool calls and model time. It also lists the slowest calls. Read-only. From a session token: the session itself, or a session in its thread. |
| `talyn_get_session_changes` | List changed files with line counts. |
| `talyn_get_session_diff` | Read the unified diff, or one file with `path`. Large diffs are cut. A sleeping sandbox answers from the copy that Talyn stored, or from GitHub when all the work is pushed. Pass `live` to wake the sandbox and read it now. |
| `talyn_open_session_pull_request` | Commit, push, and open a pull request. If the branch already has a pull request, Talyn links it. |
| `talyn_run_session_script` | Start a named script in the sandbox. |
| `talyn_stop_session_script` | Stop a running script. |
| `talyn_archive_session` | Archive a session. |
| `talyn_restore_session` | Restore an archived session. |
| `talyn_retry_session` | Restart a session that failed, or one that is stuck while it starts, on a new sandbox. The old sandbox is deleted. A ready or archived session is refused. |

### Workspace memory

Short notes that sessions and people save for later sessions (`workspace_memories`, migration `0096`).
An entry applies to the workspace, one repository, or one thread. Writing the same name again in the same scope updates the entry.
From a session, an entry applies to the session's repository unless `scope` is `workspace`.
From a thread, an entry applies to the thread unless `scope` is `workspace`.
A session sees workspace entries, its repository's entries and its thread's entries.
A write or forget from a session adds a `talyn_memory` card to its transcript.
When `settings.sessionMemory` is `false`, every memory tool refuses.

A memory review thread (source `memory_review`) sees every entry of its workspace.
It writes a repository entry with `repository_id` and a thread entry with `thread_id`.
Talyn starts this thread on the cadence in `settings.memoryReview` (`daily`, `weekly` or `monthly`), or when a person clicks "Review now".
The thread merges entries that overlap and settles entries that disagree.
The `memory-review` flag gates the feature. The sweep skips a period when fewer than two entries are live or no entry changed since the last review.
The table `memory_review_runs` (migration `0120`) keeps one row for each review.

| Tool | What it does |
| --- | --- |
| `talyn_memory_write` | Create an entry, or update the entry with the same name in the same scope. Name 64 characters, description 200, body 8 KB. |
| `talyn_memory_search` | Find entries by text in the name, description or body. No bodies. |
| `talyn_memory_read` | Read one entry with its body. |
| `talyn_memory_forget` | Forget an entry. A person can restore it in the app. |
| `talyn_memory_list` | List the entries the caller can see. No bodies. |

### MCP connections

| Tool | What it does |
| --- | --- |
| `talyn_list_mcp_servers` | List servers connected to Talyn Fleet runs. |
| `talyn_get_mcp_server` | Read settings and connection state. Never return credentials. |
| `talyn_create_mcp_server` | Create an OAuth or unauthenticated connection. Enter API keys only in the Talyn app. |
| `talyn_connect_mcp_server` | Start OAuth. A person must open the returned URL in a browser. |
| `talyn_test_mcp_server` | Contact the server, list its tools, and save the test result. |
| `talyn_set_mcp_server_enabled` | Enable or disable a connection while preserving its settings and stored credential. |
| `talyn_delete_mcp_server` | Delete the connection and its stored credential. |

### Account

| Tool | What it does |
| --- | --- |
| `talyn_get_billing_status` | Read the plan and usage against task, queue, workflow, and loop limits. |
| `talyn_list_cloud_providers` | Read connected providers, connected agents, required sign-ins, and the default provider. |
| `talyn_whats_new` | Read the latest release. Pass a version in `since` to read newer releases. |

A task's `skill` reference contains `key`, `name`, and `source`.
It can also contain `repositoryId` or `platformSkillId`.
Include the skill instructions in `prompt`; the reference records which skill the task uses.

Loop creation uses the desktop defaults, except that the timezone defaults to `UTC`.
These defaults include target `task`, PostHog Code, its default model, daily runs at 09:00, and concurrency `skip`.
With target `session` and no provider, the provider is Talyn Fleet (`selfhosted`) with its default model.
Internet access defaults to off. `mcpServerIds: null` uses the workspace's connected servers.
Pass loop fields directly or in a `loop` object. Set the model when you change the provider.

For MCP connections, `authKind` accepts `oauth` or `none`.
The tool maps `oauth` to the API's `bearer` value. Then use `talyn_connect_mcp_server` to start sign-in.
API-key servers must be added in the Talyn app, so the key never passes through an AI transcript.

### Feature-gated tools

Tool listing checks `/features` once per request.
The flags `workflows`, `loops`, `mcpServers`, `workbenches`, and `spaces` control their tool groups.
The `workbenches` flag controls the session, workspace memory and Setup list tools.
The background job and wake-up tools have no flag. The code review tools are always listed.
A false flag hides the group. If the feature request fails, all tools remain listed.
Each REST route checks access independently. Tool calls use the route's error message and code.
HTTP 402 errors also explain the free-plan limit and point to Settings → Billing.

The `spaces` flag controls one tool. Spaces are not yet available to all accounts.

| Tool | What it does |
| --- | --- |
| `talyn_list_spaces` | List your teams, with your role in each, and their live spaces. Read-only. Not allowed for session tokens. |

## Inside a session sandbox

Every cloud session's sandbox gets this server as the MCP server named
`talyn`, authenticated as the session's owner. A session agent can archive its
own session, start another session, add a pull request to the merge queue, and
so on. Cloud tasks do not get it.

**The credential.** Each session has one `talyn_mcs_` token in
`session_mcp_tokens` (migration `0093`, backend-pool only). The hash is what
`requireMcpToken` looks up. The plaintext is also stored, encrypted with the
integration-token key, because the fleet keeps an inline MCP secret nowhere and
a restarted fleetd asks Talyn for it again. The token is minted when a box is
created, and it reaches the fleet on the same three paths as a workspace's MCP
servers: the create body, the per-turn credential push, and the run-credentials
pull (`services/workbenches/talynMcp.ts`). The guest gets a plain proxy URL;
the host's proxy attaches the token. The token is refused while its session is
archived, and it is deleted with its session.

**The URL.** `TALYN_PUBLIC_API_URL` (the backend's public origin), else the
origin of `POSTHOG_OAUTH_REDIRECT_URI` or `SLACK_OAUTH_REDIRECT_URI`. It must be
https on a public host. Without one (local development), sessions have no
`talyn` server and their prompt does not mention it.

**What it may call.** An allowlist in `mcp/sessionScope.ts`, checked by the
server on every list and every call. The agent reads untrusted text, so these
are refused: MCP server tools, account tools, repository add and remove,
`talyn_revert_setup_step`, `talyn_list_spaces`, and every skill, workflow and
loop change. Their reads are allowed. Sessions, background jobs and wake-ups,
the merge queue, pull requests, code review, tasks and workspace memory are
allowed. `talyn_record_setup_step` and `talyn_list_setup_steps` are allowed. A new tool is
refused until somebody adds it. `talyn_track_pull_request` is allowed, but it
refuses `add_repository` and another workspace. `talyn_untrack_pull_request`
is refused, because it undoes what a person chose to watch.

**Calls on its own session.**

- `talyn_archive_session` on itself is done after the current reply ends.
  Archiving at once would cancel the turn that asked. No new turn starts while
  the request waits (`settings.archiveAfterTurn`).
- `talyn_cancel_session_turn`, `talyn_send_session_message`,
  `talyn_restore_session` and `talyn_retry_session` on itself are refused.
- `talyn_set_session_account`, `talyn_resize_session`, `talyn_session_timing`
  and `talyn_session_sandbox_status` work on the session itself, or on a session
  in its thread.
- The background job and wake-up tools work on the session itself only.
- `talyn_close_pull_request` refuses the session's own pull request, and any
  pull request outside the session's repository. A thread has no repository,
  so it cannot close pull requests.
- Calls on other sessions work as they do for a personal token.

**Sessions that start sessions.** A session started through a session token
records its parent and its depth. A session at depth 2 cannot start another.
There is no hourly create limit. Personal tokens have no depth limit.

## Deliberately not exposed

- Account wipe and workspace creation or deletion stay in the app. Account deletion is irreversible.
- MCP token creation or revocation stays in the app. Secrets must not pass through a transcript.
- Cloud credentials, Claude sign-in, and GitHub connection or disconnection stay in the app for the same reason.
- `admin/*`, `debug/*`, and `fleet/*` serve operators only.
- `teams/*` and billing checkout or portal actions stay in the app.
- Review-ranking telemetry and poll, view, or focus hints are UI signals. Agents must not generate them.
- Session terminals, port previews, checkpoint restore, and instruction files stay in the app. Local sessions are refused because their turns run in the desktop app.

## Implementation

Backend, under `packages/backend/src/`:

- `mcp/transport.ts` — Express route mounting the Streamable-HTTP transport
  (stateless), mounted at `/api/v1/mcp` **before** `requireAuth`.
- `mcp/requireMcpToken.ts` — token gate (401 + `WWW-Authenticate` on failure).
- `mcp/server.ts` — the MCP `Server` + tool dispatch (records each call on the
  debug bus).
- `mcp/tools/index.ts` + area modules + `mcp/api.ts` — the tool registry and the loopback API client.
- `services/mcpToken.ts` + `routes/mcpTokens.ts` — token mint/list/revoke
  (`mcp_tokens` table, migration `0025`).
- `services/sessionMcpToken.ts`, `services/workbenches/talynMcp.ts` and
  `mcp/sessionScope.ts` — the session sandbox's own token, how it reaches the
  box, and its tool allowlist.

Desktop: `components/panels/SettingsPanel.tsx` → `MCPServerSettings`.
