---
title: PostHog Inbox integration
description: Start a session that opens a pull request when a PostHog self-driving report is ready for work.
---

PostHog Inbox rules are in early access. The card shows only for accounts that have the `posthog-inbox-rules` flag. Open **Integrations > PostHog Inbox** to create rules.

PostHog self-driving writes reports about problems in your product. Each report has a title, a summary, a priority (P0 to P4) and a repository. A PostHog Inbox rule picks the reports to act on. For each one, Talyn starts a session that fixes the problem and opens a pull request.

## Connection

PostHog Inbox uses the PostHog connection on the **PostHog Code** page. You connect nothing new.

The connection needs permission to read the Inbox. A PostHog connection made before PostHog Inbox rules does not have it. PostHog Code keeps working, but the rule editor asks you to **Reconnect PostHog**. Connect again from the PostHog Code page, and approve the Inbox permissions.

A personal API key needs the `inbox:read` scope. The editor shows whether PostHog accepted the key after the first check.

## How Talyn finds reports

Talyn checks your PostHog project about every 3 minutes. It reads the reports that are **ready**, not claimed, and not already being handled, and that changed since the last check. Talyn always reads each report again from PostHog before it acts.

A new rule acts on reports that become ready or change after it is enabled. To see what a rule matches now, use **Preview matches** in the editor. The preview starts nothing.

When a report changes, a rule can act on it again. While a session from that report is still working, Talyn does not start a second one. The run history shows `issue_already_running`.

## Create a rule

A rule has one event, **Report ready for work**, and one action, **Start a session**.

| Condition | Notes |
| --- | --- |
| **Repository** | Only reports for these repositories. |
| **Priority** | Only reports with one of these priorities. |
| **Actionability** | Without this, only reports PostHog judged ready to fix. |
| **Source product** | Only reports with signals from one of these PostHog products, like `error_tracking`. |
| **Scout** | Include or exclude reports by the scout that wrote them. |
| **Suggested reviewer** | Only reports where PostHog suggests one of these GitHub logins as a reviewer. |
| **Title contains** / **Summary contains** | Matches words in the title or the summary. |
| **At least this many signals** | Only reports that group this many signals or more. |

Two checks apply to every rule:

- The report's repository must be connected to your Talyn workspace. Otherwise, nothing starts.
- Talyn never acts on a report that PostHog's safety judge held back.

## The session

The session works on the report's own repository and opens a pull request.

Your prompt comes first. Talyn then tells the agent to check the report's diagnosis against the code before it changes anything. When the diagnosis is wrong, the agent stops and opens no pull request.

Below the prompt, Talyn adds the report's title, priority, link and summary. It quotes them and marks them as untrusted, because PostHog wrote them from product data that anybody can influence.

`{{report.title}}`, `{{report.url}}` and `{{report.id}}` go in the prompt text only when the value is one short token. Otherwise Talyn quotes the value below the prompt. `{{report.summary}}` is always quoted below the prompt.

## Limits

Each rule has a **runs per day** limit. The default is 10. When a rule reaches it, the rule stands down until the 24-hour window moves on. The run history shows this once.

Each session uses box-hours, like any other. See [Plans, usage and billing](/docs/billing).

## Runs

Open **Runs** to see each result.
