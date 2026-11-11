---
title: Slack integration
description: Connect Slack, link your account, and set personal triggers or channel automations.
---

Open **Integrations > Slack** to connect your Slack workspace. Slack sends you back to `/integrations/slack` after installation.

## Connection

Select **Connect Slack** to install Talyn. Then select **Link my Slack account** to connect your Slack identity.

Invite the bot with `/invite @Talyn` in each channel you want it to read. Talyn only sees channels it joined.

Older Slack installs must reinstall the app before an automation can reply. Replies need the `chat:write` permission.

## Personal triggers

Choose a trigger emoji, mention `@Talyn`, or send the bot a direct message. These triggers start your session.

A bot mention uses the personal trigger. It does not start a channel automation.

See [Slack sessions](/docs/slack) for repository selection and progress reactions.

## Channel automations

Channel automations are rolling out behind the `slackChannelRules` flag. Create them under **Integrations > Slack > Automations**.

Each automation runs on a new message in a channel. Choose the Slack team and one or more channels.
Add **Text contains** to match words. Choose whether replies inside threads can start the automation.

By default, only people who linked their Slack account to Talyn can start an automation.
You can allow anyone in the channel or only given Slack user IDs instead.

Choose one or more actions:

| Action | What it does |
| --- | --- |
| **Start session** | Choose a repository or **Let Talyn choose**. Set the prompt, model, and internet access. |
| **Reply in thread** | Post text in the message thread. Use `{{session.url}}` or `{{message.permalink}}` in the text. |
| **React** | Add an emoji to the message. |

The workspace owner pays for the box-hours that an automation uses. Check **Runs** to see each result.
