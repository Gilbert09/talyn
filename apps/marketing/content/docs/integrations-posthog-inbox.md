---
title: PostHog Inbox integration
description: Start a session that opens a pull request when a PostHog self-driving report is ready for work.
---

PostHog Inbox rules are in early access. The card shows only for accounts that have the `posthog-inbox-rules` flag. Open **Integrations > PostHog Inbox** to create rules.

PostHog self-driving writes reports about problems in your product. Each report has a title, a summary, a priority (P0 to P4) and a repository. A PostHog Inbox rule picks the reports to act on. For each one, Talyn starts a session that fixes the problem and opens a pull request.

## Connection

PostHog Inbox has its own PostHog connection. Open **Integrations > PostHog Inbox > Connection**, then select **Connect with PostHog**.

- On the PostHog screen, pick the one project whose Inbox Talyn reads.
- Talyn asks for `inbox:read` (read reports), `inbox:write` (claim reports), `task:write` (attach the pull request to a claim), and `hog_function:read` and `hog_function:write` (set up the push destination in PostHog for you).
- A connection made before Talyn asked for `hog_function:*` keeps working for rules and claims. Only **Set up push in PostHog** needs these permissions. Reconnect to grant them.
- The card shows the project and the host. **Reconnect** starts the PostHog screen again. **Disconnect** removes only the PostHog Inbox connection.
- When the connection is missing a permission, the card names it and asks you to reconnect.

A deployment without PostHog sign-in shows a form for a personal API key instead. The key needs the `inbox:read`, `inbox:write` and `task:write` scopes. Talyn checks that the key can read the Inbox before it saves it. The card shows whether PostHog accepted the key after the first check.

A workspace that set up PostHog Inbox rules on a PostHog Code connection keeps working. Talyn uses that connection when it has the Inbox permissions and the Inbox has no connection of its own. The card then asks you to connect PostHog for the Inbox. When you connect, the Inbox uses its own connection only. Disconnecting one connection never changes the other.

On the mobile app, the card shows the connection state. To connect or reconnect, open the page on the web.

Without `inbox:write` and `task:write`, the rules start no sessions, because Talyn starts a session only after it claims the report. **Preview matches** still works with `inbox:read` only.

## How Talyn finds reports

Talyn checks your PostHog project about every 3 minutes. It reads the reports that are **ready**, not claimed, and not already being handled, and that changed since the last check. Talyn always reads each report again from PostHog before it acts.

PostHog can also push to Talyn when a report becomes ready. Then rules act within seconds. See [Push from PostHog](#push-from-posthog).

A new rule acts on reports that become ready or change after it is enabled. To see what a rule matches now, use **Preview matches** in the editor. The preview starts nothing.

When a report changes, a rule can act on it again. While a session from that report is still working, Talyn does not start a second one. The run history shows `issue_already_running`.

## Claims in PostHog

Talyn claims each report in PostHog before it starts a session. The claim tells people and other agents that Talyn is working on the report. Talyn never starts a session without a claim.

- **Somebody else claimed the report first.** Talyn starts no session. The run shows as **Skipped**, with the reason. Talyn never takes a claim over.
- **PostHog refuses the claim or does not answer.** Talyn starts no session yet. The run waits and tries again: 30 minutes after a 401 or 403, PostHog's `Retry-After` after a 429, and 10 minutes after any other failure. Talyn also stops reading new reports for that time.
- **The session opens a pull request.** Talyn adds the pull request to the claim. When the pull request merges, PostHog resolves the report.
- **The work ends without a pull request.** Talyn releases the claim, so the report is free again. This happens when the session is archived or deleted, when it fails, or when the agent decides that the diagnosis is wrong.
- **The pull request closes without a merge.** Talyn releases the claim. The pull request stays on the report.

PostHog's release has no field for a reason, so the reason shows only in Talyn's run history.

When a write to PostHog fails, Talyn tries again with the same waits. The run history shows that an update is still owed.

## Push from PostHog

A push tells Talyn that a report is ready. Talyn uses only the report id from the push. It then reads the report from your PostHog project with your connection, as for a check. A push that names a report your project does not have is dropped.

### Let Talyn set it up

1. Open **Integrations > PostHog Inbox > Connection**.
2. Click **Set up push in PostHog**.

Talyn makes a webhook URL and a secret. Then it adds a destination named **Talyn – PostHog Inbox push** in your PostHog project. The destination sends `POST` requests with the default JSON body when an Inbox report is ready. The secret is in an encrypted secret header, `X-Talyn-Secret`, and debug logging is off. Nobody needs to copy the URL or the secret, so Talyn does not show them.

The Connection tab then shows **Open the destination in PostHog**, which opens the destination in PostHog.

- This needs the `hog_function:read`, `hog_function:write` and `inbox:read` permissions. Your PostHog user also needs access to the Inbox. If the connection does not have the permissions, the card asks you to reconnect. Talyn then changes nothing.
- If PostHog refuses or does not answer, Talyn changes nothing, and the old URL keeps working.
- Run it again at any time. Talyn updates its own destination and does not make a second one. If somebody deleted the destination in PostHog, Talyn makes a new one.
- If you set up the push by hand before, the old URL stops working. Delete your own destination in PostHog.

### Set it up by hand

Use this with a personal API key that does not have the `hog_function` scopes, or if you prefer to add the destination yourself.

1. Open **Integrations > PostHog Inbox > Connection**.
2. Click **Make a webhook URL**. By default, the URL also needs a secret header. Clear **Require a secret header** if you do not want one.
3. Copy the URL and the secret. Talyn shows them only once.
4. In your PostHog project, open **Data pipelines** and add a new destination. Choose **HTTP Webhook when an Inbox report is ready**.
5. Paste the URL. Keep the `POST` method and the default JSON body.
6. If you use the secret, add it under the secret headers as `X-Talyn-Secret`. PostHog keeps secret headers encrypted.
7. Save and turn on the destination.

The Connection tab shows the time of the last push and the requests that PostHog sent. Each request shows whether a rule ran, and why Talyn dropped it if it did. **Replay** reads the report again. A report version that a rule already acted on does not start a second session.

While pushes arrive, Talyn checks the Inbox only every 30 minutes, to catch a push that was lost. When no push arrives for 24 hours, Talyn goes back to checking every 3 minutes. A push and a check of the same report version never both start work.

**Rotate URL** makes a new URL and secret. The old ones stop at once.

- If Talyn set up the destination, Talyn gives it the new URL and secret. If PostHog does not take the change, the rotate still happens. The card then says that the destination is out of date and still sends to the old URL. Click **Update the destination in PostHog** to fix it.
- If you added the destination by hand, update it in PostHog.

**Remove URL** stops the push. If Talyn set up the destination, Talyn deletes it in PostHog too. If PostHog does not delete it, Talyn tells you, and you can delete it in PostHog. **Disconnect** also deletes the destination when it can. A PostHog failure never stops the disconnect.

PostHog sends this event only to organizations where PostHog turned it on. If no request arrives, the 3-minute check still works.

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

Your prompt comes first. Talyn then tells the agent to check the report's diagnosis against the code before it changes anything. When the diagnosis is wrong, the agent stops and opens no pull request. The last line of its message then starts with `TALYN_REPORT_NOT_FIXED:` and gives the reason. Talyn reads that line and releases the claim.

Below the prompt, Talyn adds the report's title, priority, link and summary. It quotes them and marks them as untrusted, because PostHog wrote them from product data that anybody can influence.

`{{report.title}}`, `{{report.url}}` and `{{report.id}}` go in the prompt text only when the value is one short token. Otherwise Talyn quotes the value below the prompt. `{{report.summary}}` is always quoted below the prompt.

## Limits

Each rule has a **runs per day** limit. The default is 10. When a rule reaches it, the rule stands down until the 24-hour window moves on. The run history shows this once.

Each session uses box-hours, like any other. See [Plans, usage and billing](/docs/billing).

## Runs

Open **Runs** to see each result. For each run that started a session, the history also shows the claim: claimed, pull request attached, merged, released (with the reason), or ended by PostHog. The mobile app shows the same line.
