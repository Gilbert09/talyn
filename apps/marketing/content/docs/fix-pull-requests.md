---
title: Fix pull requests with an agent
navLabel: Fix and keep green
description: Send an agent to fix failing checks, merge conflicts and review comments on a pull request, or have Talyn keep a pull request mergeable until it merges.
---

A pull request goes red, falls behind its base, or gets review comments. Talyn can send an agent to fix it. The agent works in a sandbox, pushes to the pull request's existing branch, and the pull request goes green in place. No second pull request is opened.

## Fix a pull request now

1. On the **Pull requests** page, hover over the row.
2. Select **Fix**.

In the detail view, the same button is **Fix with agent**.

The agent resolves merge conflicts, fixes failing checks, and handles unresolved review comments. To follow the run step by step, open it from the pull request's row.

If a session is already working on the pull request, Talyn sends the fix to that session's chat instead, so two agents never push to one branch.

If there is nothing to fix, Talyn tells you why: the pull request is closed, a run is already working on it, or it has no conflicts, failing checks or unresolved comments.

### Pick the agent

The run uses the agent set in **Default for new tasks**. Right-click **Fix** to pick a different agent for one run. See [Connect an agent](/docs/connect-agents#pick-the-agent-and-model).

## Keep a pull request green

**Auto-keep mergeable** keeps watching a pull request until it merges. When the branch falls behind, hits a conflict or a check goes red, Talyn sends an agent to fix it.

To turn it on for one pull request:

1. Open the pull request.
2. Select **Auto-keep mergeable**.

The row then shows **Watching**. This works on every plan.

### Keep every new pull request green

To turn it on for every pull request you open from now on, select **Keep new PRs green** at the top of the **Pull requests** page. You can also turn on **Auto-keep new PRs mergeable** in **Settings > Pull requests** in the desktop app, or **Settings > Workspace** in the web app.

It applies only to pull requests you opened, never to ones you review. This workspace default needs a paid plan. Some screens in the app still call the paid plan "Unlimited".

### Options

These are next to the workspace default:

- **Label watched PRs**: GitHub labels that Talyn adds to every pull request it watches. Talyn never removes them.
- **Reply to human review comments**: on by default. When it is off, the agent reads review comments from people for context, but does not reply to them or resolve them. It always handles comments from bots.

### When it stops

Talyn does not retry for ever:

- After 3 runs in a row that do not make the pull request mergeable, it pauses. The row shows **Paused**, and the detail view shows **Auto-fix paused**.
- If the agent says that only a person can clear what is left, Talyn stands down without spending an attempt. It starts again when what blocks the pull request changes.
- If the only thing in the way is a check that needs a person, such as a visual review waiting for approval, no agent runs. The row shows **Needs human**.
- While a session works on the pull request, Talyn waits for it.
- If your plan has no free box right now, the run waits. The row shows **Waiting**.

## When an agent needs you

Some things an agent should not decide, such as a product question, a credential the sandbox does not have, or a gate your repository says a person must clear. When a run stops for a reason like that, it is marked **Needs you**, with the agent's own explanation. It is not marked as failed. Select **Run again** when you have dealt with it.

## Cost

Each fix runs in a sandbox and uses box-hours from your plan. The model runs on your own Claude or ChatGPT subscription. See [Plans, usage and billing](/docs/billing).
