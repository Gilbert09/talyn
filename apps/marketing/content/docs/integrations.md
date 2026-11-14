---
title: Integrations
description: Connect services, write automations, and review runs in one place.
---

Open **Integrations** in Talyn to see the catalog. Each integration has its own page at `/integrations/:kind`.

| Integration | What it does |
| --- | --- |
| [GitHub](/docs/workflows) | Watches pull requests and runs automations on their events. |
| [Slack](/docs/integrations-slack) | Starts sessions from personal triggers or channel automations. |
| [Webhooks](/docs/integrations-webhook) | Gives an automation its own URL. A request to it starts a session or a task. |
| [Linear](/docs/integrations-linear) | Starts a session or a task when a Linear issue changes, and writes back to the issue. |
| [GitHub Issues](/docs/integrations-github-issues) | Starts a session or a task when a GitHub issue changes, and writes back to the issue. |
| [Schedule](/docs/loops) | Starts a scheduled automation at the time you choose. |
| Tailscale | Connects private routes for Talyn Fleet sandboxes. |
| PostHog Code | Connects an agent that runs work in the cloud. |
| Trunk | Shows merge queue status and timing. |

## Automations

An automation says: on these events, matching these conditions, do these actions. GitHub, Slack, webhook, Linear and GitHub Issues automations use this pattern.

Scheduled automations were called loops before. They work the same way.

Open an integration to see **Automations** and **Connection**. Connection shows access and settings.
Automations lists the actions Talyn takes. Select **Show history** on an automation to see what happened when it fired.

Slack channel automations are rolling out. The `slackChannelRules` flag controls access.
Webhook automations are in early access.
Linear and GitHub Issues rules are in early access. The `issue-rules` flag controls access.
