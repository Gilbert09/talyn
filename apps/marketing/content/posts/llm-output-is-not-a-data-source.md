---
title: "LLM output is not a data source"
description: "A coding agent told us which pull request it had opened. It was telling the truth, and we read the answer out of the wrong place."
date: "2026-09-18"
draft: true
tags: ["agents", "reliability"]
---

Every system that runs a language model eventually needs a fact back out of it.
Which file did you change. Which ticket is this. Which pull request did you
open. The model knows, it says so in its final message, and the message is
right there in the response body. So you read it out of the text.

This is the bug. Not a mistake in how you parse the text — the decision to
parse it at all.

## The failure

We run coding agents that fix pull requests. An agent finishes, pushes a
branch, opens a PR, and writes a closing message saying what it did. Our job
afterwards is to record which PR the run produced, so the task links to it.

The first implementation serialised the whole run record and took the first
GitHub PR URL it found:

```js
const url = JSON.stringify(run).match(/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0]
```

That ran for weeks. Then a scheduled job — the same prompt, every morning —
started filing its results against a pull request that had been merged the
previous day.

Nothing had broken. The regex worked. The agent worked. What changed was the
input: the prompt for that job mentioned a PR by URL, as context. The serialised
blob contained the user's prompt, the agent's reasoning, its closing summary and
the API's own metadata. All four can contain a PR URL, and only one of them
contains *the* PR URL. The match returned whichever came first in a JSON
key order nobody had chosen deliberately.

## Why the obvious fixes are wrong

**Match more carefully.** Anchor the regex to the closing message, or to a
sentence starting "I opened". This narrows the failure without removing it: the
agent's prose is still prose, and an agent that writes "this supersedes
`/pull/412`" will still be read as having opened 412. You are negotiating with
natural language about a fact that was never ambiguous to the system that
produced it.

**Take the last match instead of the first.** This is worse, because it works.
It will pass every test you write, because the tests encode the same intuition
that produced the bug, and it will fail the first time an agent signs off with a
link to the issue it closed.

**Use the branch.** We tried this. `run.branch` is a real structured field, it
is usually right, and it is catastrophic when it is wrong: a run that pushed
nothing reports the default branch, so a failed run claims every open PR against
`main`.

## What actually fixes it

Ask the system that opened the pull request.

Both of the platforms we run on report it as a field, because it is a fact they
own rather than a claim the model makes. One calls it `output.pr_url`. The other
hangs it off the sandbox record as `sandbox.prUrl`. Read the field, and treat
its absence as absence:

```js
const prUrl = run.output?.pr_url ?? run.sandbox?.prUrl ?? null
```

No fallback to scraping. That was the part that took an argument to settle,
because a fallback looks free — you only reach it when the structured field is
missing, and surely a guess beats nothing?

It does not. A missing link renders as nothing, and a person looking at a task
with no PR attached can see that the link is missing and go and find it. A wrong
link renders exactly like a right one. It reads as a fact, it is clickable, and
the only way to discover it is wrong is to click it and recognise the contents —
which nobody does, because why would you check a link that says it is the answer.

**Silence is a state your interface can express. A confident wrong answer is
not.**

## The general rule

A language model's prose is a rendering of its state for a human reader. It is
not a serialisation format, even when it looks like one, and it is least
trustworthy exactly where it is most useful — when it is discussing the same
kind of entity you are trying to extract.

So: if you need a fact from a model, give it somewhere to put the fact. A tool
call, a structured output schema, a sentinel line with an exact prefix that
nothing else may emit. Then read that place and only that place. If the fact
is not there, you do not have it.

The version of this we could not avoid is instructive. We needed agents to
report a refusal — "a human has to approve this, I am standing down" — and
neither platform has a field for that, because it is our concept and not theirs.
So the agent emits a sentinel on the last line of its final message, we parse
only the last non-empty line, and we require an exact prefix. An agent that
*discusses* the sentinel does not trip it.

And when the sentinel is absent, that does not mean "no refusal". It means we
do not know, which is a third state, and the code says so. The prompt template
is user-overridable; a fork that removes the instruction has to degrade to the
old behaviour rather than silently reporting that every run succeeded.

That is the whole discipline. Structured fields where you can get them. One
exact, unambiguous channel where you cannot. And a real answer for "the fact
is not here" that is never a guess.
