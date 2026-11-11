---
title: Integrations
description: Connect services, write rules, and review runs in one place.
---

Open **Integrations** in Talyn to see the catalog. Each integration has its own page at `/integrations/:kind`.

| Integration | What it does |
| --- | --- |
| [GitHub](/docs/workflows) | Watches pull requests and runs rules on their events. |
| [Slack](/docs/integrations-slack) | Starts sessions from personal triggers or channel rules. |
| [Schedule](/docs/loops) | Starts a scheduled rule at the time you choose. |
| Tailscale | Connects private routes for Talyn Fleet sandboxes. |
| PostHog Code | Connects an agent that runs work in the cloud. |
| Trunk | Shows merge queue status and timing. |

## Rules

A rule says: on these events, matching these conditions, do these actions. GitHub and Slack rules use this pattern.

The GitHub rules were called Workflows. Schedule rules were called Loops. Your existing rules keep working.

Open an integration to see **Connection**, **Rules**, and **Runs**. Connection shows access and settings.
Rules shows the actions Talyn will take. Runs shows what happened when each rule fired.

Slack channel rules are rolling out. The `slackChannelRules` flag controls access.
