---
title: The pull request dashboard
navLabel: PR dashboard
description: Every pull request you have open, across every repository you connect, with the ones that need you pulled to the front. Filters, review requests, and how to add repositories.
---

Talyn keeps a live list of your pull requests. Updates arrive from GitHub as they happen, so a check that goes red goes red on your screen without a refresh.

The sidebar has three pull request pages:

- **Pull requests**: the pull requests you opened, and the ones you track.
- **Review requests**: pull requests where someone asked you for a review.
- **Merge queue**: the pull requests waiting to merge. See [Merge queue](/docs/merge-queue).

## Add repositories

Talyn shows pull requests from the repositories your workspace watches.

1. Open **Settings > Repositories** in the desktop app, or **Settings > Workspace** in the web app.
2. Select **Add Repository**.
3. Search for the repository, or type `owner/name`, or paste its URL.

You can also select **Add repository** in the sidebar.

The Talyn GitHub App must be installed on the account that owns the repository. Without it, Talyn polls public repositories every few minutes instead of getting live updates, and cannot see private ones. A banner tells you when the App is missing, with an **Install app** button.

## Your pull requests

The **Pull requests** page (titled **My PRs**) lists the pull requests you opened, and the pull requests you track.

The filters at the top narrow the list. Each shows a count.

| Filter | Shows |
| --- | --- |
| **Needs attention** | Pull requests that are blocked: failing checks, merge conflicts, behind the base branch, changes requested, or a check that needs a person. |
| **Needs review** | Your pull requests that still need an approving review. |
| **Ready to merge** | Pull requests that can merge now: checks done, no conflicts, no review outstanding. |
| **Watching** | Pull requests you track by hand. |

You can also filter by repository, sort by **Newest** or **Oldest**, and search by title, repository or number. Press ⌘F on a Mac to search.

To save a set of filters, use the saved filters bar. A saved filter can match repositories, labels, words in the title, authors and review state (approved or not approved).

### Track any pull request

To follow a pull request you did not open:

1. Select **Add PR**.
2. Paste the pull request's link.

If the repository is not in your workspace yet, Talyn offers to add it.

## Read a row

Each row shows the title, the repository and number, the author, and how long ago it was opened. The status column shows the review state and a check and merge state:

| Label | Means |
| --- | --- |
| **Ready** | It can merge. |
| **N/M running** | Checks are still running. |
| **N/M failing** | Required checks failed. |
| **N non-required** | Only checks that are not required failed. |
| **Conflicts** | The branch conflicts with its base. |
| **Behind** | The branch is behind its base and must be updated first. |
| **Changes requested** | A reviewer asked for changes. |
| **Review** | A required review is missing. |
| **Protected** | It is approved, but branch protection still holds it. |
| **Needs human** | A check that only a person can clear is failing, such as a visual review that waits for approval. |

A speech bubble shows the number of unresolved review comments. Stacked pull requests are grouped, and the bottom one shows **Stack of N**.

Hover over a row to see its actions: **Fix**, run a skill, add to the merge queue, merge, open the session, copy a link, and open it on GitHub.

## The detail view

Select a row to open the pull request. The tabs are **Overview**, **Findings**, **Checks**, **Reviews** and **Files**: the summary, the code review findings, every check with the failing job's output, the review conversation, and the diff.

The buttons at the top are **Code review**, **Fix with agent**, **Auto-keep mergeable**, **Add to merge queue** and **Merge**.

## Review requests

The **Review requests** page lists open pull requests where you, or a team you are on, are a requested reviewer.

Sort it by **Newest**, **Oldest** or **Priority**. Priority puts first the pull requests that most likely need you now, based on their state, their size and how long they have waited. Each row shows the reason for its place.

To drop a pull request from the list and the count, select the hide icon on its row. It stays hidden even if you are asked again. To bring it back, select **Show N hidden pull requests** at the bottom of the list, then the eye icon on its row.

To keep a pull request on **My PRs** after you review it, select the bookmark icon.

In the mobile app, a pull request that asks for your review has **Approve** and **Request changes** buttons. The review goes to GitHub from your own account. Request changes needs a comment.

## Share a list

**Copy list** copies the pull requests you can see as a list, ready to paste into Slack.
