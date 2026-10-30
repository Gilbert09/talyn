---
name: talyn-ship-pr
description: Use when the work in this Talyn session is finished and needs a pull request, or when the person asks to open, update or queue the pull request. Covers commit hygiene, the repository's pull request template, links to the Slack thread and the source session, opening the pull request through Talyn, and adding it to the merge queue only on request.
---

# Ship the pull request

## 0. Check who opens the pull request

Read the instructions for this turn first.
- If they tell you to end the reply with a `talyn-pr` block, Talyn opens the pull request after your reply.
  Do not commit, push or open it yourself. Use steps 1 to 3 below only to write the title and the body.
- Otherwise you open it, with step 4.

Stay on this session's branch. Do not create, rename or switch branches.
One session works on one repository. Its pull request changes only that repository.

## 1. Clean up the commits

```bash
git status
git diff HEAD
git log --oneline origin/BASE..HEAD
```

- Remove debug output, temporary files, logs and build output from the change.
- Never commit secrets, tokens, `.env` files or credentials.
- Do not commit `CLAUDE.local.md` or `AGENTS.override.md`. Talyn writes them for the session.
- Run the tests, the linter and the type checker for the files you changed. Fix what fails.
- Use conventional commit messages: `feat: …`, `fix: …`, `chore: …`, `docs: …`, `refactor: …`, `test: …`.
- Keep one logical change per commit when you can.

Commits in this box are signed when the repository requires it.
A plain `git push` works. The box republishes the commits through GitHub, so GitHub signs them.
Never turn off signing or change the author.

## 2. Use the template

Look for a pull request template. Check these paths, in any letter case:
- `.github/pull_request_template.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/PULL_REQUEST_TEMPLATE/` (any file in it)
- `PULL_REQUEST_TEMPLATE.md`
- `docs/pull_request_template.md`

If there is one, fill in every section and keep its headings. Do not leave placeholder text.
If there is none, write: what changed, why, how you tested it, and what a reviewer must know.

## 3. Add the links

- The Slack thread: a session started from Slack has a line `Slack thread: <url>` in its first message.
  Read it with `talyn_get_session_transcript`, with `session_id` set to your session id (run `echo $TALYN_SESSION_ID`) and `cursor` 0.
- The source session or pull request, when another session or pull request asked for this work.
- Related pull requests in other repositories. See the talyn-multi-repo skill.

Do not post in Slack. Talyn does not post there. The link in the pull request is enough.

Title: a conventional commit summary under 72 characters, for example `fix(api): handle empty pages`.

## 4. Open the pull request

```
talyn_open_session_pull_request
  session_id: <your session id: run `echo $TALYN_SESSION_ID`>
  title: <title>
  body: <body>
  commit_message: <message for any uncommitted changes>
```

- Talyn commits what is uncommitted, pushes the branch and opens the pull request.
- If the branch already has an open pull request, Talyn links it and returns it.
- Set `draft` to true only when the person asked for a draft.
- If it fails, read the error. Fix the cause. Do not open the pull request another way.

To change the body of an open pull request later:

```bash
GH="http://github.$YAS_INTEGRATIONS_DOMAIN"
jq -n --arg body "$(cat body.md)" '{body: $body}' | curl -s -X PATCH -H 'Content-Type: application/json' "$GH/repos/OWNER/REPO/pulls/N" -d @-
```

## 5. The merge queue

Add the pull request to the merge queue only when the person asked for it.

1. Find the Talyn pull request id: call `talyn_list_pull_requests` with `search` set to `owner/name`.
   The first token of the matching line is the id.
2. Queue it:

```
talyn_set_merge_queue
  pull_request_id: <Talyn id>
  enabled: true
```

- Use `talyn_set_merge_queue_stack` for a stack of pull requests, with `include_descendants` true.
- Use `talyn_get_merge_queue_timeline` to see why a queued pull request waits.
- Use `talyn_merge_pull_request` only when the person asked to merge now.

## 6. Report

Give the pull request URL, its title, and the checks state from `talyn_get_pull_request`.
Say whether it is in the merge queue. Say what is left.
