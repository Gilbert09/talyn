---
title: Merge queue
description: Queue a pull request and Talyn merges it when it is ready, updating the branch and fixing conflicts and failing checks on the way.
---

The merge queue lands pull requests for you. Queue a pull request, and Talyn waits for its checks and reviews, keeps the branch up to date, fixes what breaks, and merges it.

It needs no GitHub organization or Enterprise plan. Talyn merges through GitHub's normal merge API, so your branch protection rules apply exactly as you set them.

## Queue a pull request

1. On the **Pull requests** page, hover over the row.
2. Select the checklist icon.

In the detail view, select **Add to merge queue**. Select it again to remove the pull request from the queue.

To queue a stack of pull requests, select **Merge stack (N)**. They merge one at a time, and Talyn moves each one onto its parent's base as the parent lands.

A draft pull request waits in the queue until you mark it ready for review.

## What the queue does

For each pull request, Talyn:

1. Waits for checks and required reviews.
2. Updates the branch with GitHub's **Update branch** when it falls behind and there is no conflict.
3. Re-runs failed checks.
4. Sends an agent to fix a conflict or a failing check.
5. Merges the pull request, with a squash merge.

When a repository uses GitHub's own merge queue, Talyn hands the pull request to it instead of merging around it.

## Order

The **Merge queue** page groups pull requests by repository and base branch. Choose how they merge:

- **In order** (the default): one at a time, first in, first out, for each repository and base branch.
- **When ready**: each pull request merges as soon as it is clean. Talyn fixes the blocked ones at the same time.

## Status

The detail view shows where a pull request is in the queue, for example **Waiting in line**, **Waiting for CI**, **Waiting for a required review**, **A cloud fix run is working this PR** or **Merging**.

## When the queue gets stuck

The queue gives each fix 3 attempts on the current commit. A new push resets the count. If a fix leaves the same problem in place, the queue stops trying instead of spending more runs.

Two states need you:

- **Needs you**: the queue waits for a person, for example a visual review that needs approval, an agent that said only a person can continue, or a code review blocker. It carries on by itself when that is done.
- **Blocked**: the queue gave up. Fix the problem or merge by hand, then select **Requeue** to reset the attempts and try again.

### Code review blockers

If a [code review](/docs/code-review) of the current commit finds a confirmed blocker, the queue holds the pull request. Fix the finding or dismiss it in the **Findings** tab, and the pull request goes back in the queue.

## Cost

Fix runs use box-hours from your plan. Updating a branch, re-running checks and merging use none.
