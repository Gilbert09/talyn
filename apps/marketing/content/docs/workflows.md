---
title: Workflows
description: Write a rule once and it runs on every pull request in your repositories. When something happens, and these conditions hold, Talyn labels, assigns, comments, runs an agent or queues the merge.
---

A workflow is a rule for your pull requests: when this happens, only if these conditions hold, do these things. It runs on every pull request in the repositories your workspace watches, including ones you did not open. It runs on Talyn's servers, so the app does not need to be open.

## Create a workflow

1. Select **Automations** in the sidebar.
2. Open the **Workflows** tab.
3. Select **New workflow** and give it a name, for example "Label new PRs from bots".
4. Under **When this happens**, select **Add trigger** and pick an event.
5. Optionally, under **Only if**, select **Add condition**.
6. Under **Do this**, select **Add action**. Actions run in order, top to bottom.
7. Select **Create workflow**.

Any one of the triggers starts the workflow. Every condition must hold.

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

With no conditions, a workflow runs on every pull request its trigger fires for. Add conditions to narrow it:

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

Expand a workflow to see its runs. Each run shows the pull request, the event and what each action did. A run is **Running**, **Waiting to retry**, **Done**, **Partly done**, **Failed** or **Stood down**.

**Waiting to retry** means GitHub rate-limited an action. Talyn tries it again later, and does not repeat the actions that already worked.

## Loop protection

Talyn ignores events caused by its own actions, so a workflow does not trigger itself. In **Advanced**, **Stop after this many runs on one PR per hour** limits how often one workflow runs on one pull request. The default is 5. A run over the limit is recorded as stood down.

## Cost

Workflows are free to create. Actions that run an agent (a skill, a prompt or a code review) use box-hours. When you are out of box-hours or every box is busy, the action waits and runs when there is room.
