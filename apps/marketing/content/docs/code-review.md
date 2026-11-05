---
title: Code review
description: Have several agent reviewers read a pull request, check their findings, and show you the short list in Talyn. Nothing is posted to GitHub unless you choose Post to PR.
---

A Talyn code review reads a pull request from several angles, checks what it found, and shows you the findings in Talyn. It writes nothing to GitHub while it runs. You decide what to fix and what, if anything, to post.

## Review a pull request

1. Open the pull request from the **Pull requests** page.
2. Select the **Findings** tab.
3. Pick a depth.
4. Select **Review this pull request**.

Findings appear as the reviewers find them. Until the checking pass has run, Talyn marks them as not checked yet, and some are usually dropped.

After a review, select **Review again** to run another, or **Review this commit** when there are new commits. Select **Stop** to cancel a review that is running.

## Depth

| Depth | What runs | How long |
| --- | --- | --- |
| **Quick** | One reviewer, one pass. No second pass and no checking pass, so expect more noise. | Usually under ten minutes |
| **Standard** (default) | Three reviewers in parallel, then a second pass for anything they missed, then a checking pass on each finding. | Typically half an hour |
| **Deep** | Five reviewers, the second pass and the checking pass. A large pull request is read in pieces rather than skimmed. | An hour or more on a large pull request |

The reviewers are **Logic**, **Security**, **Reliability**, **Tests** and **Operability**. Standard uses the first three. Talyn skips a reviewer when the files make it pointless, for example a change to docs only. Generated files, lock files and vendored code are not reviewed.

The **second pass** reads what every reviewer found, all together, and looks for what they missed. The **checking pass** goes through each finding again and drops the ones it cannot stand behind.

## Findings

Findings are grouped by severity:

| Severity | Means |
| --- | --- |
| **Must fix** | A blocker. |
| **Should fix** | A real problem worth fixing in this pull request. |
| **Consider** | Worth a look. |
| **Nitpick** | Small things. |

Each finding says which reviewers raised it. When two reviewers find the same problem, it shows once, with both named. **Location confirmed** means Talyn found the quoted code at the line the finding names.

To dismiss a finding, pick a reason: **Not a problem**, **Already handled**, **Not in this PR** or **Wrong about the code**. Dismissed findings and nitpicks move to **Also looked at**. A dismissal holds for later reviews of the same pull request.

## Fix findings

1. Tick the findings you want fixed.
2. Select **Fix selected**. Or select **Fix all N** to fix every finding shown.

Talyn sends an agent to make the changes and push one commit to the branch. Then review again to check that the fix held.

A fix cannot run while another run is working on the same pull request.

## Post to PR

To put the findings on GitHub:

1. Tick the findings to post. If you tick none, Talyn posts all the findings shown.
2. Select **Post to PR**.
3. Confirm.

Talyn posts one review from your own GitHub account, as a comment. It never approves or requests changes. A finding becomes an inline comment only when its location is confirmed and its lines are in the diff. The rest go in the review's summary. Talyn never posts the same finding twice.

## Settings

Open **Settings > Code review** to change how reviews work in this workspace.

- **Review every pull request**: turn on **Review my new pull requests automatically** to review pull requests from your workspace as they are pushed. Drafts are skipped. This needs a paid plan.
- **How deeply**: the default depth.
- **Who reviews**: Talyn's reviewers, your own reviewers, or both. See below.
- **What is worth your attention**: the lowest severity to show.
- **Fix findings for me**: turn on **Fix findings without asking** to fix findings automatically. It is off by default. It touches only findings that the checking pass confirmed and whose location is confirmed, at or above a severity you pick. The default is **Must fix** only.
- **On GitHub**: **Post a summary comment after a fix**, and **Post blockers as inline comments**. Both are off by default.

## Your own reviewers

You can add your own reviewers. Each one is a [skill](/docs/skills): a `SKILL.md` file with the instructions for one kind of review, such as your team's security checklist.

1. Open **Settings > Code review**.
2. Under **Who reviews**, add a reviewer.
3. Search for a skill and select it.

A skill from a repository's `.claude/skills` folder reviews pull requests in that repository only. Talyn reads it from the repository's default branch, never from the pull request, so a pull request cannot change its own review. A skill saved in Talyn reviews pull requests in every repository. Skills on your own computer cannot be reviewers, because reviews run in the cloud.

A reviewer skill can be up to 96 KB. Your reviewer's findings show its name, like Talyn's reviewers do.

To use only your own reviewers, add one, then turn off **Talyn's reviewers**.

## The merge queue and blockers

If a review of the current commit finds a confirmed **Must fix**, the [merge queue](/docs/merge-queue) holds the pull request until you fix or dismiss it.

## Cost

Each reviewer runs in its own Small sandbox and uses box-hours. The model runs on your own Claude or ChatGPT subscription.
