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

The hosted server has 65 tools. Every tool declares annotations for reads and actions.
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
| `talyn_list_github_repos` | Find accessible GitHub repositories. Use `search` to narrow the first 100 matches. |
| `talyn_add_repository` | Watch a repository. Accept `owner/name` or separate owner and repository fields. |
| `talyn_remove_repository` | Stop watching a repository. |

### Pull requests

| Tool | What it does |
| --- | --- |
| `talyn_list_pull_requests` | List `mine`, `review_requested`, `watching`, `needs_attention`, or `all`. Use `task_only` for linked tasks. |
| `talyn_get_pull_request` | Read status, checks, human gates, and merge queue state. |
| `talyn_get_pull_request_description` | Read the cached description. |
| `talyn_get_pull_request_diff` | List changed files. Include patches on request. |
| `talyn_get_pull_request_reviews` | Read reviews, comments, and review threads. |
| `talyn_refresh_pull_request` | Refresh a PR from GitHub. |
| `talyn_track_pull_request` | Track a PR by URL. Use `add_repository` to also watch its repository. |
| `talyn_untrack_pull_request` | Stop tracking a PR. Keep its queue entry and auto-keep setting. |
| `talyn_set_review_hidden` | Hide or restore a PR in the review list. |
| `talyn_set_auto_keep_mergeable` | Enable or disable automatic cloud fixes. |
| `talyn_merge_pull_request` | Merge a PR or submit it to the external merge queue. |
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
| `talyn_create_loop` | Create recurring work. Derive the repository name from `repository_id` when needed. |
| `talyn_update_loop` | Merge supplied fields over the current definition before saving. |
| `talyn_set_loop_enabled` | Enable or disable a loop while preserving its definition. |
| `talyn_delete_loop` | Delete a loop and its history. |
| `talyn_list_loop_runs` | Read run history with `limit` and `cursor`. |
| `talyn_run_loop_now` | Start a run through the normal task and billing checks. |

### Sessions

Sessions are called workbenches in the code. These tools serve sandbox sessions.
A local session runs in the desktop app. Tools that act on one answer: "This session runs on the user's own machine in the Talyn desktop app; open it there."

| Tool | What it does |
| --- | --- |
| `talyn_list_sessions` | List sessions in a workspace. Use `include_archived` to show archived ones. |
| `talyn_get_session` | Read status, runtime, repository, branch, pull request, and chats with ids. |
| `talyn_create_session` | Start a sandbox session on a new branch, an existing branch, or a pull request. A `prompt` is the first message. |
| `talyn_send_session_message` | Send a message to a chat. With only `session_id`, it uses the first open chat. |
| `talyn_get_session_transcript` | Read a chat as text. Output is capped. Pass the returned `cursor` for the next page. |
| `talyn_cancel_session_turn` | Stop the running turn of a chat. |
| `talyn_get_session_changes` | List changed files with line counts. |
| `talyn_get_session_diff` | Read the unified diff, or one file with `path`. Large diffs are cut. |
| `talyn_open_session_pull_request` | Commit, push, and open a pull request. |
| `talyn_run_session_script` | Start a named script in the sandbox. |
| `talyn_stop_session_script` | Stop a running script. |
| `talyn_archive_session` | Archive a session. |
| `talyn_restore_session` | Restore an archived session, or retry a failed start. |

### MCP connections

| Tool | What it does |
| --- | --- |
| `talyn_list_mcp_servers` | List servers connected to Talyn Fleet runs. |
| `talyn_get_mcp_server` | Read settings and connection state. Never return credentials. |
| `talyn_create_mcp_server` | Create an OAuth or unauthenticated connection. Enter API keys only in the Talyn app. |
| `talyn_connect_mcp_server` | Start OAuth. A person must open the returned URL in a browser. |
| `talyn_test_mcp_server` | Contact the server and save its test result. |
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
These defaults include PostHog Code, its default model, daily runs at 09:00, and concurrency `skip`.
Internet access defaults to off. `mcpServerIds: null` uses the workspace's connected servers.
Pass loop fields directly or in a `loop` object. Set the model when you change the provider.

For MCP connections, `authKind` accepts `oauth` or `none`.
The tool maps `oauth` to the API's `bearer` value. Then use `talyn_connect_mcp_server` to start sign-in.
API-key servers must be added in the Talyn app, so the key never passes through an AI transcript.

### Feature-gated tools

Tool listing checks `/features` once per request.
The flags `workflows`, `loops`, `mcpServers`, and `workbenches` control their tool groups. The code review tools are always listed.
A false flag hides the group. If the feature request fails, all tools remain listed.
Each REST route checks access independently. Tool calls use the route's error message and code.
HTTP 402 errors also explain the free-plan limit and point to Settings → Billing.

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
are refused: MCP server tools, account tools, repository add and remove, and
every skill, workflow and loop change. Their reads are allowed. Sessions, the
merge queue, pull requests, code review and tasks are allowed. A new tool is
refused until somebody adds it.

**Calls on its own session.**

- `talyn_archive_session` on itself is done after the current reply ends.
  Archiving at once would cancel the turn that asked. No new turn starts while
  the request waits (`settings.archiveAfterTurn`).
- `talyn_cancel_session_turn`, `talyn_send_session_message` and
  `talyn_restore_session` on itself are refused.
- Calls on other sessions work as they do for a personal token.

**Sessions that start sessions.** A session started through a session token
records its parent and its depth. A session at depth 2 cannot start another.
One session token can start 3 sessions an hour, so one root session causes at
most 3 + 9 = 12 sandboxes an hour. Personal tokens have neither limit.

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
