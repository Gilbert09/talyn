---
title: API overview
navLabel: Overview
description: Start sessions, send messages and read the results from your own scripts with the Talyn REST API and a personal access token.
---

The Talyn API lets a script do what you do in the app: start a session, send the agent a message, follow the transcript, read the diff and open the pull request.

The base URL is:

```text
https://api.talyn.dev/v1
```

The API takes and returns JSON. Request bodies can be up to 1 MB. The full OpenAPI 3.1 document is at [api.talyn.dev/v1/openapi.json](https://api.talyn.dev/v1/openapi.json), and you can fetch it without a token.

The API is not yet available to all accounts. If it is off for your account, each request returns `403` with the code `public_api_unavailable`, and **Settings** does not show **API tokens**.

## Create a token

Every request needs a personal access token. Tokens start with `talyn_pat_`.

1. In Talyn, open **Settings**.
2. Select **API tokens**.
3. Select **Create token**.
4. Type a name, for example "CI script".
5. Choose when the token expires: 30 days, 90 days (the default), 1 year, or no expiry.
6. Choose **All workspaces** or one workspace.
7. Choose the access. **Read only** and **Full access** are shortcuts. You can also set each of Workspaces, Repositories and Sessions to None, Read, or Read & write. If spaces are on for your account, the form also shows Teams and Spaces.
8. Select **Create token**.
9. Copy the token. Talyn shows it one time only.

Talyn stores only a hash of the token. If you lose it, revoke it and create a new one.

To revoke a token, select it in the same list and confirm **Revoke token**. Anything that uses the token stops working at once.

## Authenticate

Send the token in the `Authorization` header:

```bash
curl https://api.talyn.dev/v1/me \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

`GET /me` returns the token's scopes, its workspace, its expiry and the account it acts for. Use it to check a new token.

Only `talyn_pat_` tokens work on the API. Your app sign-in and your [MCP token](/docs/mcp) do not.

The API sends no CORS headers, so a web page in a browser cannot call it. Call it from a server, a script or a CI job.

## Scopes

Each endpoint needs one scope. A write scope includes its read scope. The [endpoint reference](/docs/api-reference) names the scope of each endpoint.

The access you choose in the token form gives these scopes:

| Access | Scope | Allows |
| --- | --- | --- |
| Workspaces: Read | `workspaces:read` | Read workspaces. |
| Teams: Read | `teams:read` | Read the teams you are in. |
| Spaces: Read | `spaces:read` | Read team spaces and their sessions. |
| Spaces: Read & write | `spaces:write` | Start sessions in team spaces. |
| Repositories: Read | `repositories:read` | Read repositories, their settings, instructions and setup. |
| Repositories: Read & write | `repositories:write` | Change repository settings, instructions and setup. |
| Sessions: Read | `sessions:read` | Read sessions, chats and transcripts, and open the streams. |
| Sessions: Read & write | `sessions:write` | Start sessions and send messages, run scripts, open and merge pull requests. |

The form shows Teams and Spaces only when spaces are on for your account. Spaces are not yet available to all accounts. If spaces are off for your account, the team and space endpoints return `403` with the code `spaces_unavailable`.

**Read only** gives read access to workspaces, repositories and sessions. **Full access** gives read access to workspaces and repositories, and read and write access to sessions. When the form shows Teams and Spaces, **Read only** also gives read access to teams and spaces. **Full access** also gives read access to teams and read and write access to spaces.

The API also has these scopes. The token form does not offer them yet, so a token from the app cannot call these endpoints:

| Scope | Allows |
| --- | --- |
| `pull_requests:read` | Read pull requests and the merge queue. |
| `pull_requests:write` | Refresh pull requests, change auto keep mergeable, and add to or remove from the merge queue. |
| `code_reviews:read` | Read code reviews and their findings. |
| `code_reviews:write` | Start and stop code reviews, dismiss findings and post them to GitHub. |
| `memory:read` | Read workspace memory. |
| `memory:write` | Save, change and forget workspace memory. |
| `webhooks:read` | Read webhook endpoints and their deliveries. |
| `webhooks:write` | Create, change, test and delete webhook endpoints, and send deliveries again. |

A token bound to one workspace can only see that workspace. A request for anything outside it gets `404`.

## A first session

These steps start a session, follow the agent as it works, and open the pull request.

1. Find your repository's id:

   ```bash
   curl "https://api.talyn.dev/v1/repositories?workspace_id=$WORKSPACE_ID" \
     -H "Authorization: Bearer $TALYN_TOKEN"
   ```

2. Start a session with a prompt. `agent` is `claude` or `codex`:

   ```bash
   curl https://api.talyn.dev/v1/sessions \
     -H "Authorization: Bearer $TALYN_TOKEN" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: $(uuidgen)" \
     -d '{
       "workspace_id": "'"$WORKSPACE_ID"'",
       "repository_id": "'"$REPOSITORY_ID"'",
       "agent": "claude",
       "prompt": "Add a --json flag to the export command"
     }'
   ```

   The response is the session, with `status` set to `provisioning` and one chat in `chats`. The agent starts on the prompt when the sandbox is ready.

3. Follow the transcript of that chat:

   ```bash
   curl -N https://api.talyn.dev/v1/chats/$CHAT_ID/events/stream \
     -H "Authorization: Bearer $TALYN_TOKEN"
   ```

4. Send a follow-up message. If the agent is busy, the message waits in the queue and `queued` is `true`:

   ```bash
   curl https://api.talyn.dev/v1/chats/$CHAT_ID/messages \
     -H "Authorization: Bearer $TALYN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"text": "Also add a test for it"}'
   ```

5. Open the pull request:

   ```bash
   curl https://api.talyn.dev/v1/sessions/$SESSION_ID/pull_request \
     -H "Authorization: Bearer $TALYN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"title": "Add --json to export"}'
   ```

A session you start with the API is an ordinary session. It shows in the app, and it uses your plan like any other.

## Errors

An error has a status code and a JSON body:

```json
{
  "error": {
    "type": "permission_error",
    "code": "insufficient_scope",
    "message": "This token does not have the \"sessions:write\" scope.",
    "required_scope": "sessions:write",
    "request_id": "req_..."
  }
}
```

`type` is the class of error and `code` is the exact reason. Branch on `code`. `param` names the field when a field is wrong. Quote `request_id` when you ask for help.

| Status | Type | Common codes |
| --- | --- | --- |
| 400 | `invalid_request_error` | `invalid_parameter`, `missing_parameter`, `invalid_cursor`, `invalid_json` |
| 401 | `authentication_error` | `missing_token`, `invalid_token`, `token_revoked`, `token_expired` |
| 402 | `plan_limit_error` | The plan limit that was hit, for example `concurrent_box_limit_reached` |
| 403 | `permission_error` | `insufficient_scope`, `account_not_allowed`, `public_api_unavailable`, `workbenches_unavailable`, `spaces_unavailable` |
| 404 | `not_found_error` | `route_not_found`, or `<thing>_not_found` |
| 409 | `conflict_error` | The resource is not in a state that allows the request |
| 413 | `payload_too_large_error` | `body_too_large` |
| 429 | `rate_limit_error` | `rate_limited`, `too_many_streams` |
| 503 | `unavailable_error` | `github_rate_limited`, or a service that is briefly unavailable |
| 5xx | `api_error` | `internal_error` |

A `402` carries the details of the limit, such as `limit`, `in_use` and `period_end`. See [Plans, usage and billing](/docs/billing).

## Rate limits

Limits count requests per token over a sliding one-minute window.

| Limit | Requests per minute |
| --- | --- |
| All requests | 600 |
| Requests that start something (sessions, chats, messages and other actions) | 60 |
| Requests that call GitHub (open or merge a pull request) | 30 |
| Open streams at the same time | 20 |

Every response has `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers. `RateLimit-Reset` is in seconds. When two limits apply, the headers show the tighter one.

When you go over, you get `429` with a `Retry-After` header in seconds. Wait that long, then retry. A refused request does not count against your budget.

## Pagination

List endpoints return a page, newest first:

```json
{
  "object": "list",
  "data": [],
  "has_more": true,
  "next_cursor": "eyJ..."
}
```

Set `limit` from 1 to 200. The default is 50. To get the next page, send `next_cursor` back as `cursor`. When `has_more` is `false`, you have the last page.

A transcript (`GET /chats/{id}/events`) pages by sequence number instead. Use `after` and `limit` (up to 2000).

## Retries and idempotency

A network fault can hide the answer to a create, and a blind retry would start a second session. To stop this, send an `Idempotency-Key` header on requests that start something. Use a new UUID for each new request, and the same one when you retry it.

With the same key, the API runs the request one time and gives a retry the first answer. A replayed answer has the header `Idempotent-Replayed: true`. Talyn keeps a key for 24 hours.

## Streams

Two endpoints send server-sent events:

- `GET /chats/{id}/events/stream` sends the transcript of one chat: each message, tool call and tool result.
- `GET /sessions/{id}/stream` sends changes to a session: its status, new chats, and turns that start or end.

Each stream sends a `: ping` comment every 15 seconds to keep the connection open. Ignore those lines.

When a transcript stream drops, reconnect with the `Last-Event-ID` header set to the last `id` you got. The stream continues from the next event, with no gaps and no duplicates.

A browser `EventSource` cannot send an `Authorization` header. Read the stream with `fetch` or an SSE client that can set headers.

## Versions

The version is in the path. Changes inside `v1` only add things: new endpoints, new optional fields and new values. Ignore fields you do not know.

## Next

- [Endpoint reference](/docs/api-reference) lists every endpoint, with its scope.
- [Webhooks](/docs/webhooks) tells Talyn to send events to your server.
- [Talyn MCP server](/docs/mcp) connects Claude Code or another MCP client to your Talyn account.
