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

> The legacy stdio package `@talyn/mcp-server` (a local `node` subprocess) is
> **superseded** by this hosted endpoint and is no longer the recommended path.

## Install

1. Open the Talyn desktop app → **Settings → MCP server**.
2. Click **Generate** to mint a personal token (90-day, revocable). Copy the
   token — it's shown once.
3. Copy the prefilled **install command** and run it:

   ```bash
   claude mcp add --transport http talyn \
     https://fastowl-backend-production.up.railway.app/api/v1/mcp \
     --header "Authorization: Bearer <your-token>"
   ```

   (Against a local backend the endpoint is `http://localhost:4747/api/v1/mcp`.)

   **Claude Desktop** — add to `claude_desktop_config.json` instead:

   ```jsonc
   {
     "mcpServers": {
       "talyn": {
         "type": "http",
         "url": "https://fastowl-backend-production.up.railway.app/api/v1/mcp",
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

| Tool | What it does |
| --- | --- |
| `talyn_list_workspaces` | List your workspaces + their repos. |
| `talyn_list_pull_requests` | PRs by bucket: `mine` / `review_requested` / `needs_attention` / `all`. |
| `talyn_get_pull_request` | A PR's status, branches, mergeable/review/checks, flags. |
| `talyn_get_pull_request_diff` | Changed files (+/- stats); patch on request. |
| `talyn_get_pull_request_reviews` | Reviews, inline threads (unresolved by default), comments. |
| `talyn_refresh_pull_request` | Force a fresh fetch from GitHub. |
| `talyn_set_auto_keep_mergeable` | Enable/disable the keep-mergeable watcher. |
| `talyn_set_merge_queue` | Add/remove from the merge queue (+ method). |
| `talyn_merge_pull_request` | Merge now (merge / squash / rebase). |
| `talyn_fix_pull_request` | Run the standard "get this PR mergeable" task — the same action as the app's fix button (standard prompt, workspace provider). Takes only the PR id. |
| `talyn_create_task` | Freeform cloud coding task on a repo. |
| `talyn_list_tasks` / `talyn_get_task` | Inspect cloud tasks. |
| `talyn_stop_task` / `talyn_retry_task` | Cancel / re-queue a task. |

If you have one workspace, the PR/task tools default to it; otherwise pass
`workspace_id` (the list-workspaces tool returns the ids).

## Implementation

Backend, under `packages/backend/src/`:

- `mcp/transport.ts` — Express route mounting the Streamable-HTTP transport
  (stateless), mounted at `/api/v1/mcp` **before** `requireAuth`.
- `mcp/requireMcpToken.ts` — token gate (401 + `WWW-Authenticate` on failure).
- `mcp/server.ts` — the MCP `Server` + tool dispatch (records each call on the
  debug bus).
- `mcp/tools.ts` + `mcp/api.ts` — the tool registry and the loopback API client.
- `services/mcpToken.ts` + `routes/mcpTokens.ts` — token mint/list/revoke
  (`mcp_tokens` table, migration `0025`).

Desktop: `components/panels/SettingsPanel.tsx` → `MCPServerSettings`.
