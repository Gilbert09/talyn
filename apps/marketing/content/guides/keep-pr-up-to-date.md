---
title: "Automatically keeping a GitHub pull request mergeable"
description: "\"Up to date\" and \"mergeable\" are different states, reported by different API fields, and fixed by different things. What a watcher has to get right before you let it spend money on your behalf."
navLabel: "Keep a PR mergeable"
updated: "2026-09-21"
related: ["claude-code-pull-requests", "github-merge-queue-alternative"]
---

You approve a pull request on Tuesday. On Thursday it will not merge. Something
landed in between, and now the branch is behind, or conflicted, or a required
check has gone red for a reason that has nothing to do with the change.

Automating that away is an obvious idea and a surprisingly easy one to get
wrong, because the thing being automated is less uniform than it looks. This
page is about the states a pull request can actually be in, how GitHub reports
them, and what a watcher has to get right before you let it spend money
unattended.

## "Up to date" and "mergeable" are not the same thing

GitHub answers this in two separate fields, and conflating them is the first
mistake.

**`mergeable`** is a three-state value: `MERGEABLE`, `CONFLICTING`, or
`UNKNOWN`. It answers one question — does this diff still apply? — and nothing
else.

**`mergeStateStatus`** is the fuller picture: `CLEAN`, `BEHIND`, `BLOCKED`,
`DIRTY`, `UNSTABLE`, `DRAFT`, `HAS_HOOKS`, `UNKNOWN`.

So a branch can be perfectly `MERGEABLE` and still refuse to merge, because
`mergeStateStatus` is `BEHIND` and the base branch requires branches be up to
date. That branch protection setting is precisely what turns "behind" from a
cosmetic fact into a blocker. Nothing is broken; you are just not allowed
through until you update and re-run CI.

Four distinct situations hide under "it won't merge", and they want different
responses:

| State | What happened | What fixes it |
|---|---|---|
| Behind | Base moved, no conflict | One API call — merge base into head |
| Conflicting | Two branches touched the same lines | Judgement |
| Required check failing | CI is red | A code change |
| Changes requested | A reviewer asked for something | A code change, or a reply |

Only the first is free. Treating all four as one thing is how automation becomes
expensive.

## Two traps in the API

**`UNKNOWN` is not a state, it is a pending computation.** GitHub calculates
mergeability lazily. The first request after anything that invalidates it — a
push to the head, or a push to the *base* — answers `UNKNOWN` and starts a
background job. The answer is usually ready a second or two later.

Any automation that reads `UNKNOWN` as "not mergeable" is acting on a value
GitHub has not computed yet. The fix is small and has to be deliberate: re-ask
after a short backoff, a couple of times, and if it is still `UNKNOWN`, keep it
as unknown rather than guessing. Do that *off* the hot path — resolving it
inline turns every webhook into a blocking retry loop.

**`BLOCKED` is ambiguous, and dangerously so.** GitHub reports
`mergeStateStatus: BLOCKED` both when a required check has *failed* and when
required checks simply have not *finished*. Those are opposite situations and
you cannot tell them apart from that field alone. You need the check
breakdown — specifically how many are still in progress — to know whether you
are looking at a failure or at a pipeline that is merely still running.

Get this wrong and your automation fires an expensive fix run three seconds
after a PR is opened, against a problem that does not exist yet.

## Why retry counts are the wrong instrument

Say the watcher fires a fix run, the run finishes, and the PR is still not
mergeable. Do you try again?

The obvious design is a counter: allow three attempts, then stop. It is wrong in
both directions — three is too many when the agent is stuck on something it
cannot move, and too few when each attempt is making real progress through a
stack of independent failures.

The better question is not *how many times have we tried* but **did the last
attempt change anything**. Record a signature of what is blocking the PR after
each run: the blocking reason, the mergeable state, the review decision, the
number of failing checks and — critically — *which* checks are failing. A
signature not seen before on this commit means the attempt moved the problem, so
continue. A signature already recorded means the attempt failed at exactly what
it failed at last time, so stop.

That "which checks" part is load-bearing. A count alone reads four failing
before and four failing after — identical — whether the run fixed nothing or
fixed one check and uncovered another. Calling the second case "no progress" is
precisely the judgement a retry budget gets wrong.

Two things must *not* go into the signature: the total check count and the
in-progress count. Both move on their own as a CI run registers and completes
jobs, so including them manufactures fake progress out of a pull request that
has not changed at all.

## A refusal is not a failure

The case people miss: sometimes the agent is right to stop. A merge gate only a
human can clear, a credential the sandbox does not have, a product decision
nobody delegated. That is a *refusal*, and it needs recording differently from a
crash — if it lands as a generic failure it is indistinguishable from the agent
falling over, and you will debug the wrong thing.

It also must not spend an attempt. An attempt budget measures "have we tried
enough times"; a refusal is not a try that failed, it is an answer. Count it and
you will spend the remaining budget re-learning what the first run already told
you.

The re-arm rule for a refusal is the same signature test: try again only when
the blocker set has genuinely changed. An unchanged signature means nothing has
moved since the agent said it was stuck.

## How Talyn does it

Flag a pull request **keep mergeable** and Talyn watches it on a one-minute
loop. When it needs work, Talyn dispatches a coding agent to fix it and push to
the existing branch — no second pull request.

What counts as needing work, precisely: merge conflicts, a failing **required**
check, changes requested by a reviewer, or unresolved review threads left by
bots. A non-required check going red does not trigger an unattended paid run,
because it would not have blocked the merge either.

One thing worth being straight about, given this page's URL: **"behind the base
branch" is deliberately not on that list.** Being behind is a one-API-call fix,
not agent work, so Talyn handles it in the merge queue rather than in this
watcher — a PR you have *queued* gets its branch updated server-side and waits
for CI to re-run; a PR you have merely flagged does not. If keeping up with
`main` is the thing you actually want, the queue is the feature, not this one.

The rest follows the reasoning above. Three consecutive unsuccessful runs and it
pauses rather than looping. The counter resets the moment the PR reads clean. An
agent that stands down for a human burns no attempt and will not re-arm until
the blockers genuinely change. Runs happen in a per-task virtual machine on the
Claude or ChatGPT subscription you already pay for, with credentials attached
from outside the sandbox.

Flagging individual pull requests is free. Turning it on as the default for
every new PR in a workspace is an Unlimited feature — and a workspace that
already had it on keeps it.
