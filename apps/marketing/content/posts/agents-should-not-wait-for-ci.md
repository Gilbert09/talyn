---
title: "Your coding agent should not wait for CI"
description: "An agent that waits for CI keeps a whole machine awake to run sleep. We moved the waiting out of the agent and into the part of the system that already knows when CI finishes."
date: "2026-11-11"
draft: false
tags: ["agents", "infrastructure", "cost"]
---

Our own account used most of a month's sandbox allowance in two and a half
days. Nothing was broken. The agents did exactly what we told them to do, and
most of what we told them to do was wait.

The lesson is general. If your agent loop contains a step where the agent waits
for something outside itself, the agent is the wrong thing to do the waiting.

## Where the time went

The runs in question fix pull requests. An agent gets a PR with failing checks
or review comments, works on it in a cloud sandbox, pushes, and keeps going
until the PR is green. Our prompt said this, word for word:

```
After every publish, wait for CI to finish, then re-check all of:
(1) review comments, (2) check status, and (3) mergeability
```

The repository was a large monorepo whose CI takes about 40 minutes. A fix
takes three or four pushes. So we read one transcript from start to end.

The run was awake for 228 minutes. It called `sleep` 19 times, for 3,145
seconds in total. That is 52 minutes of a machine doing nothing, before you
count the time spent in `gh pr checks --watch` and the loops that re-read the
check status. And it was a large sandbox, because the repository is large, so
each of those idle minutes cost twice what a standard one does. Five of these
ran at the same time.

The agent was not wrong. "Wait for CI" was the right instruction for the work.
It was the wrong instruction for the machine.

## Why the obvious fixes are wrong

**Tell the agent to wait more efficiently.** Longer sleeps, fewer polls. This
cuts the noise in the transcript and saves nothing. The sandbox is billed for
being awake, not for being busy, so a long sleep and a short one cost the same
per minute.

**End the run and start a new one when CI finishes.** This stops the bill, and
it throws away everything that made the run useful. The new run has a cold
checkout, installs the dependencies again, and has no memory of why it changed
what it changed. On a monorepo the restart can cost more than the wait.

**Use a smaller sandbox.** A small box is fine for waiting. It is bad for the
part of the run that builds and tests, and that is the part you want to be fast.
You cannot change the size of a running machine for the minutes it is idle.

All three fixes keep the same shape: the agent owns the wait. The fix is to take
the wait away from it.

## What we built

The system that runs the agent already knows when CI finishes. It gets a webhook
for every check on every commit, because it has to show check status in the app.
So the agent does not need to watch CI. It only needs a way to say "wake me when
CI is done for this commit".

That is one line. After each push, the agent runs `git rev-parse HEAD` and ends
its final message with:

```
TALYN_AWAIT_CI: 3f9c2e14b7a0d5c8e61f29b4a7c03d58e9f1b260
```

Then it stops. When we see that line, we suspend the sandbox. The disk, the
checkout and the conversation stay where they are, and the meter stops. The task
shows "Waiting for CI" in the app.

When the checks on that commit settle, we resume the same sandbox and send the
agent one more message with the result. There are four results:

- **Passing.** Re-check the review comments and mergeability, then finish.
- **Failing.** These checks failed, by name. Fix them.
- **Head moved.** Somebody else pushed. Here is the new commit.
- **Timed out.** CI did not finish in three hours. Go and look.

The agent continues in the same checkout with the same context, as if it had
waited. If it pushes again, it emits the line again and goes back to sleep.

## The details that matter

**The sentinel is strict.** We read only the last non-empty line of the final
message, the prefix must match exactly, and the sha must look like a sha. An
agent that writes about the sentinel in its explanation does not trip it. When
the line is missing, the run finishes the normal way, so a custom prompt that
removes the instruction falls back to the old behaviour instead of breaking.

**Wake on the commit, not the pull request.** A result for an old commit is not
a result. If the PR head moves while the agent sleeps, the agent hears that the
head moved and not that CI passed.

**A webhook is not enough on its own.** Webhooks get lost, and a deploy can
restart the process that was listening. A sweep runs every 60 seconds as a
backstop. It catches a settled result that the webhook missed, a PR that was
merged or closed while the agent slept, and the three-hour deadline.

**Only one waker wins.** The webhook and the sweep can both decide to wake the
same task, on two different servers. The wake is a compare-and-set on the task
row, so exactly one of them resumes the sandbox.

**A run that can wait must also be cleaned up.** Before this, every sandbox was
deleted when its first task ended. A sandbox that can be resumed has to survive
the end of a task, which means something must delete it when the run is really
over. Every path that finishes a run now deletes its box, and a run can sleep at
most six times before we finish it anyway.

## The general rule

An agent loop should not contain `sleep`. Anything an agent waits for (CI, a
deploy, a review, a scheduled time) is an event that some part of your system
already receives. Let that part do the waiting, and give the agent one exact way
to ask for it.

It is the same pattern as reading facts out of an agent's output. Do not parse
its prose. Give it one strict channel, read only that channel, and decide what
silence means before you need to.

## The first day

We turned this on for every Talyn account this week. In the first ten hours,
fix runs on our own pull requests parked 19 times across 11 runs. Every park
suspended its sandbox. Eighteen woke up again, 16 to passing checks and two to failing
ones, which the agent went back to work on. One was still asleep when we counted.

Together the runs slept for 430 minutes. The average sleep was 24 minutes and
the longest was 43, which is about one full CI run on that monorepo. Before
this, every one of those minutes was a large machine running `sleep`.
