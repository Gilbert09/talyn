---
title: Talyn MCP server
navLabel: MCP server
description: Connect Claude Code, Claude Desktop, Cursor or another MCP client to your Talyn account, and manage pull requests, sessions and reviews from your editor.
---

Talyn runs a hosted MCP server. Connect an MCP client to it and your agent can list your pull requests, start a fix or a code review, queue a merge, or start a session, without you opening Talyn.

This page is about using Talyn from your own MCP client. To give Talyn's agents tools from Linear, Sentry and others, see [MCP servers](/docs/mcp-servers).

| Setting | Value |
| --- | --- |
| URL | `https://prod.talyn.dev/api/v1/mcp` |
| Transport | Streamable HTTP |
| Auth | `Authorization: Bearer talyn_mcp_...` |

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
| Pull requests | List your pull requests or the ones that need attention, read a diff or reviews, fix a pull request with an agent, turn on keep mergeable, merge |
| Merge queue | Add or remove a pull request, queue a stack, read the queue history |
| Code review | Start a review at a depth, read findings, fix or dismiss findings |
| Sessions | Start a session, send a message, read the transcript, read the diff, open the pull request, archive |
| Repositories | List and add repositories, read setup steps |
| Skills | List, read, create and change skills |
| Workflows and loops | List, create, change, turn on or off, and read the runs |
| MCP servers | List the servers your workspace connects, and connect one that uses OAuth or no auth |
| Account | Your plan and usage, your connected agents, and what is new |

Your client lists every tool with its description and parameters when it connects.

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
