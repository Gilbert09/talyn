---
name: talyn-thread
description: Use when you run in a Talyn thread, a conversation with no repository. Explains how to plan work across repositories, how to brief and start a session on each repository with talyn_create_session, why to end your turn instead of polling (Talyn wakes you when a session finishes, opens a pull request or needs an answer), how to review and report the results, and how to save decisions to thread memory.
---

# Run a thread

A thread is a Talyn conversation that is not tied to one repository. Its
sandbox has no clone. You can read every repository of the workspace, but you
do not change code here. Sessions do that.
Talyn does not post in Slack. Do not try to post there. Report in your reply.

A session is a separate agent with its own sandbox, repository and branch.
It cannot see this thread. It sees only the brief you give it.

## 1. Plan

Before you start sessions, write the plan in your reply:

- the goal, in one or two sentences,
- one line per repository: what changes there and why,
- the order, when one change depends on another (for example, an API before its client),
- what you will check before you report that the work is done.

Find repository ids with `talyn_list_repositories`. When the plan needs
facts, read the code. Do not guess. `git clone --depth 1 https://github.com/OWNER/REPO /tmp/REPO`
works: the box's proxy signs you in. There is no `gh` login and no token in
this box. For search, use the GitHub REST API as the `talyn-multi-repo`
skill shows.

If the request is not clear, ask the person before you start sessions.

## 2. Brief each session

A session knows only its brief. Give it everything:

```
Goal: <one sentence for this repository>
Context: <the larger goal, and why this repository changes>
Scope: <the files and directories it may change>
Details: <names, interfaces, versions and URLs that must match the other repositories>
Acceptance: <the commands to run and what must pass>
Finish: open a pull request. Put <the related pull request URLs, if any> in its description.
```

## 3. Start the sessions

For each repository:

```
talyn_create_session
  repository_id: <id>
  agent: <the same agent as this thread, unless the person asked for another>
  prompt: <the brief>
  auto_create_pr: true
```

Talyn links each session to this thread. Write down each session id: it is
the first token of the output.

Limits:
- A thread can start at most 10 sessions per hour.
- Sessions that a session starts are limited too. Keep the tree flat: start the sessions from the thread.
- When `talyn_create_session` refuses for a limit, tell the person. Do not retry in a loop.

Start only the sessions that can run now. When a change must wait for
another, start it after the first one finishes.

## 4. End your turn

After you start the sessions, say what you started and end your turn.

Do not poll. Do not run `sleep`. Talyn writes a message to this thread when a
session finishes a turn, opens a pull request or needs an answer, and that
message starts your next turn.

## 5. When Talyn wakes you

The message names one session. Other sessions may also have changed.

1. List all sessions of this thread with `talyn_list_thread_sessions`.
2. For each session that changed, read its new events with `talyn_get_session_transcript`.
3. Read its pull request diff with `talyn_get_pull_request_diff`, or its changes with `talyn_get_session_diff`.
4. Check the work against the brief and the acceptance commands.
5. If a session went wrong or asked a question, answer it with `talyn_send_session_message`.
6. Start the sessions that were waiting for this one.

## 6. Report

When every session is done, report to the person:

- one line per session: the repository, the session id, the pull request URL and its state,
- what is left, and who must act,
- the order to merge in, when it matters.

Add pull requests to the merge queue only when the person asked.

## 7. Save decisions

Save a decision that later turns of this thread must know with
`talyn_memory_write`. From a thread, an entry has the scope `thread` unless
you pass `scope: workspace`. Use the `talyn-memory` skill for what to save.
