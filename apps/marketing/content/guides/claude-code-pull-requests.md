---
title: "How to manage multiple Claude Code pull requests"
description: "Running several coding agents at once produces pull requests faster than you can land them. Why they go stale in a predictable order, why updating each branch makes it worse, and what to do instead."
updated: "2026-09-21"
related: ["fix-failing-github-actions-with-ai"]
---

The first time you run three Claude Code sessions in parallel it feels like a
superpower. By the end of the week you have eleven open pull requests, four of
them red, two with conflicts, and one you cannot remember asking for.

The bottleneck moved. It used to be writing the change; now it is landing it.
This page is about why that happens mechanically — it is not a discipline
problem — and what actually fixes it.

## The mechanism: every merge invalidates every other branch

Each agent branches from `main` at some instant. Call it `T₀`. Every one of them
is working against a snapshot of the repository that was accurate when it
started.

The moment the first pull request merges, `main` moves to `T₁`. Every other open
branch is now based on a parent that is no longer the tip. Nothing broke, and
nothing is wrong with those branches yet — but each one has entered a race it
did not know it was in.

With **N** open agent branches, merging them all means **N** mutations of `main`,
and after each one the remaining branches are one more commit behind. This is
not specific to agents. It is ordinary distributed-version-control arithmetic,
and it is why long-lived branches have always been a bad idea. What agents change
is the constant: a team of three humans opens maybe three PRs a day, and a
developer running three agents opens three PRs an hour.

When a branch falls behind, it lands in one of three states, and they need
different responses:

**Behind, but clean.** No textual conflict. `git merge-base` is old, the diff
still applies. Harmless until your branch protection requires branches be up to
date, at which point it blocks the merge and needs a rebase and a full CI run.

**Conflicted.** Two branches edited the same region. Someone — or something —
has to make a judgement about intent. This is the only one of the three that
genuinely needs a brain.

**Semantically broken.** The nastiest, because it is invisible. No conflict, both
diffs apply, and the result does not work: one agent renamed a function, another
added a caller. Git is perfectly happy. Your test suite is not, and you only find
out after you have merged and CI runs against the combination.

That third state is the real argument against just letting them pile up. A
conflict announces itself. A semantic break does not.

## Why "Update branch" on each PR makes it worse

The obvious move is to keep everything current: hit **Update branch** on all
eleven, let CI re-run, merge whatever is green.

Two problems, and the second is the one that gets people.

**It costs N full CI runs to gain nothing durable.** Updating eleven branches
means eleven pipelines. If your suite takes fifteen minutes, that is nearly three
hours of compute to move every branch to a base that is about to change again.

**The first merge re-stales the other ten.** You updated all eleven against `T₁`.
You merge one. `main` is now `T₂`, and the other ten are behind again. Repeat
until done, and you have paid O(N²) CI runs to land N pull requests. Anyone who
has tried this on a busy afternoon has felt exactly this loop.

The insight worth keeping: **you do not want N branches simultaneously current.
You want them to become current one at a time, in an order, just before each one
merges.** Keeping a branch up to date is only valuable in the moment before it
lands.

## What actually works

**Serialise the merges, not the work.** The agents can run in parallel — that is
the point. Merging is where the order has to exist. Pick a sequence, land the
first, rebase only the next one, land it, continue. Each branch pays for exactly
one update, at the moment it is worth something.

**Only touch what conflicts.** If two branches are genuinely independent — no
overlapping files, no shared symbols — they do not need serialising against each
other at all, and forcing them into a single queue is throughput you have thrown
away. GitHub's own merge queue batches for this reason; the lesson generalises.

**Let the failures be fixed, not just reported.** This is where agent-generated
PRs differ from human ones. A human whose PR goes red comes back to it. An agent
finished its session, has no memory of the work, and will not be returning. If
nothing fixes a red agent PR, it sits there until you do it yourself — and the
whole point was not to do it yourself.

**Decide what you actually want merged.** Worth saying because volume makes this
worse: eleven open PRs include some you should close. An agent that wrote
something you do not want has cost you nothing if you close it in ten seconds,
and quite a lot if you keep it warm for a fortnight.

## How Talyn does it

Talyn puts every pull request across every connected repository in one list,
sorted by what needs you, with check status, review state and merge state on
each row — so the eleven are a list you can act on rather than eleven browser
tabs.

For the rest:

- **Flag a PR "keep mergeable"** and Talyn watches it. The moment it falls behind
  `main`, hits a conflict, or goes red, it dispatches a coding agent to fix it
  and push to the existing branch. No second pull request.
- **The merge queue** lands your ready PRs in order the second they are green,
  rebasing and clearing conflicts on the way, and drains independent PRs
  concurrently rather than forcing everything through one lane.
- **Agents run on the Claude subscription you already pay for.** The same plan
  that produced the pull requests can land them, with no metered API bill on
  top. Each task runs in its own short-lived virtual machine, with credentials
  attached from outside it, so the machine running agent-generated code never
  holds your tokens.

The free plan covers three tasks running at once and three PRs in the queue,
which is roughly the point at which this stops being a manual problem.

Worth being straight about the limits: Talyn cannot tell you whether a change
was a good idea, and a semantically-broken merge still needs a test suite that
would catch it. What it removes is the part that is pure tax — the rebasing, the
re-running, the checking back.
