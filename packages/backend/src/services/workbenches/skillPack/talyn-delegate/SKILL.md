---
name: talyn-delegate
description: Use when a large task in a Talyn session splits into independent parts that can run at the same time, for example the same change in several packages or a refactor plus separate test work. Explains when to split work into child sessions, how to brief each one, the limits, how to monitor them and how to merge the results. Do not use it for small or tightly coupled work.
---

# Delegate work to child sessions

A child session is a separate Talyn session with its own sandbox and branch.
It runs at the same time as you. It cannot see this conversation.

## Decide first

Delegate only when all of these are true:
- The work splits into parts that do not touch the same files.
- Each part can be tested alone.
- Each part takes more than about 20 minutes of agent work.
- You can describe each part completely in one message.

Do not delegate when:
- The task is small. Do it yourself. A child costs a sandbox and a quota slot.
- The parts depend on each other step by step.
- The work is in another repository only. Use the talyn-multi-repo skill for that.

## Limits

- A session can start at most 3 sessions per hour.
- Sessions nest at most 2 levels below the one a person started.
- When `talyn_create_session` refuses for a limit, do that part yourself, or tell the person. Do not retry in a loop.
- Use at most 3 children for one task.

## 1. Plan the split

Write the plan in your reply before you start children:
- the parts, with the files each one owns,
- which part you keep,
- how the results come together (separate pull requests, or one branch).

Prefer separate pull requests. Each child gets its own branch.

## 2. Brief each child

Each brief must be complete:

```
Goal: <one sentence for this part only>
Context: <the larger task, and why this part exists>
Scope: <the files and directories this part may change>
Out of scope: <files other parts own; do not touch them>
Details: <names, interfaces and versions that must match the other parts>
Acceptance: <the commands to run and what must pass>
Finish: the work ends in a pull request. Mention <your PR URL or this session> in its description.
```

## 3. Start the children

Get the repository id from `talyn_list_repositories`. Then, for each part:

```
talyn_create_session
  repository_id: <id>
  agent: <the same agent as this session>
  prompt: <the brief>
  auto_create_pr: true
```

Write down each child id. It is the first token of the output.

## 4. Monitor

- Do your own part while the children work.
- Check each child every 2 to 5 minutes with `talyn_get_session` and its `session_id`.
- Use one `sleep 120` between rounds. Do not loop on short sleeps.
- When a chat is `idle`, `awaiting_input` or `error`, read the new events with `talyn_get_session_transcript`.
  Pass the `cursor` from your previous read.
- Answer a child's question with `talyn_send_session_message`.
- To see what a child changed, use `talyn_get_session_changes` and `talyn_get_session_diff`.

## 5. Cancel a child

Cancel when a child goes the wrong way, or when its part is no longer needed:

```
talyn_cancel_session_turn
  session_id: <child id>
```

Then either send a corrected instruction with `talyn_send_session_message`, or archive it with `talyn_archive_session`.
Archive only children that you started, and only when their work is not needed.

## 6. Merge the results

- Read each child's diff before you accept it.
- Check that the parts agree on the shared names and interfaces.
- If the parts must land in order, say so in each pull request description.
- Add pull requests to the merge queue only when the person asked. See the talyn-ship-pr skill.

## 7. Report

Give one line per child: the part, the session id, the pull request URL, and its state.
Say what is left, and who must act.
