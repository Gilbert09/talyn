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
| [PostHog Inbox](/docs/integrations-posthog-inbox) | Starts a session that opens a pull request when a PostHog self-driving report is ready for work. |
| [Schedule](/docs/loops) | Starts a scheduled automation at the time you choose. |
| Tailscale | Connects private routes for Talyn Fleet sandboxes. |
| PostHog Code | Connects an agent that runs work in the cloud. |
| Trunk | Shows merge queue status and timing. |

## Automations

An automation says: on these events, matching these conditions, do these actions. GitHub, Slack, webhook, Linear, GitHub Issues and PostHog Inbox automations use this pattern.

GitHub and schedule automations keep working after this name change.

Open an integration to see **Connection**, **Automations**, and **Runs**. Connection shows access and settings.
Automations shows the actions Talyn will take. Runs shows what happened when each automation fired.

Slack channel automations are rolling out. The `slackChannelRules` flag controls access.
Webhook automations are in early access.
Linear and GitHub Issues rules are in early access. The `issue-rules` flag controls access.
PostHog Inbox rules are in early access. The `posthog-inbox-rules` flag controls access.
