# Authentication

Each request to `/v1` needs a personal access token. Send it in the `Authorization` header.

```text
Authorization: Bearer talyn_pat_...
```

Only `GET /v1/openapi.json` works without a token.

## Which tokens work

Only tokens that start with `talyn_pat_` work on `/v1`. These tokens do not work:

- App sign-in tokens
- MCP tokens
- Session tokens

Each of these answers `401` with the code `invalid_token`.

## Create a token

1. Open the Talyn app.
2. Go to Settings, then Developer, then API tokens.
3. Choose a name, the scopes, and an expiry.
4. Optionally, bind the token to some workspaces.
5. Copy the token.

The app shows the plaintext one time. Talyn stores only a SHA-256 hash of it. If you lose the token, create a new one.

### Expiry

- The default expiry is 90 days.
- The longest expiry is 365 days.
- You can also choose that the token never expires.

You can revoke a token in the same screen at any time.

## Scopes

| Scope | Gives access to |
| --- | --- |
| `workspaces:read` | `GET /workspaces`, `GET /workspaces/{id}` |
| `repositories:read` | List and get repositories. Read repository settings, instructions and the setup recipe. |
| `repositories:write` | Change repository settings. Write and delete repository instructions. Revert setup steps. Also includes `repositories:read`. |
| `sessions:read` | Read sessions, chats and events. Open the streams. Read changes, diffs, files, scripts, previews, queues, checkpoints and timing. |
| `sessions:write` | Start, archive, restore and retry sessions. Open, change and close chats. Send messages. Stop turns. Run scripts, make preview links, open and merge pull requests, resize sessions. Also includes `sessions:read`. |
| `memory:read` | List and get workspace memory entries. |
| `memory:write` | Save, change, forget and restore memory entries. Also includes `memory:read`. |

A write scope includes its read scope. A token with `sessions:write` can call all `sessions:read` endpoints.

`GET /me` needs any valid token. It needs no scope.

A request without the needed scope answers `403` with the code `insufficient_scope`. The error body has `required_scope`. The `WWW-Authenticate` header also names the scope.

```json
{
  "error": {
    "type": "permission_error",
    "code": "insufficient_scope",
    "message": "This token does not have the \"sessions:write\" scope.",
    "required_scope": "sessions:write",
    "request_id": "req_01JBX8Z6Q4M8N3V5K7T2W9Y1C0"
  }
}
```

## Bind a token to workspaces

A token can be bound to some of your workspaces. `GET /me` shows the binding in `token.workspace_ids`. The value `null` means all workspaces.

- A workspace outside the binding answers `404` `workspace_not_found`. The API does not say that the workspace exists.
- If the token is bound to exactly one workspace, you can leave out `workspace_id`. This applies to `GET /repositories`, `GET /sessions` and `POST /sessions`.
- If the token reaches more than one workspace, `workspace_id` is required. A request without it answers `400` `missing_parameter`.

## Check a token

```bash
curl -s https://api.talyn.dev/v1/me \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

```ts
const res = await fetch("https://api.talyn.dev/v1/me", {
  headers: { Authorization: `Bearer ${process.env.TALYN_TOKEN}` },
});
if (!res.ok) throw new Error(`Token check failed: ${res.status}`);
const me = await res.json();
console.log(me.token.scopes, me.token.workspace_ids, me.token.expires_at);
```

## Authentication errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `missing_token` | The request has no bearer token. |
| 401 | `invalid_token` | The token is not a valid `talyn_pat_` token. |
| 401 | `token_revoked` | The owner revoked the token. |
| 401 | `token_expired` | The token passed its expiry. |
| 403 | `account_not_allowed` | The account may not use this deployment. |
| 403 | `insufficient_scope` | The token lacks the needed scope. |
| 403 | `public_api_unavailable` | The API is not on for the account. |
| 403 | `workbenches_unavailable` | Sessions are not on for the account. |

A `401` includes a `WWW-Authenticate: Bearer realm="talyn-api"` header. See [errors](errors.md) for the full list.

## Keep the token safe

- Treat the token like a password. It acts as you.
- Keep it in an environment variable or a secret store. Do not commit it.
- The API sends no CORS headers. A browser cannot read a `/v1` answer. Do not use a token in a web page. Call the API from a server or a script.
- Use the smallest scopes and the shortest expiry that your job needs.
- Revoke a token that leaks.
- A token never has admin rights.
