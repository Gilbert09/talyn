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

## Quickstart

The steps use `curl`. A TypeScript version of the whole flow follows the steps. Each guide in the `api` folder also has TypeScript examples.

### Before you start

1. Open the Talyn app.
2. Go to Settings, then Developer, then API tokens.
3. Create a token with the scopes `workspaces:read`, `repositories:read` and `sessions:write`.
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
| GET | `/openapi.json` | none | Get the OpenAPI document |

## Local sessions

A session with `runtime: "local"` runs in the Talyn desktop app. The API lists these sessions and shows them, but you cannot change them. Each action on a local session answers `409` with the code `local_runtime`.

## Plan limits

A session that you start through the API counts against your plan in the same way as a session that you start in the app. A plan limit answers `402` with `type: "plan_limit_error"`. The error has the same `code` that the app shows, for example `task_limit_reached`. When the limit is known, the error also has `limit` and `in_use`.

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

## What is not in v1 yet

- Tasks
- Pull requests
- Code review
- Webhooks
- SDKs
- Threads beyond `kind: "thread"` on `POST /sessions`
