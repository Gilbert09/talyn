# Errors

The API uses HTTP status codes. Each error has a JSON body.

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "invalid_parameter",
    "message": "Unknown field: color.",
    "param": "color",
    "request_id": "req_01JBX8Z6Q4M8N3V5K7T2W9Y1C0"
  }
}
```

| Field | Meaning |
| --- | --- |
| `type` | The class of the error. It follows from the HTTP status. |
| `code` | A stable, snake_case code. Use it in your code. |
| `message` | A sentence for a person. The text can change. Do not match on it. |
| `param` | The request field, query parameter or header that caused the error. Present when there is one. |
| `request_id` | The id of the request. It is also in the `X-Request-Id` response header. |

Some errors have more fields. A `402` can have `limit` and `in_use`. An `insufficient_scope` error has `required_scope`. A `429` has `retry_after`.

## Types and statuses

| Type | Status |
| --- | --- |
| `invalid_request_error` | 400, 415, 422 |
| `authentication_error` | 401 |
| `plan_limit_error` | 402 |
| `permission_error` | 403 |
| `not_found_error` | 404 |
| `conflict_error` | 409 |
| `payload_too_large_error` | 413 |
| `rate_limit_error` | 429 |
| `unavailable_error` | 503 |
| `api_error` | 500 and other 5xx |

## Codes

New codes can appear in `v1`. Handle a code that you do not know by its `type` or its status.

### Authentication and access

| Status | Code | Meaning | What to do |
| --- | --- | --- | --- |
| 401 | `missing_token` | No bearer token in the request. | Send `Authorization: Bearer talyn_pat_...`. |
| 401 | `invalid_token` | The token is not a valid `talyn_pat_` token. | Check the token. App, MCP and session tokens do not work. |
| 401 | `token_revoked` | The owner revoked the token. | Create a new token. |
| 401 | `token_expired` | The token passed its expiry. | Create a new token. |
| 403 | `account_not_allowed` | The account may not use this deployment. | Contact Talyn. |
| 403 | `insufficient_scope` | The token lacks a scope. The body has `required_scope`. | Create a token with that scope. |
| 403 | `public_api_unavailable` | The API is not on for the account during early access. | Ask Talyn for access. |
| 403 | `workbenches_unavailable` | Sessions are not on for the account. | Ask Talyn for access. |

### Bad requests

| Status | Code | Meaning | What to do |
| --- | --- | --- | --- |
| 400 | `invalid_parameter` | A field, query parameter or header is not valid. `param` names it. An unknown body field also gives this code. | Fix the value. |
| 400 | `missing_parameter` | A needed field is missing, for example `workspace_id` or `repository_id`. | Add the field. |
| 400 | `invalid_json` | The body is not valid JSON. | Fix the body. |
| 400 | `invalid_cursor` | The `cursor` is not a `next_cursor` of this API. | Use a `next_cursor` unchanged. |
| 400 | `invalid_idempotency_key` | The `Idempotency-Key` is not valid. | Use 1 to 255 printable ASCII characters with no spaces. |
| 413 | `body_too_large` | The body is more than 1 MB. | Send a smaller body. |
| 415 | `unsupported_encoding` | The body encoding is not supported. | Send plain UTF-8 JSON. |
| 400 | `invalid_webhook_url` | The webhook URL is not allowed: not https, has a user name, or points to a private, loopback or reserved address. `param` is `url`. | Use a public https URL. See [webhooks](webhooks.md#which-urls-are-allowed). |

Request bodies are strict. A field that the API does not know gives `400` `invalid_parameter`. The `param` field names the unknown field.

### Not found

| Status | Code | Meaning |
| --- | --- | --- |
| 404 | `workspace_not_found` | The workspace does not exist, or the token cannot reach it. |
| 404 | `session_not_found` | The session does not exist, or the token cannot reach it. |
| 404 | `chat_not_found` | The chat does not exist, or the token cannot reach it. |
| 404 | `webhook_endpoint_not_found` | The webhook endpoint does not exist, or the token cannot reach it. |
| 404 | `webhook_delivery_not_found` | The webhook delivery does not exist, or the token cannot reach it. |
| 404 | `route_not_found` | The method and path match no endpoint. |

A resource that the token cannot reach gives the same `404` as a resource that does not exist.

### Conflicts

| Status | Code | Meaning | What to do |
| --- | --- | --- | --- |
| 409 | `idempotency_key_reused` | The key was used with a different method, path or body. | Use a new key for a new request. |
| 409 | `idempotency_in_progress` | The first request with this key still runs. | Wait. Then retry with the same key. |
| 409 | `local_runtime` | The session runs in the desktop app. The API cannot change it. | Use the app. |
| 409 | `not_ready` | The session is not in a state that allows the action, for example while it provisions. | Poll the session. Retry when `status` is `ready`. |
| 409 | `chat_closed` | The chat is closed. | Open a new chat. |
| 409 | `archived` | The session is archived. | Call `POST /sessions/{id}/restore`. |
| 409 | `not_failed` | A retry was sent for a session that did not fail. | Retry only when `status` is `error`. |
| 409 | `webhook_endpoint_limit_reached` | The account has 20 webhook endpoints. The body has `limit`. | Delete an endpoint. |
| 409 | `webhook_endpoint_disabled` | A test or a redelivery was sent to a disabled endpoint. | Enable it with `PATCH /webhooks/{id}`. |
| 409 | `delivery_pending` | A redelivery was sent for a delivery that is still pending. | Wait until it is no longer `pending`. |

### Plan limits

A plan limit answers `402` with `type: "plan_limit_error"`. The `code` is the same code that the Talyn app uses. The body has `limit` and `in_use` when the numbers are known.

| Code | Meaning |
| --- | --- |
| `task_limit_reached` | The plan allows no more active tasks. |
| `merge_queue_limit_reached` | The plan allows no more merge queue pull requests. |
| `workflow_limit_reached` | The plan allows no more workflows. |
| `loop_limit_reached` | The plan allows no more loops. |

Other plan codes can appear. Match on `type` for a general rule.

```json
{
  "error": {
    "type": "plan_limit_error",
    "code": "task_limit_reached",
    "message": "...",
    "limit": 3,
    "in_use": 3,
    "request_id": "req_..."
  }
}
```

### Rate limits and streams

| Status | Code | Meaning | What to do |
| --- | --- | --- | --- |
| 429 | `rate_limited` | The token sent too many requests, or the IP made too many failed authentications. | Wait `Retry-After` seconds. See [rate limits](rate-limits.md). |
| 429 | `too_many_streams` | The token has 20 open streams. | Close a stream. |

### Server errors

| Status | Code | Meaning | What to do |
| --- | --- | --- | --- |
| 500 | `internal_error` | A fault on the Talyn side. The message never has internal details. | Retry. If it continues, send the `request_id` to Talyn. |
| 503 | varies | A service that the request needs is not available. | Retry after a delay. |

## Handle errors

- Use the `code` for logic. Use the `type` or the status for codes that you do not know.
- Retry `429`, `500` and `503`. Use a delay that grows. Respect `Retry-After`.
- Do not retry other `4xx` errors without a change to the request.
- Send an `Idempotency-Key` on creates, so that a retry does not start work twice.
- Log the `request_id`. Quote it when you ask for help.

### curl

```bash
curl -si https://api.talyn.dev/v1/sessions/does-not-exist \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

```text
HTTP/2 404
x-request-id: req_01JBX8Z6Q4M8N3V5K7T2W9Y1C0

{"error":{"type":"not_found_error","code":"session_not_found","message":"No such session.","request_id":"req_01JBX8Z6Q4M8N3V5K7T2W9Y1C0"}}
```

### TypeScript

```ts
interface ApiErrorBody {
  error: {
    type: string;
    code: string;
    message: string;
    param?: string;
    request_id: string | null;
    [extra: string]: unknown;
  };
}

class TalynApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody["error"],
  ) {
    super(`${status} ${body.code}: ${body.message} (request ${body.request_id})`);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.talyn.dev/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${process.env.TALYN_TOKEN}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string>),
      },
    });
    if (res.ok) return (await res.json()) as T;

    const retryable = res.status === 429 || res.status === 500 || res.status === 503;
    if (retryable && attempt < 4) {
      const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    throw new TalynApiError(res.status, ((await res.json()) as ApiErrorBody).error);
  }
}

try {
  await call("/sessions/does-not-exist");
} catch (err) {
  if (err instanceof TalynApiError && err.body.code === "session_not_found") {
    console.log("No such session.");
  } else {
    throw err;
  }
}
```

Retry a create only with the same `Idempotency-Key` that the first try used.
