---
title: Connect an agent
description: Run Claude Code on your Claude Pro or Max plan, or Codex on your ChatGPT plan. How to sign in, add more accounts and pick a default.
---

Talyn does not sell model usage. Each run uses the Claude or ChatGPT subscription that you connect, and the agent is the real Claude Code or Codex command-line tool.

You connect agents in **Settings > Agents** in the desktop app, or **Settings > Integrations** in the web app. The rows are **Claude subscription** and **Codex (ChatGPT) subscription**.

## Claude

You need a Claude Pro or Max subscription.

1. Select **Sign in with Claude**. Anthropic's own sign-in page opens in your browser. Talyn never sees your password.
2. Approve the request in the browser.
3. Copy the code that Anthropic shows you.
4. Paste it into **Code from Anthropic**.
5. Select **Finish sign-in**.

In the web app, your browser can block the sign-in tab. If it does, select **Open the Claude sign-in page** to open it.

The row shows **Connected**.

If you do not have a Claude subscription, or you want to pay per token, open **No Claude subscription? Use an Anthropic API key** and paste an Anthropic Console API key. Usage on that key is billed by Anthropic per token.

## Codex

You need a ChatGPT subscription.

**In the desktop app:**

1. Select **Sign in with ChatGPT**. OpenAI's own sign-in page opens in your browser. Talyn never sees your password.
2. Sign in and approve the request.

**In the web app:**

1. On your computer, install Codex and run `codex login`.
2. Copy the contents of `~/.codex/auth.json`.
3. Paste them into the field in Talyn.
4. Select **Save & verify**.

## More than one account

You can connect more than one account for each agent, for example a personal and a work Claude account. Talyn uses them in the order of the list. Use **Move up** and **Move down** to change the order.

Each account row shows its usage. When one account reaches its limit, Talyn uses the next one. See [Usage limits and failover](/docs/troubleshooting#usage-limits-and-failover).

## Pick the agent and model

You pick the agent and model when you start a session. The agent picker shows **Claude Code** and **Codex**, and an agent you have not connected is greyed out with the reason.

To set the defaults for new sessions, open **Settings > Sessions**. You can set the agent, the model, the reasoning effort, and whether new sessions start in plan mode.

For work that Talyn starts on a pull request, such as the **Fix** button, **Default for new tasks** sets which agent runs it. It is in **Settings > Pull requests** in the desktop app, and **Settings > Integrations** in the web app. Choose **Ask every time** to pick from a menu each time. You can also right-click **Fix** to pick a different agent for one run.

## Disconnect

Select the unlink icon on the row. Runs that need that agent stop being possible until you connect it again.

## When a sign-in stops working

If Anthropic or OpenAI rejects the saved sign-in, the row shows **Reconnect needed**. See [Reconnect an agent](/docs/troubleshooting#reconnect-needed).
