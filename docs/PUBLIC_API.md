# Talyn public API

The Talyn public API is a REST API. You use it to start cloud agent sessions, send messages to them, and read what they do.

- Base URL: `https://api.talyn.dev/v1`
- Format: JSON requests and JSON responses. The request body is 1 MB at most.
- Authentication: a personal access token. See [authentication](api/authentication.md).
- Spec: [`api/openapi.json`](api/openapi.json) is an OpenAPI 3.1 document. The API also serves it at `GET /v1/openapi.json`. No token is needed.

The backend also serves `/v1` on its normal host.

## Early access

The API is behind a feature flag during early access. If the flag is off for your account, each request answers `403` with the code `public_api_unavailable`.

Session endpoints also need sessions to be on for your account. If they are not, the answer is `403` with the code `workbenches_unavailable`.

Team and space endpoints need the `spaces` feature. Talyn checks this flag for the token owner. If it is off, Talyn answers `403` with `spaces_unavailable`.

## Quickstart

The steps use `curl`. A TypeScript version of the whole flow follows the steps. Each guide in the `api` folder also has TypeScript examples.

### Before you start

1. Open the Talyn app.
2. Go to Settings, then API tokens.
3. Create a token with the scopes `workspaces:read`, `repositories:read` and `sessions:write`. The "Full access" preset gives these scopes.
4. Copy the token. The app shows it one time.
5. Save the token in your shell.

```bash
export TALYN_TOKEN="talyn_pat_..."
```

### Step 1. Check the token

```bash
curl -s https://api.talyn.dev/v1/me \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

```json
{
  "object": "token",
  "token": {
    "id": "...",
    "name": "my script",
    "scopes": ["workspaces:read", "repositories:read", "sessions:write"],
    "workspace_ids": null,
    "expires_at": "2027-01-31T09:30:00.000Z"
  },
  "user": { "id": "...", "email": "you@example.com" }
}
```

`workspace_ids: null` means the token reaches all of your workspaces.

### Step 2. List workspaces

```bash
curl -s https://api.talyn.dev/v1/workspaces \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

Each item in `data` has an `id`. Save one of them.

```bash
export WORKSPACE_ID="..."
```

### Step 3. List repositories

```bash
curl -s "https://api.talyn.dev/v1/repositories?workspace_id=$WORKSPACE_ID" \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

Each item has an `id` and a `full_name`, for example `acme/app`. Save the `id` of the repository to work on.

```bash
export REPOSITORY_ID="..."
```

If your token is bound to exactly one workspace, you can leave out `workspace_id`.

### Step 4. Start a session

Send an `Idempotency-Key`. If the request fails on the network, send it again with the same key. The API then starts only one session. See [idempotency](api/idempotency.md).

```bash
curl -s https://api.talyn.dev/v1/sessions \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "workspace_id": "'"$WORKSPACE_ID"'",
    "repository_id": "'"$REPOSITORY_ID"'",
    "agent": "claude",
    "prompt": "Find the slowest test in this repository and make it faster."
  }'
```

The answer is `201`. The session `status` is `provisioning`. The agent starts on the prompt when the sandbox is ready. The `chats` array holds the open chats. Save the `id` of the first chat.

```bash
export CHAT_ID="..."
```

### Step 5. Follow the transcript

The stream sends stored events first, then new events as they arrive.

```bash
curl -N https://api.talyn.dev/v1/chats/$CHAT_ID/events/stream \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

```text
id: 1
event: transcript
data: {"object":"event","chat_id":"...","seq":1,"turn":1,"type":"user","data":{...}}

: ping
```

Use `-N` so that `curl` does not buffer the output. See [streaming](api/streaming.md) for the reconnect rules.

### Step 6. Send a follow-up message

Use a second terminal while the stream is open.

```bash
curl -s https://api.talyn.dev/v1/chats/$CHAT_ID/messages \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "text": "Also add a note about the change to the README." }'
```

The answer is `202`.

```json
{ "object": "message_receipt", "chat_id": "...", "queued": true }
```

`queued: true` means the message waits for a running turn or for the sandbox. `queued: false` means the turn started now.

### The same flow in TypeScript

Node 18 or later. No SDK.

```ts
const BASE = "https://api.talyn.dev/v1";
const headers = {
  Authorization: `Bearer ${process.env.TALYN_TOKEN}`,
  "Content-Type": "application/json",
};

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string>) },
  });
  if (!res.ok) {
    const { error } = await res.json();
    throw new Error(`${res.status} ${error.code}: ${error.message} (${error.request_id})`);
  }
  return res.json() as Promise<T>;
}

const me = await api<{ user: { email: string } }>("/me");
console.log("Signed in as", me.user.email);

const workspaces = await api<{ data: { id: string; name: string }[] }>("/workspaces");
const workspaceId = workspaces.data[0].id;

const repos = await api<{ data: { id: string; full_name: string }[] }>(
  `/repositories?workspace_id=${workspaceId}`,
);
const repositoryId = repos.data[0].id;

const session = await api<{ id: string; status: string; chats?: { id: string }[] }>("/sessions", {
  method: "POST",
  headers: { "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({
    workspace_id: workspaceId,
    repository_id: repositoryId,
    agent: "claude",
    prompt: "Find the slowest test in this repository and make it faster.",
  }),
});
const chatId = session.chats?.[0]?.id;
if (!chatId) throw new Error(`No open chat yet. Read GET /sessions/${session.id} again.`);

// To follow the transcript live, use the stream reader in api/streaming.md.
const page = await api<{ data: { seq: number; type: string }[]; last_seq: number | null }>(
  `/chats/${chatId}/events?after=0`,
);
console.log(page.data.map((e) => `${e.seq} ${e.type}`));

const receipt = await api<{ queued: boolean }>(`/chats/${chatId}/messages`, {
  method: "POST",
  headers: { "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({ text: "Also add a note about the change to the README." }),
});
console.log("queued:", receipt.queued);
```

## Endpoints

Paths are relative to the base URL. A write scope includes its read scope.

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| GET | `/me` | any valid token | Get the token and its owner |
| GET | `/workspaces` | `workspaces:read` | List workspaces |
| GET | `/workspaces/{id}` | `workspaces:read` | Get a workspace |
| GET | `/teams` | `teams:read` | List your teams and roles |
| GET | `/spaces` | `spaces:read` | List your live spaces; filter by `team_id` |
| GET | `/spaces/{id}/sessions` | `spaces:read` | List visible sessions and `hidden_count` |
| GET | `/repositories` | `repositories:read` | List repositories of a workspace |
| GET | `/sessions` | `sessions:read` | List sessions |
| POST | `/sessions` | `sessions:write` | Start a session |
| GET | `/sessions/{id}` | `sessions:read` | Get a session |
| POST | `/sessions/{id}/archive` | `sessions:write` | Archive a session |
| POST | `/sessions/{id}/restore` | `sessions:write` | Restore an archived session |
| POST | `/sessions/{id}/retry` | `sessions:write` | Retry a session that failed to start |
| POST | `/sessions/{id}/chats` | `sessions:write` | Open a new chat in a session |
| GET | `/sessions/{id}/stream` | `sessions:read` | Stream session changes |
| GET | `/chats/{id}` | `sessions:read` | Get a chat |
| POST | `/chats/{id}/messages` | `sessions:write` | Send a message |
| POST | `/chats/{id}/cancel` | `sessions:write` | Stop the running turn |
| GET | `/chats/{id}/events` | `sessions:read` | Read a transcript page |
| GET | `/chats/{id}/events/stream` | `sessions:read` | Stream a transcript |
| GET | `/pull-requests` | `pull_requests:read` | List the pull requests Talyn tracks |
| GET | `/pull-requests/{id}` | `pull_requests:read` | Get a pull request |
| PATCH | `/pull-requests/{id}` | `pull_requests:write` | Turn auto-keep on or off |
| GET | `/pull-requests/{id}/description` | `pull_requests:read` | Get the description of a pull request |
| POST | `/pull-requests/{id}/refresh` | `pull_requests:write` | Read a pull request from GitHub again |
| POST | `/pull-requests/{id}/sessions` | `sessions:write` | Start a session on a pull request |
| GET | `/merge-queue` | `pull_requests:read` | List the merge queue of a workspace |
| POST | `/pull-requests/{id}/merge-queue` | `pull_requests:write` | Add a pull request to the merge queue |
| DELETE | `/pull-requests/{id}/merge-queue` | `pull_requests:write` | Remove a pull request from the merge queue |
| POST | `/pull-requests/{id}/merge-queue/resubmit` | `pull_requests:write` | Re-submit a parked pull request |
| GET | `/pull-requests/{id}/merge-queue/events` | `pull_requests:read` | List the merge-queue history of a pull request |
| GET | `/pull-requests/{id}/code-reviews` | `code_reviews:read` | List the code reviews of a pull request |
| POST | `/pull-requests/{id}/code-reviews` | `code_reviews:write` | Start a code review |
| GET | `/code-reviews/{id}` | `code_reviews:read` | Get a code review with its findings |
| POST | `/code-reviews/{id}/cancel` | `code_reviews:write` | Stop a running code review |
| GET | `/code-reviews/{id}/events` | `code_reviews:read` | List the history of a code review |
| GET | `/code-reviews/{id}/findings/{finding_id}` | `code_reviews:read` | Get a finding with its full text |
| POST | `/code-reviews/{id}/findings/{finding_id}/dismiss` | `code_reviews:write` | Dismiss a finding |
| DELETE | `/code-reviews/{id}/findings/{finding_id}/dismiss` | `code_reviews:write` | Undo a dismissal |
| POST | `/code-reviews/{id}/post` | `code_reviews:write` | Post findings to the pull request on GitHub |
| GET | `/webhooks` | `webhooks:read` | List webhook endpoints |
| POST | `/webhooks` | `webhooks:write` | Create a webhook endpoint |
| GET | `/webhooks/{id}` | `webhooks:read` | Get a webhook endpoint |
| PATCH | `/webhooks/{id}` | `webhooks:write` | Change, disable or enable a webhook endpoint |
| DELETE | `/webhooks/{id}` | `webhooks:write` | Delete a webhook endpoint |
| POST | `/webhooks/{id}/rotate-secret` | `webhooks:write` | Rotate the signing secret |
| POST | `/webhooks/{id}/test` | `webhooks:write` | Send a `ping` event |
| GET | `/webhooks/{id}/deliveries` | `webhooks:read` | List the deliveries of an endpoint |
| GET | `/webhook-deliveries/{id}` | `webhooks:read` | Get a delivery and its payload |
| POST | `/webhook-deliveries/{id}/redeliver` | `webhooks:write` | Send a delivery again |
| GET | `/webhook-event-types` | `webhooks:read` | List the event types |
| GET | `/sessions/{id}/changes` | `sessions:read` | List changed files (a sleeping sandbox answers from its stored copy) |
| GET | `/sessions/{id}/diff` | `sessions:read` | Read the diff, whole or for one `path` |
| GET | `/sessions/{id}/files` | `sessions:read` | List files |
| GET | `/sessions/{id}/files/content` | `sessions:read` | Read a file |
| GET | `/sessions/{id}/scripts` | `sessions:read` | List scripts and their state |
| POST | `/sessions/{id}/scripts/{name}/start` | `sessions:write` | Start a script |
| POST | `/sessions/{id}/scripts/{name}/stop` | `sessions:write` | Stop a script |
| GET | `/sessions/{id}/scripts/{name}/output` | `sessions:read` | Read the output of a script |
| GET | `/sessions/{id}/previews` | `sessions:read` | List preview ports |
| POST | `/sessions/{id}/previews` | `sessions:write` | Make a one-time preview link |
| POST | `/sessions/{id}/pull_request` | `sessions:write` | Commit, push and open a pull request |
| POST | `/sessions/{id}/fix_checks` | `sessions:write` | Ask the agent to fix failing checks |
| POST | `/sessions/{id}/resolve_conflicts` | `sessions:write` | Ask the agent to resolve conflicts |
| POST | `/sessions/{id}/address_review` | `sessions:write` | Ask the agent to address review comments |
| POST | `/sessions/{id}/merge` | `sessions:write` | Merge the linked pull request |
| GET | `/sessions/{id}/sessions` | `sessions:read` | List the sessions of a thread |
| POST | `/sessions/{id}/thread` | `sessions:write` | Continue a session as a thread |
| GET | `/sessions/{id}/timing` | `sessions:read` | Get where the time of the turns went |
| POST | `/sessions/{id}/resize` | `sessions:write` | Move a session to another sandbox size |
| GET | `/workspaces/{id}/readiness` | `sessions:read` | Check whether sessions can start |
| PATCH | `/chats/{id}` | `sessions:write` | Rename a chat, or change its model, effort or plan mode |
| POST | `/chats/{id}/close` | `sessions:write` | Close a chat |
| GET | `/chats/{id}/queue` | `sessions:read` | List queued messages |
| DELETE | `/chats/{id}/queue` | `sessions:write` | Clear the queue |
| DELETE | `/chats/{id}/queue/{message_id}` | `sessions:write` | Remove a queued message |
| GET | `/chats/{id}/checkpoints` | `sessions:read` | List checkpoints |
| POST | `/chats/{id}/checkpoints/{turn}/restore` | `sessions:write` | Restore the files of a checkpoint |
| GET | `/memories` | `memory:read` | List memory entries |
| POST | `/memories` | `memory:write` | Save a memory entry |
| GET | `/memories/{id}` | `memory:read` | Get a memory entry |
| PATCH | `/memories/{id}` | `memory:write` | Update a memory entry |
| DELETE | `/memories/{id}` | `memory:write` | Forget a memory entry |
| POST | `/memories/{id}/restore` | `memory:write` | Restore a forgotten entry |
| GET | `/repositories/{id}` | `repositories:read` | Get a repository |
| GET | `/repositories/{id}/settings` | `repositories:read` | Get repository settings |
| PATCH | `/repositories/{id}/settings` | `repositories:write` | Change the sandbox size, the preview or setup learning |
| GET | `/repositories/{id}/instructions` | `repositories:read` | Get repository instructions |
| PUT | `/repositories/{id}/instructions` | `repositories:write` | Write repository instructions |
| DELETE | `/repositories/{id}/instructions` | `repositories:write` | Delete repository instructions |
| GET | `/repositories/{id}/setup` | `repositories:read` | Get the Setup list |
| PUT | `/repositories/{id}/setup` | `repositories:write` | Write the Setup list |
| POST | `/repositories/{id}/setup/steps/{step_id}/accept` | `repositories:write` | Accept a learned setup step |
| POST | `/repositories/{id}/setup/steps/{step_id}/dismiss` | `repositories:write` | Dismiss a learned setup step |
| POST | `/repositories/{id}/setup/steps/{step_id}/retry` | `repositories:write` | Retry a setup step |
| GET | `/workspaces/{id}/sandbox_setup` | `repositories:read` | Get the dotfiles and setup steps of a workspace |
| PUT | `/workspaces/{id}/sandbox_setup` | `repositories:write` | Write the dotfiles and setup steps of a workspace |
| POST | `/workspaces/{id}/sandbox_setup/steps/{step_id}/retry` | `repositories:write` | Retry a workspace setup step |
| GET | `/repositories/{id}/setup_recipe` | `repositories:read` | Deprecated. Use `GET /repositories/{id}/setup` |
| POST | `/repositories/{id}/setup_recipe/steps/{step_id}/revert` | `repositories:write` | Deprecated. Use the `dismiss` endpoint |
| GET | `/openapi.json` | none | Get the OpenAPI document |

## Sessions in spaces

To start a session in a space, set `space_id` on `POST /sessions`. The token also needs `spaces:write`.

Send `repository_id` from one of your workspaces, or send `repository_full_name` as `owner/name`.
Talyn uses your home workspace for the team. Talyn adds the repository there when needed.
If you send `workspace_id`, it must be that home workspace.
With `space_id`, you cannot send `kind: "thread"`, `thread_id`, `pull_request_id` or `auto_create_pr`. Each answers `400` `invalid_parameter`.

A teammate can read a space session and its transcript when their GitHub account can read its repository.
Only the session owner can change it.
`hidden_count` counts sessions hidden on the current page.

## Local sessions

A session with `runtime: "local"` runs in the Talyn desktop app. The API lists these sessions and shows them, but you cannot change them. Each action on a local session answers `409` with the code `local_runtime`.

## Plan limits

A box that you start through the API counts against your plan in the same way as one that you start in the app. A plan limit answers `402` with `type: "plan_limit_error"`. The error has the same `code` that the app shows, for example `concurrent_box_limit_reached`. The error also has the numbers that apply, such as `limit` and `in_use`. See [Errors](api/errors.md#plan-limits).

## Versioning

- The major version is in the path: `/v1`.
- Inside `v1`, changes are additive only. Talyn can add endpoints, optional request fields, response fields, event fields, error codes and enum values.
- Talyn does not remove or rename a field inside `v1`. A change that breaks callers goes in a new major version.
- Write your code to ignore fields it does not know. Write your code to handle new enum values.

## Guides

- [Authentication](api/authentication.md): tokens, scopes, workspace binding.
- [Pagination](api/pagination.md): cursors and lists.
- [Errors](api/errors.md): the error body and all error codes.
- [Idempotency](api/idempotency.md): retry a create without a duplicate.
- [Streaming](api/streaming.md): server-sent events, reconnect, polling.
- [Rate limits](api/rate-limits.md): limits, headers and retry.
- [Pull requests](api/pull-requests.md): pull requests, the merge queue and code reviews.
- [Webhooks](api/webhooks.md): events, signatures, retries and delivery logs.
- [Session work](api/session-work.md): changes, files, scripts, previews, pull request actions, threads, timing, resize, chats, memory, repository settings and setup.

## What is not in v1 yet

- Tasks
- Merging a pull request that has no session directly. Use the merge queue.
- Code review fix runs
- SDKs
