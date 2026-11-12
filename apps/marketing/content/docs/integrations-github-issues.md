---
title: GitHub Issues integration
description: Start a session or a task when a GitHub issue changes. Talyn writes back to the issue.
---

GitHub Issues rules are in early access. The cards show only for accounts that have the `issue-rules` flag. Open **Integrations > GitHub Issues** to create rules.

## Connection

GitHub Issues has its own card, separate from GitHub. It uses your existing GitHub App connection. You connect nothing new.

Rules work on issues in repositories the workspace watches. A comment on a pull request is not an issue comment here. Use a [GitHub pull request rule](/docs/workflows) for that.

## Create a rule

A rule says: on this event, if the conditions match, do these actions. Create rules under **Integrations > GitHub Issues > Rules**.

| Event | Fires when |
| --- | --- |
| **Issue created** | A new issue appears. |
| **Label added to the issue** | Someone adds a label. |
| **Issue assigned** | Someone assigns the issue. |
| **Issue status changed** | The issue opens or closes. |
| **Comment on the issue** | Someone adds a comment. |
| **Issue title or description changed** | Someone edits the title or description. |

| Condition | Notes |
| --- | --- |
| **Repository** | Match one or more repositories. |
| **Status** | Open or closed. |
| **Labels** | Has any, all or none of these labels. Also **The label that was added**. |
| **Assigned to** | Me, Nobody, or specific people. |
| **Opened by** | Matches the author of the issue. |
| **Title contains** | Matches words in the title. |
| **Description or comment contains** | Matches words in the description or the comment. |

## Actions

A rule starts a session by default (**Start session**). It can start a cloud task instead (**Start task**).
A rule has one start action. The repository defaults to the issue's own repository. You can choose another watched repository.

| Action | What it does |
| --- | --- |
| **Start session** or **Start task** | Starts the work. Set the prompt, model and internet access. |
| **Comment on the issue** | Posts a comment. Use `{{issue.identifier}}`, `{{issue.url}}`, `{{issue.title}}`, `{{session.url}}` and `{{task.url}}`. |
| **Change the issue status** | Sets the issue to `open` or `closed`. |

## Write-back

Write-back is on by default.

- When work starts, Talyn comments on the issue: "Talyn started working on this", with a link to the session or task.
- When the pull request that the work opened merges, Talyn comments: "Talyn merged a fix for this", with a link to the pull request. Talyn then closes the issue as completed.

The start action has two switches. One turns off the start comment. The other turns off the close. The merge comment stays.

Write-back runs on Talyn's servers with the connection's credential. The agent in the sandbox never gets it.
If GitHub rate-limits Talyn, the write-back waits and tries again.

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
