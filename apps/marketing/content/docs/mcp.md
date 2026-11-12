---
title: Talyn MCP server
navLabel: MCP server
description: Connect Claude Code, Codex, Claude Desktop, Cursor or another MCP client to your Talyn account, and manage pull requests, sessions and reviews from your editor.
---

Talyn runs a hosted MCP server. Connect an MCP client to it and your agent can list your pull requests, start a fix or a code review, queue a merge, or start a session, without you opening Talyn.

This page is about using Talyn from your own MCP client. To give Talyn's agents tools from Linear, Sentry and others, see [MCP servers](/docs/mcp-servers).

| Setting | Value |
| --- | --- |
| URL | `https://prod.talyn.dev/api/v1/mcp` |
| Transport | Streamable HTTP |
| Auth | `Authorization: Bearer talyn_mcp_...` |

## Connect Claude Code and Codex in one click

The Talyn desktop app can connect Claude Code and Codex on your computer for you.

1. In the desktop app, open **Settings**.
2. Select **Talyn MCP server**.
3. Under **Connect this computer**, select **Connect Claude Code and Codex**.
4. Restart open Claude Code and Codex sessions.

Talyn creates a token and adds the `talyn` server to `~/.claude.json` and `~/.codex/config.toml`. It keeps all other settings in those files. It also adds these skills to `~/.claude/skills` and `~/.codex/skills`:

| Skill | What it does |
| --- | --- |
| `talyn-remote-session` | Hands work to a Talyn cloud session with a complete brief. |
| `talyn-follow-sessions` | Reads the status, transcript and diff of a session, and sends follow-up messages. |
| `talyn-pull-session` | Brings the branch of a session to your computer, so you can run and test it. |
| `talyn-pull-requests` | Shows what blocks your pull requests, starts cloud fixes and reviews, and uses the merge queue. |

Talyn does not replace a skill of your own with the same name. When the desktop app updates, it updates the skills it installed.

**Reconnect** creates a new token and revokes the token that it replaces. Do this when the token expires. **Disconnect** removes the server and the skills, and revokes the token.

The web app cannot write files on your computer. Use the steps below to connect from there.

## Create a token

The MCP server takes its own token. An [API token](/docs/api) does not work here, and an MCP token does not work on the API.

1. In Talyn, open **Settings**.
2. Select **Talyn MCP server**.
3. Optionally, type a label, for example "Laptop".
4. Select **Generate**.
5. Select **Copy token**, or **Copy command** to copy the whole Claude Code command with the token in it.

Talyn shows the token one time only. A token is valid for 90 days and acts as your account. You can revoke it at any time from the same page.

## Claude Code

Run this command, with your token in place of `<token>`:

```bash
claude mcp add --transport http talyn https://prod.talyn.dev/api/v1/mcp --header "Authorization: Bearer <token>"
```

Then ask Claude Code something like "which of my pull requests need attention?".

## Codex

Add the server to `~/.codex/config.toml`, with your token in place of `<token>`:

```toml
[mcp_servers.talyn]
url = "https://prod.talyn.dev/api/v1/mcp"
http_headers = { Authorization = "Bearer <token>" }
```

## Cursor

Add the server to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "talyn": {
      "url": "https://prod.talyn.dev/api/v1/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

## Claude Desktop

Claude Desktop starts local MCP servers from its config file. Use the `mcp-remote` package to connect it to a remote server with a header. Open **Settings > Developer > Edit Config** in Claude Desktop and add:

```json
{
  "mcpServers": {
    "talyn": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://prod.talyn.dev/api/v1/mcp",
        "--header",
        "Authorization:${TALYN_AUTH}"
      ],
      "env": {
        "TALYN_AUTH": "Bearer <token>"
      }
    }
  }
}
```

Restart Claude Desktop after you save the file. This needs Node.js on your computer.

## Other clients

Any MCP client that can connect to a remote Streamable HTTP server and send an `Authorization` header can use the Talyn MCP server. Set the URL and header from the table at the top of this page.

## What the tools can do

Every tool name starts with `talyn_`. Most tools take a `workspace_id`. If you have one workspace, they use it by default.

| Area | Examples |
| --- | --- |
| Pull requests | List your pull requests or the ones that need attention, read a diff or reviews, fix a pull request with an agent, turn on keep mergeable, merge, track or close a pull request |
| Merge queue | Add or remove a pull request, queue a stack, read the queue history |
| Code review | Start a review at a depth, read findings, fix or dismiss findings |
| Tasks | Start a cloud task, read its result, stop it, retry it or delete it |
| Sessions | Start a session, send a message, read the transcript, read the diff, open the pull request, archive, list the sessions of a thread |
| Session accounts and sandboxes | List your Claude and Codex accounts, choose the account for a session, move a session to a sandbox of another size, restart a session on a fresh sandbox, read the sandbox status, see where a session spent its time |
| Background jobs and wake-ups | Run a long command in a session's sandbox after the turn ends, read its output, stop it, schedule a new turn for later |
| Memory | Save, search, read, list and forget short notes that later sessions can read |
| Repositories | List, add and remove repositories, read setup steps, record or dismiss a setup step |
| Skills | List, read, create and change skills |
| GitHub, Slack, webhook, Linear and GitHub Issues automations | List, create, change, turn on or off, and read runs |
| Schedule | List, create, change, turn on or off, run a scheduled automation now, and read runs |
| MCP servers | List the servers your workspace connects, and connect one that uses OAuth or no auth |
| Spaces | List your teams and their spaces, start a session in a space. Spaces are not yet available to all accounts. |
| Account | Your plan and usage, your connected agents, and what is new |

Your client lists every tool with its description and parameters when it connects.

The `talyn_list_workflows`, `talyn_create_workflow`, and `talyn_update_workflow` tools use `integration`.
Set it to `github`, `slack`, `webhook`, `linear` or `github_issues` in an automation definition. Listed and saved automations include the integration.
Creating a webhook automation answers with its URL and signing secret once. Talyn cannot show them again. A webhook automation can use the `start_task` action.
A Linear rule needs `conditions.connectionId`. Issue automations (`linear` and `github_issues`) need the `issue-rules` feature.
Use `talyn_get_workflow_vocabulary` with optional `integration` to read its fields. It defaults to `github`.
Use `talyn_list_slack_channels` with `{teamId}` to list channels the bot joined.
The `talyn_*loop*` tools manage scheduled automations. Their tool names stay the same.

## What it cannot do

Some actions stay in the app on purpose:

- Delete your account, or create or delete a workspace.
- Create or revoke MCP tokens.
- Connect or disconnect GitHub, or sign in to Claude or ChatGPT.
- Change your plan or billing.
- Add an MCP server that needs an API key. Add those in the app, so that the key never passes through an agent's transcript.
- Open a session's terminal or restore a checkpoint.

## Limits

The server allows 300 requests a minute from one IP address.
