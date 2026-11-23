---
name: talyn-delegate
description: Use when you must choose between subagents and child sessions. Start separate work, follow children, and understand the box cost.
---

# Delegate work

## Choose the kind of work

Use a subagent for read-only searches, reviews, or independent work on the same branch.
This work must finish within the current turn.
Give each agent separate files when several agents change code.
Claude Agent calls can use `run_in_background: true`.
The turn stays open until these subagents finish.

Use a sub-session when work needs its own branch and pull request, another repository, or time beyond this turn.
Each sub-session has its own box.
It spends box-hours and counts against the concurrent box limit.
Sessions can nest at most 2 levels below the session that a person started.
The box gate applies to every child.

## Start a child

Get the repository id with `talyn_list_repositories`.
Give the child its goal, context, file scope, checks, and expected pull request.
It cannot see this conversation.

```
talyn_create_session
  repository_id: <id>
  agent: claude
  prompt: <complete brief>
  notify_parent: true
```

Use `notify_parent: true` when you need a wake after the child's turn ends.
The default is false: cards appear without a wake.
Parent cards, wakes, child lists, and child controls require the `session-subagents` flag.
Thread notifications keep their existing behavior.
Children inherit the parent's team space when the repository is available there.
The tool reports any fallback to Personal.

## Follow the children

Use `talyn_list_thread_sessions` without arguments to list your children and their status.
It lists thread members when the caller is a thread.
Read work with `talyn_get_session_transcript` and keep its cursor for the next read.
Send instructions or answers with `talyn_send_session_message`.
Use `talyn_get_session_changes` and `talyn_get_session_diff` to check the changes.
Do your own work while children run, or end your turn and wait for the requested wake.
Do not poll with repeated sleeps.

Cancel unwanted work with `talyn_cancel_session_turn`.
Check each diff and its tests before you accept the result.
Report each child's session id, pull request, status, and remaining work.

## Handle limits and failures

If creation fails, read the refusal before you retry.
A depth limit means that you must keep the work here or ask the person to start it.
A box limit means that another box must stop before a new box can start.
If a child needs input, answer its question or ask the person for the missing decision.
