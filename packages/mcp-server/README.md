# @talyn/mcp-server

> **Superseded.** Talyn now ships a **hosted** MCP server as an HTTP endpoint
> on the backend (`/api/v1/mcp`) — nothing to install locally, connect a Claude
> client straight to the URL with a personal token from the desktop app's
> **Settings → MCP server** page. See [`docs/MCP_SERVER.md`](../../docs/MCP_SERVER.md).
>
> This local **stdio** package remains only for the legacy child-Claude spawn
> path and is a candidate for removal. The notes below are out of date (they
> reference backlog / `awaiting_review`, both removed in the cloud-only refactor).

MCP (Model Context Protocol) server exposing Talyn task + backlog
operations as first-class tools to Claude. Think of it as the typed,
documented-schema version of `@talyn/cli` — Claude sees it as tools
rather than a shell binary to invoke.

## Tools exposed

- `talyn_create_task` — spawn a new task in the current workspace
- `talyn_list_tasks` — list tasks filtered by status/type
- `talyn_mark_ready_for_review` — stop current task and move it to
  `awaiting_review`
- `talyn_list_backlog_items` — show backlog items and their state
- `talyn_list_backlog_sources` — show configured backlog sources
- `talyn_sync_backlog_source` — re-read a source file to pick up edits
- `talyn_schedule` — kick the Continuous Build scheduler

Tool inputs default to `$TALYN_WORKSPACE_ID` / `$TALYN_TASK_ID` from
the MCP server's process environment, so most commands work argument-free
when Talyn spawned the Claude session.

## Install

From the monorepo:

```bash
npm run build -w @talyn/mcp-server
```

The binary lands at `packages/mcp-server/dist/index.js`. Register it in
Claude's MCP config (macOS path shown; see Anthropic docs for other OSes):

```jsonc
// ~/.claude/mcp_servers.json
{
  "mcpServers": {
    "fastowl": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-server/dist/index.js"],
      "env": {
        "TALYN_API_URL": "http://localhost:4747"
      }
    }
  }
}
```

For agents Talyn spawns, the parent backend injects
`TALYN_API_URL`, `TALYN_WORKSPACE_ID`, and `TALYN_TASK_ID` as inline
env vars on the command, so the MCP tools pick them up automatically —
Claude can just call `talyn_create_task({ prompt: "..." })` with no
workspace id.

## Analytics

The server is instrumented with the official [`@posthog/mcp`](https://posthog.com/docs/mcp-analytics)
SDK: `instrument(server, posthog)` auto-captures the standardized `$mcp_*`
events (tool calls, tool listings, initialize handshakes, exceptions) that
PostHog's MCP-analytics product reads. Events go to the Talyn (FastOwl)
PostHog project by default.

Overrides / opt-out:

| Var | Purpose | Default |
| --- | --- | --- |
| `TALYN_ANALYTICS_DISABLED` | Set `1`/`true` to turn analytics off | — (on) |
| `TALYN_POSTHOG_KEY` | Different project write key (falls back to `POSTHOG_API_KEY`) | Talyn project |
| `TALYN_POSTHOG_HOST` | Different ingest host (falls back to `POSTHOG_HOST`) | `https://us.i.posthog.com` |

Events are attributed to `TALYN_TASK_ID`, else `TALYN_WORKSPACE_ID`, else
`mcp-anonymous`, with both ids set as person properties.

## Dev

```bash
npm run dev -w @talyn/mcp-server     # tsx watch via stdio
npm test -w @talyn/mcp-server        # vitest
```
