---
name: talyn-multi-repo
description: Use when the task needs a change in a repository other than the one this Talyn session works on, or when you must find which repository owns some code. Finds the repository, starts a Talyn session there with a complete brief, follows it to a pull request, cross-links the pull requests and reports back.
---

# Work across repositories

This session works on one repository. You can push only to that repository.
To change another repository, start a separate Talyn session on it.
The `talyn` MCP server gives you the tools. They act as the person who owns this session.

Rules:
- Start a session only when the task needs a change in that repository.
- One repository per session. Never ask one session to change two repositories.
- Talyn does not post in Slack. Do not try to post there. Report in your reply.
- Never send a message to your own session (`$TALYN_SESSION_ID`).

## 1. Find the repository

Read other repositories through the GitHub REST API. It is already authenticated.
There is no `gh` login and no token in this box. Do not look for one.

```bash
GH="http://github.$YAS_INTEGRATIONS_DOMAIN"
# If YAS_INTEGRATIONS_DOMAIN is empty, use the proxy route instead:
# PROXY=$(git config --get-regexp '^url\..*\.insteadof$' | awk '$2=="https://github.com/" {sub(/^url\./,"",$1); sub(/\/gh\/\.insteadof$/,"",$1); print $1; exit}')
# GH="$PROXY/ghapi"
curl -s "$GH/search/code?q=SYMBOL+org:ORG" | jq -r '.items[] | .repository.full_name + "  " + .path' | sort -u | head -20
curl -s "$GH/search/repositories?q=NAME+org:ORG" | jq -r '.items[].full_name'
curl -s "$GH/repos/OWNER/REPO/contents/PATH" | jq -r '.content' | base64 -d
```

If `jq` is missing, run `sudo apt-get install -y jq`.
Read the code in the candidate repository before you decide. Confirm that it owns the change.

Then get Talyn's id for that repository:

```
talyn_list_repositories
```

Each line is `<repository id>  owner/name  base: <branch>`.
If the repository is not in the list, stop. Tell the person to add it in Talyn.
You cannot add repositories from a session.

## 2. Write the brief

The new session cannot see this conversation. Give it everything it needs in one message:

```
Goal: <one sentence>
Context: <why the change is needed, and what this session changes in OWNER/REPO>
Links: <this session's pull request URL, issues, the Slack thread link if you have one>
Details: <files, functions, API shapes, names and versions that must match>
Acceptance: <the tests to run and the behaviour that proves it is done>
Constraints: <what must not change, for example a public API>
Finish: the work ends in a pull request. Put this link in its description: <your PR URL>.
```

Keep it specific. A vague brief makes a wrong pull request.

## 3. Start the session

```
talyn_create_session
  repository_id: <id from talyn_list_repositories>
  agent: <the same agent as this session, claude or codex>
  prompt: <the brief>
  auto_create_pr: true
```

The first token of the output is the new session id. Write it down.
With `auto_create_pr: true`, Talyn opens the pull request when the work is done.

Limits:
- A session can start at most 3 sessions per hour.
- Sessions nest at most 2 levels below the one a person started.
- If `talyn_create_session` refuses because of a limit, stop. Tell the person. Do not retry in a loop.

## 4. Follow the session

Check it at a calm interval. Do not poll in a tight loop.

```
talyn_get_session
  session_id: <child id>
```

- Wait between checks with one `sleep 120` (two minutes). Do useful work between checks when you can.
- The chat line shows the status: `running`, `idle`, `awaiting_input` or `error`.
- When the chat is `idle`, `awaiting_input` or `error`, read what it said:

```
talyn_get_session_transcript
  session_id: <child id>
  cursor: <the cursor from your last read, or 0>
```

- The last line gives the next `cursor`. Keep it, so you read only new events.
- If it asks a question that you can answer, answer it with `talyn_send_session_message`.
- If only the person can answer, stop and ask the person.
- Stop following after about 60 minutes. Report the state and the session id.

## 5. Send follow-ups

```
talyn_send_session_message
  session_id: <child id>
  text: <one clear instruction with all the context it needs>
```

If a turn is running, the message waits in a queue. It runs when the turn ends.
To stop a turn that goes the wrong way, use `talyn_cancel_session_turn` with the child `session_id`.

## 6. Cross-link the pull requests

`talyn_get_session` shows `pull request: #N ... <url>` when the pull request exists.

- Your own pull request: add the other pull request URL to its description.
  Use `PATCH $GH/repos/OWNER/REPO/pulls/N` with a JSON `body`, or put the link in the body when you open it.
- The other pull request: you cannot write to that repository.
  Ask its session to add your link with `talyn_send_session_message`.
- Read both descriptions again to confirm that each one names the other.

## 7. Report

Tell the person, for each repository:
- the repository and the session id,
- the pull request URL and its state,
- what is still open, and who must act.

Do not archive the other session. The person decides when it is done.
