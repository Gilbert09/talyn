---
title: MCP servers
description: Connect Linear, Sentry, Stripe or your own MCP server, and every agent run gets its tools. The keys stay with Talyn and never enter the sandbox.
---

Connect an MCP server, and the agents in your sessions, fix runs, reviews and loops get its tools. For example, connect Linear and the agent can read the issue it is working on. Connect Sentry and it can read the stack trace.

This page is about giving Talyn's agents more tools. To use Talyn itself from Claude Code or Cursor, see [Talyn MCP server](/docs/mcp).

## Connect a server

1. Open **Settings > MCP servers** in the desktop app. In the web app, go to [app.talyn.dev/mcp-servers](https://app.talyn.dev/mcp-servers), or search for "MCP servers" in the command palette.
2. Select **Add a server**.
3. Pick a server from the catalog, or paste the address of any other server.
4. Sign in or paste a key. See below.
5. Select **Connect**.
6. Choose the tools your agents can use.
7. Select **Save**.

The catalog includes Linear, Sentry, Notion, Jira and Confluence, Asana, Stripe, Supabase, Neon, PostHog, Vercel, Netlify, Cloudflare, Figma, Slack, Context7, Hugging Face and more. For a server that is not in the catalog, paste its address. Talyn checks the address and finds how it signs in.

Talyn supports remote MCP servers over HTTP. The server must be on the public internet: a sandbox cannot reach your computer or a private network. The address cannot hold a username, a password, a query string or a `#fragment`.

## Sign in or paste a key

Each server uses one of these:

- **Sign in with OAuth**: select **Connect account** and sign in in your browser.
- **No key needed**.
- **API key (Bearer)**, **API key in a header**, or **API key in the URL**: paste the key.
- A username and password.

Talyn stores keys encrypted. The sandbox never receives them: the agent calls the server through Talyn, and Talyn adds the key to each request on the way. An agent that reads a hostile file and tries to leak your key has no key to find.

For Stripe, use a restricted key, so that the agent can do only what you allow.

## Choose the tools

After Talyn connects, it lists the server's tools. Choose which ones your agents can use:

- **All tools (including any this server adds later)**.
- Only the tools you tick.
- None. The server stays connected, with no tools.

## Turn a server on or off

Each server has an On/Off switch. A server that is off is not given to any run.

A [loop](/docs/loops#mcp-servers) can use every server that is on, or a set you choose for that loop.

## Remove a server

Select delete on the server. Talyn also deletes its stored key. Runs that already started keep the access they had.

## Plans

You can connect as many MCP servers as you like on every plan.
