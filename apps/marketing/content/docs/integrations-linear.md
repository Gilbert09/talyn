---
title: Linear integration
description: Connect Linear and start a session or a task when an issue changes. Talyn writes back to the issue.
---

Linear rules are in early access. The cards show only for accounts that have the `issue-rules` flag. Open **Integrations > Linear** to connect Linear and create rules.

## Connection

Select **Connect Linear**. A Linear workspace admin must approve the install.

Talyn's Linear app installs as an app user. It shows as "Talyn" in Linear. It asks for these scopes: `read`, `write`, `issues:create`, `comments:create` and `app:assignable`.

You can connect more than one Linear workspace. **Disconnect** revokes Talyn's token.
If Linear removes the app, or the sign-in stops working, the page shows **Reconnect**.

### Also connect as an MCP server

The page offers **Also connect as an MCP server**. It starts the normal sign-in for the Linear MCP server.

This is a separate grant. The MCP grant lets agents read and change Linear from a session.
The integration grant is only for Talyn's own triggers and write-back. See [MCP servers](/docs/mcp-servers).

## Create a rule

A rule says: on this event, if the conditions match, do these actions. Create rules under **Integrations > Linear > Rules**.

| Event | Fires when |
| --- | --- |
| **Issue created** | A new issue appears. |
| **Label added to the issue** | Someone adds a label. |
| **Issue assigned** | Someone assigns the issue. |
| **Issue status changed** | The issue moves to a new status. |
| **Comment on the issue** | Someone adds a comment. |
| **Issue title or description changed** | Someone edits the title or description. |

| Condition | Notes |
| --- | --- |
| **Linear workspace** | Required. |
| **Team**, **Project**, **Status** | Match one or more values. |
| **Priority** | Urgent, High, Medium, Low or No priority. |
| **Labels** | Has any, all or none of these labels. Also **The label that was added**. |
| **Assigned to** | Talyn, Nobody, or specific people. |
| **Title contains** | Matches words in the title. |
| **Description or comment contains** | Matches words in the description or the comment. |

To use **Assigned to Talyn**, assign the issue to Talyn in Linear, or delegate it to Talyn.

## Actions

A rule starts a session by default (**Start session**). It can start a cloud task instead (**Start task**).
A rule has one start action. The start action must name a repository.

| Action | What it does |
| --- | --- |
| **Start session** or **Start task** | Starts the work on the repository you choose. Set the prompt, model and internet access. |
| **Comment on the issue** | Posts a comment. Use `{{issue.identifier}}`, `{{issue.url}}`, `{{issue.title}}`, `{{session.url}}` and `{{task.url}}`. |
| **Change the issue status** | Moves the issue to `done`, or to a Linear status name you give. |

## Write-back

Write-back is on by default.

- When work starts, Talyn comments on the issue: "Talyn started working on this", with a link to the session or task.
- When the pull request that the work opened merges, Talyn comments: "Talyn merged a fix for this", with a link to the pull request. Talyn then moves the issue to done. This is the first status of type "completed" in the team. It is usually Done.

The start action has two switches. One turns off the start comment. The other turns off the move to done. The merge comment stays.

Write-back runs on Talyn's servers with the connection's credential. The agent in the sandbox never gets it.
If Linear rate-limits Talyn, the write-back waits and tries again.

## One piece of work per issue

While a session or task from an earlier event is still running on an issue, a new event on the same issue does not start more work. The run history shows `issue_already_running`.

The issue is free again when the work ends without a merge. This happens when:

- a task ends without a pull request,
- a session is archived without an open pull request, or
- the pull request closes without a merge.

## Limits

Talyn ignores its own comments and changes, so a rule cannot trigger itself.
The rule's **runs per hour** setting applies to each issue.

Each session or task uses box-hours, like any other. See [Plans, usage and billing](/docs/billing).

## The prompt

Your prompt comes first. Below it, Talyn adds the issue title, the description and the newest comments (up to 10). It quotes them and marks them as untrusted. Anybody who can write on the issue wrote them.

`{{issue.identifier}}`, `{{issue.url}}` and `{{issue.title}}` go in the prompt text only when the value is one short token. Otherwise Talyn quotes the value below the prompt.
`{{issue.body}}` is always quoted below the prompt.

## Runs

Open **Runs** to see each result.
