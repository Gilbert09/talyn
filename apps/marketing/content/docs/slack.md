---
title: Slack
description: Start a session from a Slack message with an emoji reaction, a mention or a direct message. Talyn shows progress as reactions and never posts in your channels.
---

Start a session from Slack. React to a message with your trigger emoji, mention `@Talyn`, or send Talyn a direct message. A session starts with the Slack thread as its brief.

Talyn never posts in your channels. It shows a session's progress as reactions on the message that started it.

## Set it up

1. In Talyn, open **Settings > Slack**.
2. Select **Connect Slack** and install the Talyn app in your Slack workspace.
3. Select **Link my Slack account** to connect your Slack identity to your Talyn account.
4. Select **Add emoji** and pick one or more trigger emoji. Custom emoji from your Slack workspace work too.
5. If you have more than one Talyn workspace, pick the one that gets the sessions.
6. In each Slack channel where you want Talyn, run `/invite @talyn`.

With no trigger emoji, reactions do not start a session. Mentions and direct messages still do.

## Start a session

In a channel where Talyn is a member, do one of these:

- React to a message with your trigger emoji.
- Mention `@Talyn` in a message or a thread.
- Send Talyn a direct message.

The session starts in the Talyn workspace of the person who started it, on that person's plan.

## How Talyn picks the repository

Talyn looks, in this order, for:

1. A GitHub link or `owner/repo` in the message.
2. A repository name in the message.
3. The repositories that earlier sessions from Slack used.
4. A code search on GitHub.
5. Your only repository, if you have one.

If no repository is a clear match, Talyn does not guess. It asks you to pick one in the app.

## Reactions

| Reaction | Means |
| --- | --- |
| 👀 | Starting |
| ⏳ | Working |
| ✅ | Done, or waiting for you |
| 🔗 | Pull request open |
| 🎉 | Merged |
| ❌ | Failed |
| ❓ | Needs a repository or an answer |

The session links back to the Slack thread.

## Slack text is untrusted

Anyone in a channel can write a message. Talyn keeps your instruction apart from the quoted Slack text, and tells the agent that the quoted text is untrusted.

## Disconnect

Open **Settings > Slack** to **Unlink my account**, or to **Disconnect workspace**. Only the person who installed the app can disconnect the workspace. Talyn then forgets its Slack token. The app stays installed in Slack until you remove it there.
