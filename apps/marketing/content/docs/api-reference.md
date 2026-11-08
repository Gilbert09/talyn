---
title: API endpoint reference
navLabel: Endpoint reference
description: Every endpoint of the Talyn REST API, with its scope, parameters and response.
---

This page lists every endpoint of the API. Paths are relative to `https://api.talyn.dev`. For authentication, errors, rate limits and pagination, read the [API overview](/docs/api).

The machine-readable version is the OpenAPI 3.1 document at [api.talyn.dev/v1/openapi.json](https://api.talyn.dev/v1/openapi.json). It describes every endpoint, field and error response, and you can generate a client from it.

Every request needs the header `Authorization: Bearer talyn_pat_...`. Requests with a body need `Content-Type: application/json`. Ids are strings. Timestamps are ISO 8601 strings in UTC.

On requests that start something, you can send an `Idempotency-Key` header so that a retry runs one time only. See [Retries and idempotency](/docs/api#retries-and-idempotency).

Each endpoint names the scope it needs. You create a token in **Settings > API tokens**. The token form does not offer the pull request, code review, memory and webhook scopes yet. See [Scopes](/docs/api#scopes).

## Meta

### Get the token and its owner

```http
GET /v1/me
```

Any valid token.

Returns the token that made the request: its scopes, its workspace binding and its expiry, and the account it acts for.

Any valid token.

Returns `200`: The token and its owner.

### Get this OpenAPI document

```http
GET /v1/openapi.json
```

No token needed.

Returns `200`: The OpenAPI 3.1 document of `/v1`.


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

Returns `200`: A page of workspaces. Each item is a [Workspace](#workspace).

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


## Teams

Teams and spaces are not yet available to all accounts. If the `spaces` feature is off for your account, these endpoints return `403` with the code `spaces_unavailable`.

### List teams

```http
GET /v1/teams
```

Scope: `teams:read`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `limit` | query | integer | Items per page, 1 to 200. Default 50. |
| `cursor` | query | string | The `next_cursor` of the previous page. Absent for the first page. |

Returns `200`: Teams you belong to. Each item is a [Team](#team).


## Spaces

Spaces are not yet available to all accounts. If the `spaces` feature is off for your account, these endpoints return `403` with the code `spaces_unavailable`. To start a session in a space, send `space_id` to [Start a session](#start-a-session). That needs the `spaces:write` scope.

### List spaces

```http
GET /v1/spaces
```

Scope: `spaces:read`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `team_id` | query | string | Only the spaces of this team. |
| `limit` | query | integer | Items per page, 1 to 200. Default 50. |
| `cursor` | query | string | The `next_cursor` of the previous page. Absent for the first page. |

Returns `200`: Live spaces in your teams. Each item is a [Space](#space).

### List sessions in a space

```http
GET /v1/spaces/{id}/sessions
```

Scope: `spaces:read`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `limit` | query | integer | Items per page, 1 to 200. Default 50. |
| `cursor` | query | string | The `next_cursor` of the previous page. Absent for the first page. |

Returns `200`: Visible sessions and the count hidden by repository access. Each item is a [Session](#session) without `chats`, plus `creator_github_login`, the GitHub login of the person who started it. `hidden_count` is the number of sessions on this page that you cannot see, because you have no access to their repository.


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

Returns `200`: A page of repositories. Each item is a [Repository](#repository).

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

Returns `200`: A page of sessions. Chats are not embedded in lists. Each item is a [Session](#session).

### Start a session

```http
POST /v1/sessions
```

Scope: `sessions:write`.

Creates a sandbox session on a repository (or a thread, with `kind: "thread"`) and starts provisioning. With a `prompt`, the agent starts on it when the sandbox is ready. Counts against the plan like a session started in the app.

| Body field | Type | Description |
| --- | --- | --- |
| `workspace_id` | string | Required unless space_id is set or the token is bound to one workspace. |
| `space_id` | string | Start in this space. Requires spaces:write and uses your home workspace. |
| `repository_full_name` | string | Repository owner/name in the space. Use when no repository_id exists in your workspaces. |
| `kind` | `session` \| `thread` | Default `session`. A thread takes no repository or branch. |
| `repository_id` | string | Required for a session unless space_id and repository_full_name are set. |
| `agent` (required) | `claude` \| `codex` |  |
| `model` | string | max length 200 |
| `prompt` | string | The first message. The agent starts on it when the sandbox is ready. |
| `name` | string | Lowercase letters, digits and hyphens. Default: made from the prompt. A name that a live session uses gets `-2`, `-3` and so on; read `name` in the response. |
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

Rename the chat, switch its agent, or change the model, effort or plan mode its next turns use. Send only the fields to change.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `title` | string | max length 200 |
| `agent` | `claude` \| `codex` | Stops a running turn, then continues the chat with this agent. |
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

### List preview ports

```http
GET /v1/sessions/{id}/previews
```

Scope: `sessions:read`.

The ports the repository's preview settings name, and every port that has a hosted preview link. Does not wake the sandbox. To open one, make a link with POST /sessions/{id}/previews.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The preview ports. Never paged.

### Make a preview link

```http
POST /v1/sessions/{id}/previews
```

Scope: `sessions:write`.

A one-time sign-in link to a port of the sandbox on its own host. Open `url` in a browser within 10 minutes. The browser then gets a cookie for that host that lasts 12 hours. The link works once. Answers 404 `preview_links_unavailable` when this deployment has no preview domain.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `port` (required) | integer |  |

Returns `201`: The link.

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

Returns `200`: A page of sessions. Each item is a [Session](#session).

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


## Pull requests

These endpoints read and change the pull requests that Talyn tracks. Most of them need the `pull_requests:read` or `pull_requests:write` scope. The token form in the app does not offer these scopes yet. For what Talyn does with pull requests, read [Pull requests](/docs/pull-requests).

### List pull requests

```http
GET /v1/pull-requests
```

Scope: `pull_requests:read`.

The pull requests Talyn tracks in a workspace, newest tracked first. Default: open ones. The data is what Talyn last read from GitHub; `last_synced_at` says when.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | query | string | Required unless the token is bound to exactly one workspace. |
| `state` | query | `open` \| `closed` \| `merged` \| `all` | Default `open`. |
| `relationship` | query | `authored` \| `review_requested` \| `watching` | `authored` is the "Mine" bucket, `review_requested` the "Review" bucket. Default: all. |
| `repository_id` | query | string |  |
| `merge_queued` | query | boolean | Only pull requests in (true) or not in (false) the merge queue. |
| `limit` | query | integer | Items per page, 1 to 200. Default 50. |
| `cursor` | query | string | The `next_cursor` of the previous page. Absent for the first page. |

Returns `200`: A page of pull requests. Each item is a [PullRequest](#pullrequest).

### Get a pull request

```http
GET /v1/pull-requests/{id}
```

Scope: `pull_requests:read`.

With its live sessions and its latest code review. Reads no data from GitHub: use `POST /pull-requests/{id}/refresh` for that.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The pull request. See [PullRequest](#pullrequest).

### Update a pull request

```http
PATCH /v1/pull-requests/{id}
```

Scope: `pull_requests:write`.

`auto_keep_mergeable: true` makes Talyn start a fix when the pull request stops being mergeable (conflicts, failing checks), for as long as it stays open. Each fix counts against the plan like any other run.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `auto_keep_mergeable` | boolean |  |

Returns `200`: The pull request. See [PullRequest](#pullrequest).

### Get the description of a pull request

```http
GET /v1/pull-requests/{id}/description
```

Scope: `pull_requests:read`.

The description as Talyn last read it from GitHub.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The description.

### Read a pull request from GitHub again

```http
POST /v1/pull-requests/{id}/refresh
```

Scope: `pull_requests:write`.

Fetches the pull request from GitHub now and stores it. A pull request that is no longer open gets its closed or merged state. Uses your GitHub rate limit, so it has its own, lower limit (see rate limits). Answers 409 `cannot_refresh` when GitHub does not have it.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The pull request, as GitHub has it now. See [PullRequest](#pullrequest).

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
| `name` | string | Lowercase letters, digits and hyphens. Default: made from the prompt. A name that a live session uses gets `-2`, `-3` and so on; read `name` in the response. |
| `internet_access` | boolean |  |

Returns `201`: The new session. `status` is `provisioning`. See [Session](#session).


## Merge queue

These endpoints need the `pull_requests:read` or `pull_requests:write` scope. The token form in the app does not offer these scopes yet. For how the queue works, read [Merge queue](/docs/merge-queue).

### List the merge queue

```http
GET /v1/merge-queue
```

Scope: `pull_requests:read`.

Every pull request in the merge queue of a workspace, in the order they joined. One page.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | query | string | Required unless the token is bound to exactly one workspace. |

Returns `200`: The queue. Each item is a [MergeQueueEntry](#mergequeueentry).

### Add a pull request to the merge queue

```http
POST /v1/pull-requests/{id}/merge-queue
```

Scope: `pull_requests:write`.

Talyn merges it when it is clean, and starts a fix run when it has conflicts or failing checks. Adding a pull request that is already queued changes only its `method`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `method` | `squash` \| `merge` \| `rebase` | How to merge. Default: the last method used for this pull request, else `squash`. |

Returns `200`: The pull request, with `merge_queue` set. See [PullRequest](#pullrequest).

### Remove a pull request from the merge queue

```http
DELETE /v1/pull-requests/{id}/merge-queue
```

Scope: `pull_requests:write`.

Also turns off the GitHub auto-merge that Talyn armed, if any. A pull request that is not queued answers the same.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The pull request, with `merge_queue: null`. See [PullRequest](#pullrequest).

### Re-submit a parked pull request

```http
POST /v1/pull-requests/{id}/merge-queue/resubmit
```

Scope: `pull_requests:write`.

For a pull request an external merge queue (trunk.io) gave back, after a person dealt with the cause. Resets the budgets and submits it again. 409 `not_queued`, `not_parked` or `no_external_queue` otherwise.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The pull request. See [PullRequest](#pullrequest).

### List the merge-queue history of a pull request

```http
GET /v1/pull-requests/{id}/merge-queue/events
```

Scope: `pull_requests:read`.

What the queue did with the pull request and why: the current entry, or the last one when it is not queued.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The events, newest first.


## Code reviews

These endpoints need the `code_reviews:read` or `code_reviews:write` scope. The token form in the app does not offer these scopes yet. For how a review works, read [Code review](/docs/code-review).

### List the code reviews of a pull request

```http
GET /v1/pull-requests/{id}/code-reviews
```

Scope: `code_reviews:read`.

A pull request has at most one review. Each new review is a new `cycle` of it, and findings carry over between cycles.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The review, if there is one. Without findings. Each item is a [CodeReview](#codereview).

### Start a code review

```http
POST /v1/pull-requests/{id}/code-reviews
```

Scope: `code_reviews:write`.

Starts a new review cycle on the pull request. If a cycle is already running, the answer is that cycle with status 200. Starting a review runs on a box, so the usage gates on box starts apply. 409 `no_reviewers` when the workspace turned Talyn's reviewers off and has none of its own for this repository; 409 `pr_closed` for a pull request that is not open.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `preset` | `quick` \| `standard` \| `deep` | How deep to review. Default: the workspace setting. |
| `reset` | boolean | Throw away the findings on record instead of carrying them forward. |

Returns `200`: A cycle was already running. This is it. See [CodeReview](#codereview).

Returns `201`: The new cycle. See [CodeReview](#codereview).

### Get a code review with its findings

```http
GET /v1/code-reviews/{id}
```

Scope: `code_reviews:read`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The review and its findings. See [CodeReview](#codereview).

### Stop a running code review

```http
POST /v1/code-reviews/{id}/cancel
```

Scope: `code_reviews:write`.

Stops the reviewers of the running cycle. A review at rest answers as it is.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The review. See [CodeReview](#codereview).

### List the history of a code review

```http
GET /v1/code-reviews/{id}/events
```

Scope: `code_reviews:read`.

Each phase change and action, with the reason.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The events, newest first.

### Get a finding

```http
GET /v1/code-reviews/{id}/findings/{finding_id}
```

Scope: `code_reviews:read`.

With its full `body`, the `suggestion` and the quoted `anchor`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `finding_id` | path | string | The id. |

Returns `200`: The finding. See [CodeReviewFinding](#codereviewfinding).

### Dismiss a finding

```http
POST /v1/code-reviews/{id}/findings/{finding_id}/dismiss
```

Scope: `code_reviews:write`.

A dismissal stays across cycles: a later review that finds the same thing does not ask again. Dismissing a blocker can let a parked merge-queue entry go on.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `finding_id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `reason` | `not_a_problem` \| `already_handled` \| `wont_fix_here` \| `wrong_about_code` |  |

Returns `200`: The finding. See [CodeReviewFinding](#codereviewfinding).

### Undo a dismissal

```http
DELETE /v1/code-reviews/{id}/findings/{finding_id}/dismiss
```

Scope: `code_reviews:write`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `finding_id` | path | string | The id. |

Returns `200`: The finding, open again. See [CodeReviewFinding](#codereviewfinding).

### Post findings to the pull request

```http
POST /v1/code-reviews/{id}/post
```

Scope: `code_reviews:write`.

Writes the findings to the pull request as one GitHub review from your account, always as a comment (never approve or request changes). A finding goes on a line of the diff only when its quoted code was found there; the others go in the review body. A finding is never posted twice. 409 `code_review_post_not_ready` or `code_review_post_nothing_to_post`; 502 `code_review_post_github_failed` when GitHub refuses.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `finding_ids` | array of string | The findings to post. Empty or absent: every open finding not posted yet. |

Returns `200`: What was posted.


## Workspace memory

Memory entries are the notes that people and agents save for a workspace. Agents read them at the start of a session. These endpoints need the `memory:read` or `memory:write` scope. The token form in the app does not offer these scopes yet.

### List memory entries

```http
GET /v1/memories
```

Scope: `memory:read`.

Newest first. Bodies only with `include_body=true`. Forgotten entries only with `include_forgotten=true`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `workspace_id` | query | string | Required unless the token is bound to exactly one workspace. |
| `scope` | query | `workspace` \| `repository` \| `thread` |  |
| `repository_id` | query | string | With `scope`, that repository only. Without it, the entries a session on this repository sees. |
| `thread_id` | query | string |  |
| `q` | query | string | Matches the name, the description or the body. |
| `include_forgotten` | query | boolean |  |
| `include_body` | query | boolean |  |
| `limit` | query | integer | Items per page, 1 to 200. Default 50. |
| `cursor` | query | string | The `next_cursor` of the previous page. Absent for the first page. |

Returns `200`: A page of entries. Each item is a [Memory](#memory).

### Save a memory entry

```http
POST /v1/memories
```

Scope: `memory:write`.

Creates an entry. When a live entry with the same scope, target and name exists (the name is not case-sensitive), that entry is updated instead and the answer is 200. A workspace holds at most 500 live entries.

| Body field | Type | Description |
| --- | --- | --- |
| `workspace_id` | string | Required unless the token is bound to exactly one workspace. |
| `scope` (required) | `workspace` \| `repository` \| `thread` |  |
| `repository_id` | string | Required for `scope: "repository"`. |
| `thread_id` | string | Required for `scope: "thread"`. |
| `type` (required) | `user` \| `feedback` \| `project` \| `reference` |  |
| `name` (required) | string | max length 64 |
| `description` (required) | string | max length 200 |
| `body` (required) | string | At most 8192 bytes of UTF-8. |

Returns `200`: An entry with this name existed and is updated. See [Memory](#memory).

Returns `201`: The new entry. See [Memory](#memory).

### Get a memory entry

```http
GET /v1/memories/{id}
```

Scope: `memory:read`.

With its body. A forgotten entry too.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The entry. See [Memory](#memory).

### Update a memory entry

```http
PATCH /v1/memories/{id}
```

Scope: `memory:write`.

Change the type, name, description or body. The scope stays. A forgotten entry answers 409 `memory_forgotten`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `type` | `user` \| `feedback` \| `project` \| `reference` |  |
| `name` | string | max length 64 |
| `description` | string | max length 200 |
| `body` | string | At most 8192 bytes of UTF-8. |

Returns `200`: The entry. See [Memory](#memory).

### Forget a memory entry

```http
DELETE /v1/memories/{id}
```

Scope: `memory:write`.

Sessions stop seeing the entry. It stays, with `forgotten_at` set, so it can be restored. Forgetting it twice changes nothing.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The forgotten entry. See [Memory](#memory).

### Restore a forgotten entry

```http
POST /v1/memories/{id}/restore
```

Scope: `memory:write`.

Refused with 409 `memory_name_taken` when a live entry took its name, and with 409 `memory_limit_reached` at the limit.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The entry. See [Memory](#memory).


## Webhooks

A webhook endpoint is a URL that gets a signed `POST` when an event occurs. For signatures, retries and the event bodies, read [Webhooks](/docs/webhooks). These endpoints need the `webhooks:read` or `webhooks:write` scope. The token form in the app does not offer these scopes yet.

### List webhook endpoints

```http
GET /v1/webhooks
```

Scope: `webhooks:read`.

Your webhook endpoints, newest first.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `limit` | query | integer | Items per page, 1 to 200. Default 50. |
| `cursor` | query | string | The `next_cursor` of the previous page. Absent for the first page. |

Returns `200`: A page of endpoints. Secrets are never listed. Each item is a [WebhookEndpoint](#webhookendpoint).

### Create a webhook endpoint

```http
POST /v1/webhooks
```

Scope: `webhooks:write`.

Talyn signs each delivery with the secret in the answer (Standard Webhooks). The secret is shown only here and after a rotation. An account can have 20 endpoints.

| Body field | Type | Description |
| --- | --- | --- |
| `url` (required) | string | An https URL on the public internet. Private, loopback and link-local addresses are refused. |
| `description` | string | max length 500 |
| `workspace_id` | string | Receive the events of this workspace only. Absent: every workspace of the owner. A token bound to workspaces must name one of them, unless it is bound to exactly one. |
| `event_types` | array of `session.created` \| `session.updated` \| `session.archived` \| `session.pull_request_opened` \| `chat.turn_started` \| `chat.turn_completed` \| `pull_request.updated` \| `pull_request.merged` \| `pull_request.closed` \| `merge_queue.blocked` \| `code_review.completed` | The events to receive. Empty or absent: every event, including events added later. |
| `enabled` | boolean | Default true. |

Returns `201`: The new endpoint, with its secret. See [WebhookEndpoint](#webhookendpoint), plus `secret`.

### Get a webhook endpoint

```http
GET /v1/webhooks/{id}
```

Scope: `webhooks:read`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The endpoint, without its secret. See [WebhookEndpoint](#webhookendpoint).

### Change a webhook endpoint

```http
PATCH /v1/webhooks/{id}
```

Scope: `webhooks:write`.

Change the URL, the description or the event types, or switch the endpoint off and on.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `url` | string | An https URL on the public internet. Private, loopback and link-local addresses are refused. |
| `description` | string |  |
| `event_types` | array of `session.created` \| `session.updated` \| `session.archived` \| `session.pull_request_opened` \| `chat.turn_started` \| `chat.turn_completed` \| `pull_request.updated` \| `pull_request.merged` \| `pull_request.closed` \| `merge_queue.blocked` \| `code_review.completed` | The events to receive. Empty or absent: every event, including events added later. |
| `enabled` | boolean | False stops deliveries and abandons the pending ones. True clears `disabled_reason` and the failure streak. |

Returns `200`: The endpoint. See [WebhookEndpoint](#webhookendpoint).

### Delete a webhook endpoint

```http
DELETE /v1/webhooks/{id}
```

Scope: `webhooks:write`.

Deletes the endpoint and its delivery history. Pending deliveries are not sent.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `204`: Deleted.

### Rotate an endpoint's signing secret

```http
POST /v1/webhooks/{id}/rotate-secret
```

Scope: `webhooks:write`.

Makes a new secret and returns it once. The old secret also signs each delivery for `expire_previous_in_seconds` (default 24 hours), so the receiver can accept either while you deploy the new one.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

| Body field | Type | Description |
| --- | --- | --- |
| `expire_previous_in_seconds` | integer | How long the old secret also signs, so you can deploy the new one first. Default 86400 (24 hours). 0 stops it now. |

Returns `200`: The endpoint, with its new secret. See [WebhookEndpoint](#webhookendpoint), plus `secret`.

### Send a test event

```http
POST /v1/webhooks/{id}/test
```

Scope: `webhooks:write`.

Queues a `ping` event to the endpoint. It is signed and retried like any other event. Read the delivery to see the answer.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `202`: The queued delivery. See [WebhookDelivery](#webhookdelivery).

### List an endpoint's deliveries

```http
GET /v1/webhooks/{id}/deliveries
```

Scope: `webhooks:read`.

Deliveries to one endpoint, newest first, without their payloads. Kept for 30 days.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |
| `status` | query | `pending` \| `succeeded` \| `failed` \| `abandoned` |  |
| `limit` | query | integer | Items per page, 1 to 200. Default 50. |
| `cursor` | query | string | The `next_cursor` of the previous page. Absent for the first page. |

Returns `200`: A page of deliveries. Each item is a [WebhookDelivery](#webhookdelivery).

### Get a webhook delivery

```http
GET /v1/webhook-deliveries/{id}
```

Scope: `webhooks:read`.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `200`: The delivery, with the payload it sends. See [WebhookDelivery](#webhookdelivery), plus `payload`.

### Send a delivery again

```http
POST /v1/webhook-deliveries/{id}/redeliver
```

Scope: `webhooks:write`.

Sends the same event again, from the first attempt, with the same `webhook-id`. Refused while the delivery is still pending.

| Parameter | In | Type | Description |
| --- | --- | --- | --- |
| `id` | path | string | The id. |

Returns `202`: The delivery, pending again. See [WebhookDelivery](#webhookdelivery).

### List the webhook event types

```http
GET /v1/webhook-event-types
```

Scope: `webhooks:read`.

Returns `200`: Every event type an endpoint can receive.


## Objects

### Workspace

| Field | Type | Description |
| --- | --- | --- |
| `object` | `workspace` |  |
| `id` | string |  |
| `name` | string |  |
| `created_at` | string |  |
| `updated_at` | string |  |

### Team

| Field | Type | Description |
| --- | --- | --- |
| `object` | `team` |  |
| `id` | string |  |
| `name` | string |  |
| `my_role` | `owner` \| `admin` \| `member` |  |
| `created_at` | string |  |

### Space

| Field | Type | Description |
| --- | --- | --- |
| `object` | `space` |  |
| `id` | string |  |
| `team_id` | string |  |
| `name` | string |  |
| `color` | string |  |
| `created_at` | string |  |

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
| `space_id` | string |  |
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
| `chats` | array of [Chat](#chat) | The open chats, oldest first. On single-session responses only. |

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
| `resume_at` | string |  |
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

### PullRequest

| Field | Type | Description |
| --- | --- | --- |
| `object` | `pull_request` |  |
| `id` | string |  |
| `workspace_id` | string |  |
| `repository_id` | string |  |
| `repository_full_name` | string |  |
| `number` | integer |  |
| `title` | string | Null until Talyn has read the pull request from GitHub once. So are the other GitHub fields. |
| `url` | string |  |
| `author` | string |  |
| `author_is_bot` | boolean | Null: not known. |
| `state` | `open` \| `closed` \| `merged` |  |
| `draft` | boolean |  |
| `head_branch` | string |  |
| `base_branch` | string |  |
| `head_sha` | string |  |
| `additions` | integer |  |
| `deletions` | integer |  |
| `changed_files` | integer |  |
| `authored` | boolean | You opened it. The "Mine" bucket in the app. |
| `review_requested` | boolean | It waits for your review. The "Review" bucket in the app. |
| `watching` | boolean | You track it by URL. |
| `review_hidden_at` | string | When you hid it from the Reviews tab. |
| `ci_status` | `none` \| `passing` \| `running` \| `failing_optional` \| `failing_required` \| `needs_human` | The CI picture alone. `failing_required` includes a failing check whose required-ness is not known. `needs_human`: only gates a person must clear are failing. Null: not computed yet. |
| `checks` | object |  |
| `human_gates` | array of object | Failing gates only a person can clear, e.g. a visual review. |
| `blocking_reason` | string | The whole merge verdict: `mergeable`, `merge_conflicts`, `changes_requested`, `checks_failed`, `checks_failed_optional`, `blocked`, `behind`, `needs_human`, ... New values can appear. |
| `mergeable` | string | GitHub's answer, lower-cased: `mergeable`, `conflicting` or `unknown`. |
| `merge_state_status` | string | GitHub's merge state, lower-cased, e.g. `clean`, `blocked`, `behind`. |
| `review_decision` | string | `approved`, `changes_requested` or `review_required`, as the app shows it. Where the base branch does not require reviews, Talyn works it out from the reviews. |
| `unresolved_review_threads` | integer |  |
| `auto_keep_mergeable` | boolean | Talyn starts a fix when the pull request stops being mergeable. |
| `merge_queue` | [MergeQueueState](#mergequeuestate) | The pull request's entry in Talyn's merge queue. Null when it is not queued. |
| `merged_at` | string |  |
| `opened_at` | string | When the pull request was opened on GitHub. |
| `last_synced_at` | string | When Talyn last read the pull request from GitHub. |
| `created_at` | string | When Talyn started to track it. Lists are ordered by this. |
| `updated_at` | string |  |
| `session_ids` | array of string | Sessions that work on this pull request and are not archived, most recent first. On single responses only. |
| `code_review` | object | The latest code review. Null: never reviewed. On single responses only. |

### MergeQueueState

The pull request's entry in Talyn's merge queue. Null when it is not queued.

| Field | Type | Description |
| --- | --- | --- |
| `status` | string | Where the entry is: `queued`, `awaiting_ci`, `awaiting_review`, `automerge_armed`, `awaiting_external`, `awaiting_stack`, `fixing`, `merging`, `blocked` or `blocked_manual`. New values can appear. |
| `position` | integer | 1-based place in the queue of its repository and base branch. |
| `method` | `squash` \| `merge` \| `rebase` |  |
| `base_branch` | string |  |
| `head_sha` | string | The head the queue last saw. Null before it has seen one. |
| `blocked_code` | string | Why a `blocked` or `blocked_manual` entry is parked, e.g. `draft`, `no_progress`, `awaiting_human_check`. New values can appear. |
| `blocked_reason` | string | The same reason, in words for a person. |
| `auto_merge_armed` | boolean | GitHub's own auto-merge is armed on the pull request. |
| `external_state` | string | The state an external merge queue (trunk.io) reports, when one owns the base branch. |
| `enqueued_at` | string |  |

### MergeQueueEntry

All the fields of [MergeQueueState](#mergequeuestate), plus:

| Field | Type | Description |
| --- | --- | --- |
| `object` | `merge_queue_entry` |  |
| `pull_request_id` | string |  |
| `repository_id` | string |  |
| `repository_full_name` | string |  |
| `number` | integer |  |
| `title` | string |  |

### CodeReview

| Field | Type | Description |
| --- | --- | --- |
| `object` | `code_review` |  |
| `id` | string |  |
| `workspace_id` | string |  |
| `pull_request_id` | string |  |
| `cycle` | integer | How many times this pull request has been reviewed. Each new review is a new cycle of the same review. |
| `preset` | `quick` \| `standard` \| `deep` |  |
| `phase` | string | `queued`, `preparing`, `reviewing`, `sweeping`, `validating`: in progress. `ready`, `failed`, `cancelled`, `fixing`, `fixed`, `idle`: at rest. New values can appear. |
| `phase_plan` | array of string | The phases this cycle goes through, in order. |
| `runs_done` | integer |  |
| `runs_total` | integer |  |
| `lenses_run` | array of object | The reviewers that ran in this cycle. |
| `head_sha` | string | The commit the current cycle reads. |
| `reviewed_head_sha` | string | The commit the findings belong to. |
| `stale_for_head` | boolean | The pull request has new commits since the findings were made. |
| `counts` | object | Open findings by severity. |
| `open_count` | integer | Open findings at or above the workspace reporting bar. The number the app shows. |
| `dismissed_count` | integer |  |
| `funnel` | object | What the review did with its candidates: raised, kept by the judge, thrown out. |
| `failure_reason` | string |  |
| `deferred_since` | string | Set while a reviewer waits for a free runner. |
| `started_at` | string |  |
| `finished_at` | string |  |
| `created_at` | string |  |
| `findings` | array of [CodeReviewFinding](#codereviewfinding) | Most severe first. Without `body`, `suggestion` and `anchor`. On `GET /code-reviews/{id}` only. |

### CodeReviewFinding

| Field | Type | Description |
| --- | --- | --- |
| `object` | `code_review_finding` |  |
| `id` | string |  |
| `review_id` | string |  |
| `severity` | `blocker` \| `major` \| `minor` \| `nit` |  |
| `category` | string |  |
| `title` | string |  |
| `file_path` | string |  |
| `line_start` | integer |  |
| `line_end` | integer |  |
| `anchor_verified` | boolean | The quoted code is at the place the finding names. False: the reviewer paraphrased or named the wrong place. |
| `lenses` | array of object | The reviewers that reported it. Two or more is agreement. |
| `confidence` | integer |  |
| `verdict` | `unvalidated` \| `confirmed` \| `rejected` \| `uncertain` | What the judging pass decided. |
| `verdict_reason` | string | The judge's reason, in one sentence. |
| `status` | `open` \| `selected` \| `dismissed` \| `fixed` \| `stale` | `selected`: a fix run works on it now. `stale`: a later review did not find it again. New values can appear. |
| `dismissed_reason` | `not_a_problem` \| `already_handled` \| `wont_fix_here` \| `wrong_about_code` |  |
| `seen_count` | integer | How many review cycles reported it. |
| `carried_over` | boolean | An earlier cycle reported it first. |
| `posted_at` | string | When it was posted to the pull request. A posted finding is never posted again. |
| `fixed_at` | string |  |
| `fixed_head_sha` | string |  |
| `created_at` | string |  |
| `body` | string | The full text. On `GET /code-reviews/{id}/findings/{finding_id}` only. |
| `suggestion` | string | A suggested change, as plain text. Single finding only. |
| `anchor` | string | The code the finding quotes. Single finding only. |

### Memory

| Field | Type | Description |
| --- | --- | --- |
| `object` | `memory` |  |
| `id` | string |  |
| `workspace_id` | string |  |
| `scope` | `workspace` \| `repository` \| `thread` | `workspace`: every session. `repository`: sessions on one repository. `thread`: one thread. |
| `repository_id` | string |  |
| `thread_id` | string |  |
| `type` | `user` \| `feedback` \| `project` \| `reference` |  |
| `name` | string |  |
| `description` | string | One line. Sessions see the name and the description in their memory index. |
| `body` | string | The note. On single-entry responses, and on lists with `include_body=true`. |
| `bytes` | integer |  |
| `source` | object |  |
| `forgotten_at` | string | Set when the entry was forgotten. Restore it to use it again. |
| `created_at` | string |  |
| `updated_at` | string |  |

### WebhookEndpoint

| Field | Type | Description |
| --- | --- | --- |
| `object` | `webhook_endpoint` |  |
| `id` | string |  |
| `workspace_id` | string | The workspace whose events it receives. Null: every workspace of the owner. |
| `url` | string |  |
| `description` | string |  |
| `event_types` | array of `session.created` \| `session.updated` \| `session.archived` \| `session.pull_request_opened` \| `chat.turn_started` \| `chat.turn_completed` \| `pull_request.updated` \| `pull_request.merged` \| `pull_request.closed` \| `merge_queue.blocked` \| `code_review.completed` | The events it receives. Empty: every event. |
| `enabled` | boolean |  |
| `disabled_reason` | string | Why Talyn or a caller disabled it. |
| `disabled_at` | string |  |
| `consecutive_failures` | integer | Failed attempts since the last success. |
| `failing_since` | string | The first failed attempt of the current streak. |
| `created_at` | string |  |
| `updated_at` | string |  |

### WebhookDelivery

| Field | Type | Description |
| --- | --- | --- |
| `object` | `webhook_delivery` |  |
| `id` | string |  |
| `endpoint_id` | string |  |
| `event_id` | string | The `webhook-id` header. The same for every attempt and every redelivery. |
| `event_type` | string |  |
| `status` | `pending` \| `succeeded` \| `failed` \| `abandoned` | `pending`: waiting for an attempt. `succeeded`: a 2xx answer. `failed`: every attempt failed, or the endpoint answered 410. `abandoned`: the endpoint was disabled first. |
| `attempt_count` | integer |  |
| `next_attempt_at` | string | When the next attempt is due. Null unless `pending`. |
| `last_response_status` | integer |  |
| `last_error` | string |  |
| `last_response_ms` | integer |  |
| `created_at` | string |  |
| `delivered_at` | string |  |

