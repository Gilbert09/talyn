---
title: API endpoint reference
navLabel: Endpoint reference
description: Every endpoint of the Talyn REST API that a token from the app can call, with its scope, parameters and response.
---

This page lists the endpoints you can call with a token you create in **Settings > API tokens**. Paths are relative to `https://api.talyn.dev`. For authentication, errors, rate limits and pagination, read the [API overview](/docs/api).

The machine-readable version is the OpenAPI 3.1 document at [api.talyn.dev/v1/openapi.json](https://api.talyn.dev/v1/openapi.json). It describes every endpoint, field and error response, and you can generate a client from it.

Every request needs the header `Authorization: Bearer talyn_pat_...`. Requests with a body need `Content-Type: application/json`. Ids are strings. Timestamps are ISO 8601 strings in UTC.

On requests that start something, you can send an `Idempotency-Key` header so that a retry runs one time only. See [Retries and idempotency](/docs/api#retries-and-idempotency).

## Meta

### Get the token and its owner

```http
GET /v1/me
```

Any valid token.

Returns the token that made the request: its scopes, its workspace binding and its expiry, and the account it acts for.

Returns `200`: The token and its owner.


## Workspaces

### List workspaces

```http
GET /v1/workspaces
```

Scope: `workspaces:read`.

The workspaces the token can reach, newest first.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `limit` | query | integer | Items per page, 1 to 200. Default 50. |
| `cursor` | query | string | The `next_cursor` of the previous page. Absent for the first page. |

Returns `200`: A page of workspaces.

### Get a workspace

```http
GET /v1/workspaces/{id}
```

Scope: `workspaces:read`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The workspace. See [Workspace](#workspace).

### Get the sandbox setup

```http
GET /v1/workspaces/{id}/sandbox_setup
```

Scope: `repositories:read`.

The workspace's dotfiles and setup steps. They go into the image of every repository of the workspace, before the repository's own steps.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The sandbox setup.

### Write the sandbox setup

```http
PUT /v1/workspaces/{id}/sandbox_setup
```

Scope: `repositories:write`.

Each field you send replaces it. It changes the sandboxes of every repository of the workspace, so it needs `repositories:write`. The dotfiles install command cannot read a secret: the image build has no secrets.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `dotfiles` | object | Null: no dotfiles. |
| `hosts` | array of string |  |
| `steps` | array of object | The whole list in its new order. A step that is not in the list is deleted. |

Returns `200`: The sandbox setup.

### Retry a sandbox setup step

```http
POST /v1/workspaces/{id}/sandbox_setup/steps/{step_id}/retry
```

Scope: `repositories:write`.

Run a disabled workspace step again, or put a step that failed in the image build back into the image.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `step_id` | path | string | The id. |

Returns `200`: The sandbox setup.


## Repositories

### List repositories

```http
GET /v1/repositories
```

Scope: `repositories:read`.

The repositories a workspace watches, newest first.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | query | string | Required unless the token is bound to exactly one workspace. |
| `limit` | query | integer | Items per page, 1 to 200. Default 50. |
| `cursor` | query | string | The `next_cursor` of the previous page. Absent for the first page. |

Returns `200`: A page of repositories.

### Get a repository

```http
GET /v1/repositories/{id}
```

Scope: `repositories:read`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The repository. See [Repository](#repository).

### Get repository settings

```http
GET /v1/repositories/{id}/settings
```

Scope: `repositories:read`.

The sandbox size, the preview and setup learning for new sessions on the repository. The detected values are what Talyn last read from the repository; this request does not read GitHub.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The settings.

### Update repository settings

```http
PATCH /v1/repositories/{id}/settings
```

Scope: `repositories:write`.

Send only the fields to change. `sandbox_size: "auto"` goes back to the detected size. Inside `preview`, each field you send replaces your choice for that field.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `sandbox_size` | `auto` \| `small` \| `standard` \| `medium` \| `large` \| `xlarge` |  |
| `preview` | object |  |
| `setup_learning` | boolean |  |

Returns `200`: The settings.

### Get repository instructions

```http
GET /v1/repositories/{id}/instructions
```

Scope: `repositories:read`.

The instructions written in Talyn for the repository. Every turn of every session on the repository gets them. No instructions answers 404 `repository_instructions_not_found`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The instructions.

### Write repository instructions

```http
PUT /v1/repositories/{id}/instructions
```

Scope: `repositories:write`.

Replaces the instructions. The next turn of each session gets the new text. At most 64 KiB.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `body` (required) | string | Markdown, at most 65536 bytes of UTF-8. |
| `agents` (required) | `claude` \| `codex` \| `both` |  |

Returns `200`: The instructions.

### Delete repository instructions

```http
DELETE /v1/repositories/{id}/instructions
```

Scope: `repositories:write`.

The next turn of each session takes the instructions out of its sandbox. Deleting twice changes nothing.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `204`: Deleted.

### Get the Setup list

```http
GET /v1/repositories/{id}/setup
```

Scope: `repositories:read`.

The repository's own setup, then one ordered list of setup steps. Image steps go into the repository's image. Box steps run on each new sandbox. Learned steps are suggested until a person or the frequency rule accepts them.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The Setup list.

### Write the Setup list

```http
PUT /v1/repositories/{id}/setup
```

Scope: `repositories:write`.

Send only the fields to change. `steps` is the whole list in its new order. A step that reads a secret runs only on the box. A command that holds a literal token is refused (`setup_step_refused`). The command of a learned step cannot change (`learned_command`). A refusal changes nothing.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `steps` | array of object | The whole list in its new order. Your own step that is not in the list is deleted. A learned step that is not in the list keeps its status and goes last: to remove it, dismiss it. |
| `run_on_box` | `always` \| `moved` \| `never` |  |
| `hosts` | array of string |  |
| `learning` | boolean |  |

Returns `200`: The Setup list.

### Accept a setup step

```http
POST /v1/repositories/{id}/setup/steps/{step_id}/accept
```

Scope: `repositories:write`.

Accept a suggested or dismissed learned step. It runs on new sandboxes, and an image step goes into the image. Talyn never removes a step that a person accepted.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `step_id` | path | string | The id. |

Returns `200`: The Setup list.

### Dismiss a setup step

```http
POST /v1/repositories/{id}/setup/steps/{step_id}/dismiss
```

Scope: `repositories:write`.

Dismiss a learned step. It stops running and stays in the list as dismissed, so Talyn does not suggest it again. Your own step cannot be dismissed (409 `not_learned`): remove it from the list instead.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `step_id` | path | string | The id. |

Returns `200`: The Setup list.

### Retry a setup step

```http
POST /v1/repositories/{id}/setup/steps/{step_id}/retry
```

Scope: `repositories:write`.

Run a disabled step again, or put a step that failed in the image build back into the image. The failure count goes back to 0.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `step_id` | path | string | The id. |

Returns `200`: The Setup list.

### Get the setup recipe

```http
GET /v1/repositories/{id}/setup_recipe
```

Scope: `repositories:read`.

Deprecated: use `GET /repositories/{id}/setup`. This route goes after one release. The setup steps Talyn learned from sessions on the repository, in the old shape.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The recipe.

### Revert a setup step

```http
POST /v1/repositories/{id}/setup_recipe/steps/{step_id}/revert
```

Scope: `repositories:write`.

Deprecated: use `POST /repositories/{id}/setup/steps/{step_id}/dismiss`. This route goes after one release. It dismisses the step. The step stays in the list as reverted, so Talyn does not learn it again.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `step_id` | path | string | The id. |

Returns `200`: The recipe.


## Sessions

### List sessions

```http
GET /v1/sessions
```

Scope: `sessions:read`.

Sessions in a workspace, newest first. Archived sessions only when asked for.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | query | string | Required unless the token is bound to exactly one workspace. |
| `status` | query | string | Comma-separated statuses: provisioning, ready, moving, error, archived, archive_error. |
| `kind` | query | string | Comma-separated kinds. Default `session`. |
| `include_archived` | query | boolean | Include archived sessions. Default false; asking for status `archived` turns it on. |
| `limit` | query | integer | Items per page, 1 to 200. Default 50. |
| `cursor` | query | string | The `next_cursor` of the previous page. Absent for the first page. |

Returns `200`: A page of sessions. Chats are not embedded in lists.

### Start a session

```http
POST /v1/sessions
```

Scope: `sessions:write`.

Creates a sandbox session on a repository (or a thread, with `kind: "thread"`) and starts provisioning. With a `prompt`, the agent starts on it when the sandbox is ready. Counts against the plan like a session started in the app.

| Body field | Type | Description |
| --- | --- | --- |
| `workspace_id` | string | Required unless the token is bound to exactly one workspace. |
| `kind` | `session` \| `thread` | Default `session`. A thread takes no repository or branch. |
| `repository_id` | string | Required for a session. |
| `agent` (required) | `claude` \| `codex` |  |
| `model` | string | max length 200 |
| `prompt` | string | The first message. The agent starts on it when the sandbox is ready. |
| `name` | string | Lowercase letters, digits and hyphens. Default: made from the prompt. |
| `base_branch` | string | max length 250 |
| `branch` | string | An existing branch to work on. Default: a new branch. |
| `pull_request_id` | string | Start from this pull request's head branch and link the session to it. |
| `thread_id` | string | Put the new session in this thread. |
| `internet_access` | boolean |  |
| `auto_create_pr` | boolean |  |

Returns `201`: The new session. `status` is `provisioning`. See [Session](#session).

### Get a session

```http
GET /v1/sessions/{id}
```

Scope: `sessions:read`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The session, with its open chats. See [Session](#session).

### Archive a session

```http
POST /v1/sessions/{id}/archive
```

Scope: `sessions:write`.

Stops a running turn, saves the work and stops the sandbox. The answer comes before the sandbox has stopped.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The session. See [Session](#session).

### Restore an archived session

```http
POST /v1/sessions/{id}/restore
```

Scope: `sessions:write`.

Starts a new sandbox from the saved work. Waits up to a minute for an archive that is still running to finish.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The session. See [Session](#session).

### Retry a session that failed or is stuck while it starts

```http
POST /v1/sessions/{id}/retry
```

Scope: `sessions:write`.

Provisions again on a new sandbox after `status: "error"`, or while `status` is `provisioning` and the start is stuck. Refused while the account still cannot run a sandbox.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The session. See [Session](#session).

### Stream session changes

```http
GET /v1/sessions/{id}/stream
```

Scope: `sessions:read`.

Server-sent events: `session.updated` when the session changes, `chat.updated` when one of its chats changes, and `end` when the session is deleted. Frames have no ids: on reconnect, read the session again. A comment line (`: ping`) every 15 seconds keeps the connection open.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: A `text/event-stream`.

### Check whether sessions can start

```http
GET /v1/workspaces/{id}/readiness
```

Scope: `sessions:read`.

Whether this workspace can start a sandbox session now, and with which agents. Each reason has a `code` and a message to show. Answers even when sessions are not available for the account: that is the reason `flag_off`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The readiness.


## Chats

### Open a new chat in a session

```http
POST /v1/sessions/{id}/chats
```

Scope: `sessions:write`.

A new agent conversation on the same sandbox and branch. Send it a message to start a turn.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `title` | string | max length 200 |
| `model` | string | max length 200 |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` |  |
| `plan_mode` | boolean |  |

Returns `201`: The new chat. See [Chat](#chat).

### Get a chat

```http
GET /v1/chats/{id}
```

Scope: `sessions:read`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The chat. See [Chat](#chat).

### Update a chat

```http
PATCH /v1/chats/{id}
```

Scope: `sessions:write`.

Rename the chat, or change the model, effort or plan mode its next turns use. Send only the fields to change.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `title` | string | max length 200 |
| `model` | string | Null: the session's model. |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` |  |
| `plan_mode` | boolean |  |

Returns `200`: The chat. See [Chat](#chat).

### Send a message

```http
POST /v1/chats/{id}/messages
```

Scope: `sessions:write`.

Starts a turn, or queues the message behind the running turn. While the session is still provisioning, the message waits for the sandbox. Follow the reply on the events endpoints.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `text` (required) | string | max length 100000 |
| `model` | string | For this turn only. |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | For this turn only. |
| `plan_mode` | boolean |  |

Returns `202`: The message is accepted. See [MessageReceipt](#messagereceipt).

### Stop the running turn

```http
POST /v1/chats/{id}/cancel
```

Scope: `sessions:write`.

Stops the agent. The transcript so far stays. Messages queued behind the turn start after it.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The chat. See [Chat](#chat).

### Close a chat

```http
POST /v1/chats/{id}/close
```

Scope: `sessions:write`.

Stops a running turn, empties the queue and closes the chat. The transcript stays readable. Closing a closed chat changes nothing.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The chat, with `closed_at` set. See [Chat](#chat).

### List queued messages

```http
GET /v1/chats/{id}/queue
```

Scope: `sessions:read`.

Messages that wait for the running turn to end, oldest first. They start one by one after it.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The queue. Never paged.

### Clear the queue

```http
DELETE /v1/chats/{id}/queue
```

Scope: `sessions:write`.

Removes every queued message. A running turn goes on.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The chat. `queued_message_count` is 0. See [Chat](#chat).

### Remove a queued message

```http
DELETE /v1/chats/{id}/queue/{message_id}
```

Scope: `sessions:write`.

A message that already started, or that is not in the queue, answers 404 `queued_message_not_found`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `message_id` | path | string | The id. |

Returns `200`: The chat. See [Chat](#chat).

### List checkpoints

```http
GET /v1/chats/{id}/checkpoints
```

Scope: `sessions:read`.

One per turn: the files as they were before that turn. Oldest first.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The checkpoints. Never paged.

### Restore a checkpoint

```http
POST /v1/chats/{id}/checkpoints/{turn}/restore
```

Scope: `sessions:write`.

Puts the files back as they were before the turn. Talyn saves the current files first, so the restore can be undone by hand. The branch and its commits do not move. A running turn answers 409 `chat_running`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `turn` | path | integer | The id. |

Returns `200`: The chat. See [Chat](#chat).


## Events

### Read a transcript page

```http
GET /v1/chats/{id}/events
```

Scope: `sessions:read`.

Forward with `after` (oldest first; poll with the returned `last_seq`), or backward with `before` (`latest`, or a `seq`), which returns whole turns. Poll no more than once a second; to follow a running turn, use the stream.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `after` | query | integer | Events with a greater `seq`, oldest first. Default 0. |
| `before` | query | string | `latest` for the newest page, or a `seq` for the page before it. Returned oldest first, whole turns only. |
| `limit` | query | integer | Events per page, 1 to 2000. Default 500. |

Returns `200`: A page of events.

### Stream a transcript

```http
GET /v1/chats/{id}/events/stream
```

Scope: `sessions:read`.

Server-sent events. Each `transcript` frame is one event, with `id:` set to its `seq`. On connect the stream sends the stored events after `after` (or after the `Last-Event-ID` header), then new events as they arrive. `chat` frames carry the chat when its status changes. An `end` frame closes the stream when the chat is closed or the session is archived or deleted. A comment line (`: ping`) every 15 seconds keeps the connection open.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `after` | query | integer | Start after this `seq`. The `Last-Event-ID` header wins when both are sent. |

Returns `200`: A `text/event-stream`.


## Pull requests

### Start a session on a pull request

```http
POST /v1/pull-requests/{id}/sessions
```

Scope: `sessions:write`.

Starts a sandbox session on the pull request's head branch and links it to the pull request. The same as `POST /sessions` with `pull_request_id`. Send a `prompt` to tell the agent what to do, for example to fix the failing checks.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `agent` (required) | `claude` \| `codex` |  |
| `model` | string | max length 200 |
| `prompt` | string | The first message. The agent starts on it when the sandbox is ready. |
| `name` | string | Lowercase letters, digits and hyphens. Default: made from the prompt. |
| `internet_access` | boolean |  |

Returns `201`: The new session. `status` is `provisioning`. See [Session](#session).


## Session work

### List changed files

```http
GET /v1/sessions/{id}/changes
```

Scope: `sessions:read`.

The files the session changed, with line counts. A sleeping sandbox answers from the copy Talyn stored when it last read the sandbox, and `snapshot_at` says when that was. Send `live=true` to read the sandbox now; that wakes it. A sleeping sandbox with no stored copy answers 409 `snapshot_unavailable`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `live` | query | boolean | Read the sandbox now, and wake it if it sleeps. Default false: a sleeping sandbox answers from its stored copy. |

Returns `200`: The changed files.

### Read the diff

```http
GET /v1/sessions/{id}/diff
```

Scope: `sessions:read`.

A unified diff of the whole session, or of one file with `path`. A sleeping sandbox answers from the copy Talyn stored, or from GitHub when all the work is pushed; `source` says which. With neither, it answers 409 `snapshot_unavailable`. Send `live=true` to read the sandbox now; that wakes it.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `path` | query | string | One file only. Default: every changed file. |
| `scope` | query | `combined` \| `uncommitted` \| `committed` | `combined` (default): everything against the merge base. `uncommitted`: against HEAD. `committed`: merge base to HEAD. |
| `live` | query | boolean | Read the sandbox now, and wake it if it sleeps. Default false: a sleeping sandbox answers from the copy Talyn stored, or answers 409 `snapshot_unavailable` when there is none. |

Returns `200`: The diff.

### List files

```http
GET /v1/sessions/{id}/files
```

Scope: `sessions:read`.

Every file in the repository checkout, tracked and untracked. Files that git ignores are left out. A sleeping sandbox answers from the copy Talyn stored, or 409 `snapshot_unavailable`. Send `live=true` to wake it.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `live` | query | boolean | Read the sandbox now, and wake it if it sleeps. Default false: a sleeping sandbox answers from the copy Talyn stored, or answers 409 `snapshot_unavailable` when there is none. |

Returns `200`: The paths.

### Read a file

```http
GET /v1/sessions/{id}/files/content
```

Scope: `sessions:read`.

One file as it is in the sandbox now. Text comes back as UTF-8, a binary file as base64. A file over 4 MiB answers 413 `file_too_large`. A sleeping sandbox answers a changed file from the copy Talyn stored, and a file the session did not change from GitHub at the merge base; `source` says which. With neither, it answers 409 `snapshot_unavailable`. Send `live=true` to read the sandbox now; that wakes it.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `path` (required) | query | string | Relative to the repository root. |
| `live` | query | boolean | Read the sandbox now, and wake it if it sleeps. Default false: a sleeping sandbox answers from the copy Talyn stored, or answers 409 `snapshot_unavailable` when there is none. |

Returns `200`: The file.

### List scripts

```http
GET /v1/sessions/{id}/scripts
```

Scope: `sessions:read`.

The setup, run and archive scripts of the session and their state. By default only the scripts that have run, with no wake. With `live=true`, also every script the config defines (`.talyn/settings.toml` or Conductor), with its command; that wakes the sandbox.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `live` | query | boolean | Also read the session's config from the sandbox, and wake it if it sleeps, to list every script it defines with its command. Default false: only the scripts that have run. |

Returns `200`: The scripts. Never paged.

### Start a script

```http
POST /v1/sessions/{id}/scripts/{name}/start
```

Scope: `sessions:write`.

Starts `setup`, `run` (the default run script), `archive`, or a named run script. Answers when the script has started. A script that is already running answers 409 `script_running`. Wakes the sandbox.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `name` | path | string | The script name. `run` starts the default run script. |

Returns `200`: The script.

### Stop a script

```http
POST /v1/sessions/{id}/scripts/{name}/stop
```

Scope: `sessions:write`.

Stops the script in the sandbox. Stopping a script that does not run changes nothing.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `name` | path | string | The script name. `run` starts the default run script. |

Returns `200`: The script.

### Read a script's output

```http
GET /v1/sessions/{id}/scripts/{name}/output
```

Scope: `sessions:read`.

The end of what the script wrote, at most 64 KiB, from what Talyn stored. Does not wake the sandbox. Poll it while `status` is `running`. A script that has not run answers `not_started` with no output.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `name` | path | string | The script name. `run` starts the default run script. |

Returns `200`: The output.

### Open a pull request

```http
POST /v1/sessions/{id}/pull_request
```

Scope: `sessions:write`.

Commits what is not committed, pushes the branch and opens a pull request on GitHub from the token owner's account. When a pull request from the branch is already open, the session is linked to it and `existing` is true. Uses your GitHub rate limit.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `title` (required) | string | max length 256 |
| `body` | string | max length 65536 |
| `base` | string | Default: the session's base branch. |
| `draft` | boolean |  |
| `commit_message` | string | For the commit of uncommitted changes. Default: the title. |

Returns `200`: A pull request was already open; the session is linked to it.

Returns `201`: The pull request is open.

### Ask the agent to fix failing checks

```http
POST /v1/sessions/{id}/fix_checks
```

Scope: `sessions:write`.

Sends the agent the app's fix-checks prompt with the failing checks of the linked pull request. The message queues behind a running turn. A cloud task that works on the same pull request answers 409 `task_active`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `chat_id` | string | The chat that gets the prompt. Default: the latest chat, or a new one. |

Returns `202`: The prompt is sent.

### Ask the agent to resolve conflicts

```http
POST /v1/sessions/{id}/resolve_conflicts
```

Scope: `sessions:write`.

Sends the agent the app's prompt to merge the base branch and resolve the conflicts. The message queues behind a running turn. A cloud task that works on the same pull request answers 409 `task_active`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `chat_id` | string | The chat that gets the prompt. Default: the latest chat, or a new one. |

Returns `202`: The prompt is sent.

### Ask the agent to address review comments

```http
POST /v1/sessions/{id}/address_review
```

Scope: `sessions:write`.

Sends the agent the app's prompt to read and address the unresolved review comments of the linked pull request. The message queues behind a running turn. A cloud task that works on the same pull request answers 409 `task_active`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `chat_id` | string | The chat that gets the prompt. Default: the latest chat, or a new one. |

Returns `202`: The prompt is sent.

### Merge the session's pull request

```http
POST /v1/sessions/{id}/merge
```

Scope: `sessions:write`.

Merges the linked pull request on GitHub with its merge method (squash by default). No linked pull request answers 409 `no_pull_request`; a refusal from GitHub answers 409 `merge_failed`. Uses your GitHub rate limit.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The pull request is merged.

### Get where the time went

```http
GET /v1/sessions/{id}/timing
```

Scope: `sessions:read`.

Where the session's turns spent their time: model, tests, installs, builds and the rest. Read from stored turn reports.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The timing summary.

### Move the session to another sandbox size

```http
POST /v1/sessions/{id}/resize
```

Scope: `sessions:write`.

Moves the work to a sandbox of the new size when no turn runs, else after the running turn. With `continue_with`, the message goes to the chat and its turn starts on the new sandbox.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `size` (required) | `small` \| `standard` \| `medium` \| `large` \| `xlarge` |  |
| `reason` | string | Why, in one sentence. The transcript shows it. |
| `remember_for_repository` | boolean | Also use this size for new sessions on the repository. |
| `continue_with` | string | A message for the chat. The next turn starts on the new sandbox. |

Returns `200`: What happens next.


## Threads

### List a thread's sessions

```http
GET /v1/sessions/{id}/sessions
```

Scope: `sessions:read`.

The sessions a thread started, newest first, archived ones included. A session that is not a thread answers 409 `not_thread`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `limit` | query | integer | Items per page, 1 to 200. Default 50. |
| `cursor` | query | string | The `next_cursor` of the previous page. Absent for the first page. |

Returns `200`: A page of sessions.

### Continue a session as a thread

```http
POST /v1/sessions/{id}/thread
```

Scope: `sessions:write`.

Starts a thread whose first message recaps the session's chat. The session joins the thread. Counts against the plan like a session started in the app.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `agent` | `claude` \| `codex` | Default: the session's agent. |
| `model` | string | max length 200 |
| `prompt` | string | Sent after the recap of the session's chat. |

Returns `201`: The new thread. `kind` is `thread`. See [Session](#session).


## Objects

### Workspace

| Field | Type | Description |
| --- | --- | --- |
| `object` | `workspace` |  |
| `id` | string |  |
| `name` | string |  |
| `created_at` | string |  |
| `updated_at` | string |  |

### Repository

| Field | Type | Description |
| --- | --- | --- |
| `object` | `repository` |  |
| `id` | string |  |
| `workspace_id` | string |  |
| `full_name` | string |  |
| `url` | string |  |
| `default_branch` | string |  |
| `created_at` | string |  |

### Session

| Field | Type | Description |
| --- | --- | --- |
| `object` | `session` |  |
| `id` | string |  |
| `workspace_id` | string |  |
| `kind` | `session` \| `thread` |  |
| `thread_id` | string | The thread this session belongs to, if any. |
| `repository_id` | string | Null for a thread. |
| `repository_full_name` | string |  |
| `name` | string |  |
| `title` | string |  |
| `branch` | string | Null for a thread. |
| `base_branch` | string |  |
| `runtime` | `sandbox` \| `local` | A `local` session runs in the desktop app. The API lists it read-only; actions on it answer 409 `local_runtime`. |
| `agent` | `claude` \| `codex` |  |
| `model` | string |  |
| `status` | `provisioning` \| `ready` \| `moving` \| `error` \| `archived` \| `archive_error` |  |
| `status_message` | string |  |
| `pull_request_id` | string |  |
| `internet_access` | boolean | Null: the workspace default. |
| `auto_create_pr` | boolean | Null: the workspace default. |
| `diff_stat` | object | Null until a diff has been computed once. |
| `archived_at` | string |  |
| `created_at` | string |  |
| `updated_at` | string |  |
| `chats` | array of object | The open chats, oldest first. On single-session responses only. |

### Chat

| Field | Type | Description |
| --- | --- | --- |
| `object` | `chat` |  |
| `id` | string |  |
| `session_id` | string |  |
| `title` | string |  |
| `agent` | `claude` \| `codex` |  |
| `model` | string |  |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` |  |
| `plan_mode` | boolean |  |
| `status` | `idle` \| `running` \| `awaiting_input` \| `error` |  |
| `status_message` | string |  |
| `turn_count` | integer |  |
| `queued_message_count` | integer | Messages waiting for the running turn to end. |
| `closed_at` | string |  |
| `created_at` | string |  |
| `updated_at` | string |  |

### Event

| Field | Type | Description |
| --- | --- | --- |
| `object` | `event` |  |
| `chat_id` | string |  |
| `seq` | integer | Position in the chat. Gap-free and increasing. |
| `turn` | integer |  |
| `type` | string |  |
| `data` | object | The agent event, in Claude Code's stream-json format. Codex output is converted to the same format. New fields can appear. |

### MessageReceipt

| Field | Type | Description |
| --- | --- | --- |
| `object` | `message_receipt` |  |
| `chat_id` | string |  |
| `queued` | boolean | True: the message waits behind a running turn or for the sandbox. False: the turn started now. |

