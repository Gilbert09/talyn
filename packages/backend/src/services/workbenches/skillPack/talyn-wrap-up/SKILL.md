---
name: talyn-wrap-up
description: Use at the end of the work in this Talyn session, when the person says the work is done, asks for a summary, or asks to close or archive the session, or when its pull request has merged. Summarises what changed and what is left, then archives this session after the reply only when the person asked or the work is merged; otherwise it leaves the session open.
---

# Wrap up the session

## 1. Collect the facts

Your session id is in `$TALYN_SESSION_ID`. Read it with `echo $TALYN_SESSION_ID`.

```
talyn_get_session
  session_id: <your session id>
```

This shows the branch, the diff size, the pull request and its checks.
Then check the working tree:

```bash
git status --short
git log --oneline origin/BASE..HEAD
```

- If there are uncommitted changes that belong to the work, ship them first. Use the talyn-ship-pr skill.
- If there are uncommitted changes that do not belong, say so. Do not delete them without asking.

If there is a pull request, get its state:
1. Call `talyn_list_pull_requests` with `search` set to `owner/name` and `state` set to `all`.
2. Call `talyn_get_pull_request` with the Talyn id from the first token of the matching line.

If this session started other sessions, check each one with `talyn_get_session`.

## 2. Write the summary

Write a short summary in your reply. Use these headings:

- Done: what changed, in 2 to 5 points. Name the files or areas.
- Pull request: the URL, its state (open, merged, closed), the checks state, and the merge queue state.
- Related: other sessions and pull requests, with their URLs and states.
- Left: what is not done, what failed, and the questions for a person.
- Next: the one next action, and who must do it.

Keep it factual. Do not claim a push, a merge or a green check that you did not see.
Talyn does not post in Slack. The person reads the summary in Talyn.

## 3. Decide: archive or leave open

Archive this session only when one of these is true:
- the person asked you to archive or close it, or
- its pull request is merged and nothing is left to do.

Leave it open when:
- the pull request is open, or checks or reviews still need work,
- there is a question for a person,
- there are uncommitted changes,
- you are not sure.

Do not archive other sessions unless the person asked. Archive a child session that you started only when its work is merged or no longer needed.

## 4. Archive after the reply

```
talyn_archive_session
  session_id: <your session id>
```

- For your own session, Talyn archives it after this reply ends. It does not stop the reply.
- Call it as the last action. Then finish the reply at once. Do not start more work.
- Say in the reply that the session will be archived, and that the person can restore it in Talyn.

## 5. Stop

After the summary, stop. Do not start new work in a wrap-up turn.
