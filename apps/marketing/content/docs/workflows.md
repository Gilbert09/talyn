---
title: GitHub automations
description: Run actions when pull request events match your conditions.
---

A GitHub automation watches pull request events. It checks your conditions, then runs your actions.
It covers every pull request in repositories your workspace watches, including pull requests you did not open.
Talyn runs automations on its servers, so the app can stay closed.

## Create a GitHub automation

1. Select **Integrations** in the sidebar.
2. Open **GitHub > Automations**.
3. Select **New automation** and give it a name, for example "Label new PRs from bots".
4. Under **When this happens**, select **Add trigger** and pick an event.
5. Optionally, under **Only if**, select **Add condition**.
6. Under **Do this**, select **Add action**. Actions run in order, top to bottom.
7. Select **Create an automation**.

Any one of the triggers starts the automation. Every condition must hold.

To open an automation from anywhere in the desktop or web app, press **⌘K** (**Ctrl+K** on Windows and Linux) and type its name.
The command palette lists every automation in the workspace, including Slack, webhook, issue and schedule automations.

## Triggers

| Group | Triggers |
| --- | --- |
| Checks | All checks passed, A check suite finished |
| Lifecycle | PR opened, PR reopened, PR closed without merging, PR merged, PR title, body or base changed, New commits pushed |
| Draft | Marked ready for review, Converted to draft |
| Labels and people | Label added, Label removed, Someone assigned, Someone unassigned |
| Reviews | Review requested, Review request removed, Review submitted, Review dismissed |
| Comments | Comment on the diff, Comment on the PR |

**All checks passed** and **A check suite finished** fire only on pull requests that Talyn already tracks.

## Conditions

With no conditions, an automation runs on every pull request its trigger fires for. Add conditions to narrow it:

- Repository, base branch, or **Targets the default branch**
- **Opened by**, **Done by**, or **The person named**: Anyone, Me, Any person, Any bot, or specific accounts
- **Title contains**
- **Has any of these labels**, **Has all of these labels**, **Has none of these labels**, or **The label that changed**
- **Draft**: Not a draft, or Drafts only
- **Review verdict**
- **Checks passed or failed**
- **Comment contains**

The editor offers only the conditions that make sense for the triggers you picked.

## Actions

| Action | What it does |
| --- | --- |
| **Add labels** | Adds labels. Labels already on the pull request stay. |
| **Remove labels** | Removes labels. |
| **Request reviewers** | Requests reviews. The author is left out. |
| **Assign people** | Assigns people. They must be collaborators on the repository. |
| **Post a comment** | Posts a comment on the pull request as Talyn. You can use templates such as `{{pr.author}}` and `{{pr.baseBranch}}`. |
| **Run a skill** | Runs a [skill](/docs/skills) on the pull request with an agent. |
| **Run a prompt** | Runs your prompt on the pull request with an agent. |
| **Add to My PRs** | Tracks the pull request on your **Pull requests** page. |
| **Add to the merge queue** | Queues the pull request. You can pick the merge method: Squash, Merge commit, Rebase, or whatever the pull request is set to. |
| **Run a code review** | Starts a [code review](/docs/code-review). The findings stay in Talyn. |

**Run a skill** and **Run a prompt** run at most once on each pull request.

## Run history

Open **GitHub > Runs** to see automation runs. Each run shows the pull request, event, and action results.
A run is **Running**, **Waiting to retry**, **Done**, **Partly done**, **Failed**, or **Stood down**.
When a run starts a session, click **Open the session it started** to go to that session. On mobile, tap the run.

**Waiting to retry** means GitHub rate-limited an action. Talyn tries it again later, and does not repeat the actions that already worked.

## Loop protection

Talyn ignores events caused by its own actions, so an automation does not trigger itself.
In **Advanced**, set **Stop after this many runs on one PR per hour**. The default is 5.
A run over the limit is recorded as stood down.

## Cost

GitHub automations are free to create. Actions that run an agent use box-hours.
When no box is available, the action waits until there is room.
