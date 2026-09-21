---
title: "Fixing failing GitHub Actions with an AI agent"
description: "What it actually takes to get a red workflow back to green automatically — where the failure signal comes from, why re-running the job is the wrong reflex, and the four ways an agent gets this wrong."
updated: "2026-09-21"
related: ["claude-code-pull-requests"]
---

A pull request goes red. You open the Actions tab, expand the failing job, scroll
through a few hundred lines of log, find the assertion, and realise it is a
two-line fix in a file you were not thinking about. Twenty minutes, most of it
spent getting to the information rather than acting on it.

That loop is worth automating, and most attempts at automating it fail in the
same few ways. This page is about the mechanism — what the failure signal
actually is, what an agent needs in order to act on it, and the specific
mistakes that make an automated fix worse than no fix.

## Where the failure signal comes from

GitHub does not have one "CI status". It has two related APIs and it matters
which one you are reading.

**Check runs** are the modern one. A GitHub App — including GitHub Actions
itself — creates a check run against a commit SHA, updates it while the job
executes, and closes it with a `conclusion`: `success`, `failure`,
`cancelled`, `timed_out`, `action_required`, `neutral`, or `skipped`. Several
check runs group into a **check suite**, one per app per commit.

**Commit statuses** are the older one, a flat `state` of `pending`, `success`,
`failure` or `error` against a SHA, with a context string. Plenty of third-party
CI still posts these.

Two consequences fall out of that, and both bite naive implementations:

**Status is attached to a commit, not to a pull request.** A PR "being red" is
shorthand for "the check runs against the current head commit include a
failure". Push a new commit and you have a new head with no checks at all
yet — not green, not red, *absent*. Any automation that treats missing checks as
passing will merge things it should not.

**The events arrive continuously and out of order.** A `check_run` webhook fires
on `created`, on `rerequested`, and on `completed`. A busy repository emits
these constantly — dozens per commit across a matrix — and they are the firehose
in any PR-tracking system. If you are polling the REST API instead, you are both
slower and burning rate limit for the privilege.

## Why "just re-run the job" is the wrong default

The single most common piece of CI automation is a bot that re-runs failed jobs.
It is popular because it works often enough to feel productive, and it is a bad
default for a reason worth stating plainly:

**A re-run is a coin flip you are paying for.** If the failure is a genuine
regression, the re-run costs you a full CI cycle and tells you nothing you did
not know. If it is a flake, the re-run hides a real defect in your test suite
that will now surface for somebody else, at random, later. Either way the
information content is close to zero, and you have trained yourself to press a
button instead of reading a log.

The useful version of this is the opposite reflex: read the log, find the
failing assertion, and decide whether the code or the test is wrong. That is
slow for a human because most of the cost is navigation. It is fast for an
agent, because navigation is free for something that can grep a log.

## What an agent actually needs

Four things, and missing any one of them produces a confident wrong answer.

**1. The failing job's own log, for the current head.** Not a summary, not a
status badge, and emphatically not a comment somebody left on the PR earlier —
including a comment the agent itself wrote on a previous run. CI configuration
moves. A verdict that was correct on Tuesday can be wrong on Thursday, and an
agent that trusts its own stale note will cheerfully re-assert a fixed problem.
Re-derive from the live log, every time.

**2. The workflow definition.** The log tells you what failed; the workflow file
tells you what was supposed to happen — which runner, which Node version, which
services, what was cached. A surprising share of CI failures are environmental
and are invisible from the log alone.

**3. The ability to run the suite.** An agent that can read but not execute is
guessing. It needs a sandbox with the repository checked out and the toolchain
installed, so a proposed fix can be tested before it becomes a commit.

**4. Push access to the existing branch.** This one is a product decision, not a
technical one, and it is the difference between useful and annoying: the fix
belongs as a commit on the branch that is failing. An agent that opens a *second*
pull request to fix the first one has doubled your review load and solved
nothing.

## The four ways this goes wrong

Having watched a lot of these runs, the failure modes are consistent.

**Declaring the failure "pre-existing".** The agent looks at a red check, decides
the breakage is repo-wide or somebody else's, and stops. Sometimes true, and it
is the single most common way an agent talks itself out of work. The fix is to
make it prove the claim: quote the finding from the log, name the file, and show
that the pull request neither adds nor edits that file. If the finding points at
a file the PR touches, it is the PR's to fix.

**Treating a flake as a pass.** A test fails, the agent re-runs it, it passes,
the agent moves on. Re-running once to *confirm* flakiness is reasonable. Filing
it as fixed is not — the correct outcome is a note on the PR saying the test is
flaky, and an attempt at the root cause.

**Bypassing the check.** `--no-verify`, skipping a required check, marking
something `continue-on-error`, deleting the assertion. Every one of these turns
a red PR green while making the codebase worse. An agent with commit access will
find these shortcuts unless it is told not to, because they are locally optimal
and they satisfy the stated goal.

**Widening the scope.** The agent goes to fix a failing test and returns with a
refactor. Now the review is not about the CI fix, and your reviewer has to
untangle which changes were load-bearing.

## How Talyn does it

Talyn watches your pull requests through GitHub webhooks, so a failing check
shows up as a red PR in a list rather than as a notification you have to go
looking for. Hit **Fix this PR** and it dispatches a coding agent into a
disposable sandbox with the repository, the workflow files, and push access to
that branch.

The instructions the agent gets are opinionated about all four failure modes
above: read the failing job's own log for the current head and treat earlier
status comments as not-evidence; prove any "pre-existing" claim against that log
before standing down; confirm a flake by re-running once but still attempt the
root cause and note it on the PR; never bypass a check — no `--no-verify`, no
skipping required checks. The fix is published as a commit on the existing
branch, and you watch the whole thing stream live rather than waiting for a
verdict.

Two things worth knowing. The prompt is a workspace setting, so if your repo has
conventions the default does not know about, you edit it rather than working
around it. And agents run on the Claude or ChatGPT subscription you already pay
for, inside a per-task virtual machine where your credentials are attached from
outside the sandbox — the machine running agent-generated code never holds your
tokens, and it is destroyed when the task ends.

If you would rather not press the button each time, a **workflow** can do it on
the `checks failed` event for every matching pull request in a repo, including
ones you did not open.
