# Session work

This guide shows how to read and change the work inside a session: the changed files, the diff, the files, the scripts and the previews. It also shows the pull request actions, threads, timing, resize, chat extras, workspace memory, repository settings and setup.

All examples use `$TALYN_TOKEN` and `$SESSION_ID` from the [quickstart](../PUBLIC_API.md#quickstart).

## Sleeping sandboxes

A session's sandbox sleeps when nobody uses it. A request that needs the sandbox wakes it. Waking takes some seconds, and a sandbox that is awake uses your fleet capacity.

These endpoints never wake the sandbox:

- `GET /sessions/{id}/changes`, `diff`, `files` and `files/content` without `live=true`
- `GET /sessions/{id}/scripts` without `live=true`
- `GET /sessions/{id}/scripts/{name}/output`
- `GET /sessions/{id}/previews`
- `GET /sessions/{id}/timing`
- The chat queue and checkpoint lists

These requests wake the sandbox when it sleeps: a read with `live=true`, starting or stopping a script, opening a pull request and restoring a checkpoint.

Without `live=true`, a read of a sleeping sandbox answers from the copy that Talyn stored. If Talyn has no copy, the answer is `409` `snapshot_unavailable`. Then send `live=true`.

While a session moves to a new sandbox (`status: "moving"`), a request that needs the sandbox waits for the move. It waits up to 3 minutes. An archived session has no sandbox. A read of an archived session answers from the stored copy, if there is one. Each other request answers `409` `not_ready`. Restore the session first.

## Changed files

```bash
curl -s https://api.talyn.dev/v1/sessions/$SESSION_ID/changes \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

```json
{
  "object": "session_changes",
  "session_id": "...",
  "files": [{ "path": "src/a.ts", "old_path": null, "status": "modified", "added": 2, "removed": 0, "binary": false }],
  "uncommitted": [],
  "committed": [{ "path": "src/a.ts", "old_path": null, "status": "modified", "added": 2, "removed": 0, "binary": false }],
  "uncommitted_stat": { "added": 0, "removed": 0, "files": 0 },
  "committed_stat": { "added": 2, "removed": 0, "files": 1 },
  "base_sha": "...",
  "head_sha": "...",
  "snapshot_at": "2026-11-02T09:30:00.000Z"
}
```

- `files` has every change against the merge base with the base branch.
- `uncommitted` has the changes that are not committed. Untracked files are in it.
- `committed` has the commits on the branch.

When the sandbox sleeps, the answer is the copy that Talyn stored the last time it read the sandbox. A sleeping sandbox cannot change, so the copy is correct. `snapshot_at` tells you when Talyn made the copy. On a live read, `snapshot_at` is `null`.

Send `live=true` to read the sandbox now. If the sandbox sleeps and Talyn has no copy, the answer is `409` `snapshot_unavailable`. Then send `live=true`.

## Diff and files

| Request | Answer |
| --- | --- |
| `GET /sessions/{id}/diff` | The whole diff as one unified patch. A sleeping sandbox answers from the stored copy, or from GitHub when all the work is pushed. |
| `GET /sessions/{id}/diff?path=src/a.ts` | The diff of one file. |
| `GET /sessions/{id}/diff?scope=uncommitted` | Only the changes that are not committed. `committed` gives only the commits. The default is `combined`. |
| `GET /sessions/{id}/files` | Every path in the checkout, tracked and untracked. Files that git ignores are not in the list. |
| `GET /sessions/{id}/files/content?path=src/a.ts` | One file. `encoding` is `utf8` for text and `base64` for a binary file. A sleeping sandbox answers a changed file from the stored copy, and a file without changes from GitHub at the merge base. |

Each of these answers has `source` and `snapshot_at`. `source` is `live` (read from the sandbox now), `stored` (the copy that Talyn stored) or `github`. `snapshot_at` is `null` on a live read. Send `live=true` to read the sandbox now.

A path must stay inside the repository. A path with `..` or a leading `/` answers `400` `bad_path`. A file over 4 MiB answers `413` `file_too_large`.

The diff has no size limit. A very large diff can take some seconds. Ask for one `path` when you need only one file.

## Scripts

A repository defines its scripts in `.talyn/settings.toml` (or in a Conductor file). There are three kinds:

- `setup` runs when a sandbox starts.
- `run` scripts start the app. A config can name more than one. `run` starts the default one.
- `archive` runs before the session is archived.

```bash
# The scripts that ran, with no wake.
curl -s https://api.talyn.dev/v1/sessions/$SESSION_ID/scripts \
  -H "Authorization: Bearer $TALYN_TOKEN"

# Every script the config defines, with its command. This wakes the sandbox.
curl -s "https://api.talyn.dev/v1/sessions/$SESSION_ID/scripts?live=true" \
  -H "Authorization: Bearer $TALYN_TOKEN"

# Start the default run script.
curl -s -X POST https://api.talyn.dev/v1/sessions/$SESSION_ID/scripts/run/start \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Idempotency-Key: $(uuidgen)"

# Read its output.
curl -s https://api.talyn.dev/v1/sessions/$SESSION_ID/scripts/run/output \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

A script has `status` `running`, `exited` or `not_started`. `exit_code` is set when the script ended by itself. A script that you stopped has `exit_code: null`.

The output endpoint gives the last 64 KiB of the output. Talyn stores it as the script runs, so the read does not wake the sandbox. To follow a script, read the output again every few seconds while `status` is `running`.

Starting a script that runs already answers `409` `script_running`. A name that the config does not define answers `404` `script_not_found`.

## Previews

`GET /sessions/{id}/previews` lists the ports from the repository's preview settings, and each port that has a hosted preview link.

To open a port in a browser, make a link:

```bash
curl -s https://api.talyn.dev/v1/sessions/$SESSION_ID/previews \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "port": 3000 }'
```

```json
{
  "object": "preview_link",
  "session_id": "...",
  "port": 3000,
  "url": "https://<id>-3000.preview.talyn.dev/__talyn/auth?ticket=...",
  "origin": "https://<id>-3000.preview.talyn.dev",
  "expires_at": "2026-11-02T09:40:00.000Z"
}
```

How the link works:

1. Open `url` in a browser before `expires_at` (10 minutes). The link works one time.
2. The preview host gives the browser a cookie for that host only. The cookie lasts 12 hours.
3. Each request to the preview checks the cookie and the access of the token owner. When the owner loses access, the preview stops within 20 seconds.

The link is for a browser. Your script cannot use the token to call the preview host. Treat the link like a password until it expires: the first person who opens it gets the cookie.

The port must be 1024 to 65535. A deployment with no preview domain answers `404` `preview_links_unavailable`.

## Pull request actions

| Request | What it does |
| --- | --- |
| `POST /sessions/{id}/pull_request` | Commits the changes that are not committed, pushes the branch and opens a pull request. Body: `title` (required), `body`, `base`, `draft`, `commit_message`. |
| `POST /sessions/{id}/fix_checks` | Sends the agent a prompt with the failing checks of the linked pull request. |
| `POST /sessions/{id}/resolve_conflicts` | Sends the agent a prompt to merge the base branch and resolve the conflicts. |
| `POST /sessions/{id}/address_review` | Sends the agent a prompt to read and address the unresolved review comments of the linked pull request. |
| `POST /sessions/{id}/merge` | Merges the linked pull request with its merge method. The default is squash. |

`pull_request` answers `201` with the new pull request. When the branch has an open pull request already, Talyn links the session to it and answers `200` with `existing: true`.

`fix_checks`, `resolve_conflicts` and `address_review` answer `202` with an `action_receipt`. The prompt goes to the chat that you name in `chat_id`. Else it goes to the latest chat, or to a new chat. The receipt has the `chat_id`. The message waits behind a running turn. Follow the reply on the events endpoints. A cloud task that works on the same pull request answers `409` `task_active`.

`merge` answers `200` with an `action_receipt`. A session with no linked pull request answers `409` `no_pull_request`. When GitHub refuses the merge, the answer is `409` `merge_failed`.

A thread has no repository. Each of these actions on a thread answers `409` `thread_no_repository`.

`pull_request` and `merge` use the GitHub rate limit of the token owner. Talyn opens and merges the pull request from the owner's GitHub account.

## Threads

A thread is a session with `kind: "thread"`. It has no repository. Its agent starts sessions on repositories.

- `GET /sessions/{id}/sessions` lists the sessions of a thread, newest first. Archived sessions are in the list.
- `POST /sessions/{id}/thread` starts a thread from a session. The first message of the thread recaps the session's chat, and the session joins the thread. The answer is the new thread.

## Timing, resize and readiness

- `GET /sessions/{id}/timing` shows where the turns spent their time: model, tests, installs, builds and the rest.
- `POST /sessions/{id}/resize` moves the work to a sandbox of another size (`small`, `standard`, `medium`, `large`, `xlarge`). When no turn runs, the move starts now (`outcome: "moving"`). Else it starts when the turn ends (`after_turn`). With `continue_with`, the message goes to the chat, and its turn starts on the new sandbox.
- `GET /workspaces/{id}/readiness` tells you whether the workspace can start a session now, and with which agent. Each reason has a `code` and a `message` that you can show to a person.

## Chats

| Request | What it does |
| --- | --- |
| `PATCH /chats/{id}` | Changes `title`, `model`, `effort` or `plan_mode`. `model: null` and `effort: null` go back to the defaults. |
| `POST /chats/{id}/close` | Stops a running turn, empties the queue and closes the chat. The transcript stays. |
| `GET /chats/{id}/queue` | Lists the messages that wait for the running turn. An attachment is not in the answer; `attachment_count` counts them. |
| `DELETE /chats/{id}/queue/{message_id}` | Removes one queued message. |
| `DELETE /chats/{id}/queue` | Removes all queued messages. |
| `GET /chats/{id}/checkpoints` | Lists the checkpoints. Talyn makes one before each turn. |
| `POST /chats/{id}/checkpoints/{turn}/restore` | Puts the files back as they were before the turn. |

A restore does not move the branch or its commits. It changes only the files in the checkout. Talyn saves the current files first, so you can undo a restore by hand in the sandbox. A restore while a turn runs answers `409` `chat_running`.

## Workspace memory

Memory entries are short notes that people and sessions save for later sessions. Each session sees an index of the entries in its scope, and reads an entry when it needs it.

| Field | Values |
| --- | --- |
| `scope` | `workspace` (every session), `repository` (sessions on one repository, with `repository_id`), `thread` (one thread, with `thread_id`) |
| `type` | `user`, `feedback`, `project`, `reference` |
| `name` | At most 64 characters. Unique in its scope; case does not matter. |
| `description` | One line, at most 200 characters. Sessions see it in the index. |
| `body` | At most 8 KiB. |

```bash
curl -s https://api.talyn.dev/v1/memories \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "workspace_id": "'"$WORKSPACE_ID"'",
    "scope": "repository",
    "repository_id": "'"$REPOSITORY_ID"'",
    "type": "project",
    "name": "test-command",
    "description": "How to run the tests",
    "body": "Run npm test in packages/backend. The suite needs Docker."
  }'
```

`POST /memories` answers `201` for a new entry. When a live entry in the same scope has the same name, Talyn updates that entry and answers `200`.

`DELETE /memories/{id}` forgets the entry. Sessions stop seeing it, but it stays with `forgotten_at` set. `POST /memories/{id}/restore` brings it back. A workspace holds at most 500 live entries.

Lists are newest first and use [cursors](pagination.md). Bodies are in a list only with `include_body=true`. Forgotten entries are in a list only with `include_forgotten=true`. Use `q` to search the name, the description and the body.

The memory endpoints need the `memory:read` or `memory:write` scope. They also need sessions to be on for your account.

## Repository settings

| Request | What it does |
| --- | --- |
| `GET /repositories/{id}/settings` | The sandbox size, the preview and setup learning for new sessions. |
| `PATCH /repositories/{id}/settings` | Changes `sandbox_size`, `preview` (`target`, `ports`, `coder`) or `setup_learning`. |
| `GET /repositories/{id}/instructions` | The instructions written in Talyn. Every turn of every session on the repository gets them. |
| `PUT /repositories/{id}/instructions` | Replaces the instructions. Body: `body` (Markdown, at most 64 KiB) and `agents` (`claude`, `codex` or `both`). |
| `DELETE /repositories/{id}/instructions` | Deletes the instructions. Answers `204`. |
| `GET /repositories/{id}/setup_recipe` | Deprecated. Use `GET /repositories/{id}/setup`. The setup steps that Talyn learned, in the old shape. |
| `POST /repositories/{id}/setup_recipe/steps/{step_id}/revert` | Deprecated. Use the `dismiss` endpoint below. It dismisses the step. |

A settings read does not ask GitHub. The `detected` values are what Talyn read from the repository last time. `sandbox_size: "auto"` goes back to the detected size.

## Setup

The Setup list is the repository's own setup command, then one ordered list of setup steps. Each step has `run_on`:

- `image`: the step goes into the repository's image.
- `box`: the step runs on each new sandbox.
- `both`: the step goes into the image and runs again on each sandbox.

A step has `origin` `user` (a person wrote it), `learned` (Talyn learned it from a session) or `agent` (an agent recorded it). Its `status` is `active`, `suggested`, `dismissed` or `disabled`. A learned step is `suggested` until a person or the frequency rule accepts it.

| Request | What it does |
| --- | --- |
| `GET /repositories/{id}/setup` | The Setup list. |
| `PUT /repositories/{id}/setup` | Changes `steps`, `run_on_box`, `hosts` or `learning`. Send only the fields to change. |
| `POST /repositories/{id}/setup/steps/{step_id}/accept` | Accepts a suggested or dismissed learned step. Talyn never removes a step that a person accepted. |
| `POST /repositories/{id}/setup/steps/{step_id}/dismiss` | Dismisses a learned step. It stops and stays in the list, so Talyn does not suggest it again. |
| `POST /repositories/{id}/setup/steps/{step_id}/retry` | Runs a disabled step again, or puts a step that failed in the image build back into the image. |
| `GET /workspaces/{id}/sandbox_setup` | The dotfiles and setup steps of the workspace. They go into the image of each repository of the workspace, before the repository's steps. |
| `PUT /workspaces/{id}/sandbox_setup` | Replaces each field that you send: `dotfiles`, `hosts` or `steps`. |
| `POST /workspaces/{id}/sandbox_setup/steps/{step_id}/retry` | Runs a disabled workspace step again, or puts it back into the image. |

In `PUT /repositories/{id}/setup`, `steps` is the whole list in its new order. A step with no `id` is a new step of your own. Talyn deletes your own step when it is not in the list. A learned step that is not in the list keeps its status and goes last. To remove a learned step, dismiss it.

The rules for a write:

- A step that reads a secret runs only on the sandbox.
- A command that holds a literal token answers `400` `setup_step_refused`.
- The command of a learned step cannot change. A change answers `400` `learned_command`.
- A dismiss of your own step answers `409` `not_learned`. Remove it from the list instead.
- The dotfiles install command cannot read a secret, because the image build has no secrets.
- A refused write changes nothing.

The workspace sandbox setup changes the sandboxes of each repository of the workspace. Thus `PUT` needs `repositories:write`.

The repository settings and setup endpoints also need sessions to be on for your account. If they are not, the answer is `403` `workbenches_unavailable`. `GET /repositories/{id}` does not need sessions.

## A TypeScript example

Wait for the agent to finish a turn, then read the changes and open a pull request.

```ts
const BASE = "https://api.talyn.dev/v1";
const headers = { Authorization: `Bearer ${process.env.TALYN_TOKEN}`, "Content-Type": "application/json" };

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  if (!res.ok) {
    const { error } = await res.json();
    throw new Error(`${res.status} ${error.code}: ${error.message}`);
  }
  return res.json() as Promise<T>;
}

const sessionId = process.env.SESSION_ID!;

const changes = await api<{ files: { path: string; added: number; removed: number }[] }>(
  `/sessions/${sessionId}/changes?live=true`,
);
for (const f of changes.files) console.log(`${f.path} +${f.added} -${f.removed}`);

if (changes.files.length > 0) {
  const pr = await api<{ url: string; existing: boolean }>(`/sessions/${sessionId}/pull_request`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ title: "Make the slowest test faster", draft: true }),
  });
  console.log(pr.existing ? "Linked" : "Opened", pr.url);
}
```
