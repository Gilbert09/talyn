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

<div class="my-8 grid gap-3 sm:grid-cols-3">
<div class="rounded-xl border border-line bg-paper-50 p-4"><p class="font-display !text-3xl font-semibold text-ink">228 min</p><p class="mt-1 !text-sm leading-snug text-ink-500">one fix run kept its sandbox awake</p></div>
<div class="rounded-xl border border-line bg-paper-50 p-4"><p class="font-display !text-3xl font-semibold text-ink">52 min</p><p class="mt-1 !text-sm leading-snug text-ink-500">of that run was spent in <code>sleep</code></p></div>
<div class="rounded-xl border border-line bg-paper-50 p-4"><p class="font-display !text-3xl font-semibold text-clay">430 min</p><p class="mt-1 !text-sm leading-snug text-ink-500">asleep and not billed, on the first day of the fix</p></div>
</div>

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

<figure>
<div class="overflow-x-auto rounded-xl border border-line bg-paper-50 p-4">
<svg viewBox="0 0 560 228" class="min-w-[520px]" role="img" aria-labelledby="ciwait-t ciwait-d" font-family="ui-sans-serif, system-ui, sans-serif">
<title id="ciwait-t">One fix run, before and after</title>
<desc id="ciwait-d">Before, the sandbox stays awake while CI runs after each push. After, the sandbox is suspended while CI runs, and only the working time is awake.</desc>
<text x="0" y="16" font-size="13" font-weight="600" fill="#23201b">Before: the agent waits</text>
<rect x="0" y="26" width="58" height="34" rx="5" fill="#c25e3a"/>
<rect x="60" y="26" width="108" height="34" rx="5" fill="#e7ded1"/>
<rect x="170" y="26" width="48" height="34" rx="5" fill="#c25e3a"/>
<rect x="220" y="26" width="108" height="34" rx="5" fill="#e7ded1"/>
<rect x="330" y="26" width="40" height="34" rx="5" fill="#c25e3a"/>
<rect x="372" y="26" width="108" height="34" rx="5" fill="#e7ded1"/>
<rect x="482" y="26" width="78" height="34" rx="5" fill="#c25e3a"/>
<text x="114" y="48" font-size="12" text-anchor="middle" fill="#5c554a">sleep, poll</text>
<text x="274" y="48" font-size="12" text-anchor="middle" fill="#5c554a">sleep, poll</text>
<text x="426" y="48" font-size="12" text-anchor="middle" fill="#5c554a">sleep, poll</text>
<text x="0" y="84" font-size="12" fill="#7a7264">Sandbox awake and billed from start to end.</text>
<text x="0" y="122" font-size="13" font-weight="600" fill="#23201b">After: the system waits</text>
<rect x="0" y="132" width="58" height="34" rx="5" fill="#c25e3a"/>
<rect x="60.5" y="132.5" width="107" height="33" rx="5" fill="none" stroke="#dbd1c2" stroke-dasharray="4 3"/>
<rect x="170" y="132" width="48" height="34" rx="5" fill="#c25e3a"/>
<rect x="220.5" y="132.5" width="107" height="33" rx="5" fill="none" stroke="#dbd1c2" stroke-dasharray="4 3"/>
<rect x="330" y="132" width="40" height="34" rx="5" fill="#c25e3a"/>
<rect x="372.5" y="132.5" width="107" height="33" rx="5" fill="none" stroke="#dbd1c2" stroke-dasharray="4 3"/>
<rect x="482" y="132" width="78" height="34" rx="5" fill="#c25e3a"/>
<text x="114" y="154" font-size="12" text-anchor="middle" fill="#9a9183">suspended</text>
<text x="274" y="154" font-size="12" text-anchor="middle" fill="#9a9183">suspended</text>
<text x="426" y="154" font-size="12" text-anchor="middle" fill="#9a9183">suspended</text>
<text x="0" y="190" font-size="12" fill="#7a7264">Awake only while the agent works. A check webhook wakes it.</text>
<rect x="0" y="206" width="12" height="12" rx="2" fill="#c25e3a"/>
<text x="18" y="216" font-size="12" fill="#5c554a">agent working</text>
<rect x="120" y="206" width="12" height="12" rx="2" fill="#e7ded1"/>
<text x="138" y="216" font-size="12" fill="#5c554a">waiting for CI, awake</text>
<rect x="290.5" y="206.5" width="11" height="11" rx="2" fill="none" stroke="#9a9183" stroke-dasharray="3 2"/>
<text x="308" y="216" font-size="12" fill="#5c554a">waiting for CI, suspended</text>
</svg>
</div>
<figcaption>One fix run with three pushes. A schematic, not to scale.</figcaption>
</figure>

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
