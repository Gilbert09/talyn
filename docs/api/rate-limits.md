# Rate limits

The API limits how many requests a caller can send. A request over the limit answers `429` with the code `rate_limited`.

## Limits

| Limit | Counted per | Window | Maximum |
| --- | --- | --- | --- |
| All requests | Token | 1 minute | 600 |
| Creates: `POST /sessions`, `POST /sessions/{id}/chats`, `POST /chats/{id}/messages`, `POST /pull-requests/{id}/sessions`, `POST /pull-requests/{id}/code-reviews` | Token | 1 minute | 60 |
| GitHub calls: `POST /pull-requests/{id}/refresh`, `POST /code-reviews/{id}/post` | Token | 1 minute | 30 |
| Failed authentications (401) | IP address | 1 minute | 300 |
| Open streams | Token | At one time | 20 |

A create counts against the 60 create limit and the 600 limit.

A GitHub call counts against the 30 GitHub limit and the 600 limit. These requests use your own GitHub rate limit. GitHub gives a person about 5,000 requests each hour, and the Talyn app uses the same budget. At 30 each minute, a script can use 1,800 each hour at most. If GitHub limits your account, the API answers `503` `github_rate_limited` with `Retry-After`.

The IP limit counts only failed authentications. A request with a valid token costs this budget nothing. Each token check needs a database read, so the API limits repeated failures from one address. An IP over the budget gets `429` `rate_limited` with `Retry-After`.

The window slides. The API weighs the count of the previous minute by how much of it is still in the window. A burst at the edge of a minute does not give you a double budget.

A refused request does not use up budget.

A stream that is over the stream limit answers `429` with the code `too_many_streams`. See [streaming](streaming.md).

## Headers

Each response has these headers.

| Header | Meaning |
| --- | --- |
| `RateLimit-Limit` | Requests allowed in the window. |
| `RateLimit-Remaining` | Requests left in the window. |
| `RateLimit-Reset` | Seconds until the window ends. |

On a normal response, the headers describe the token budget (600 each minute). On a create, they describe the tighter create budget (60 each minute).

A `429` also has the header `Retry-After`. It gives the seconds to wait. The error body has `retry_after` with the same number.

```text
HTTP/2 429
ratelimit-limit: 60
ratelimit-remaining: 0
ratelimit-reset: 23
retry-after: 23
```

```json
{
  "error": {
    "type": "rate_limit_error",
    "code": "rate_limited",
    "message": "Too many sessions, chats or messages started. Wait, then retry.",
    "retry_after": 23,
    "request_id": "req_01JBX8Z6Q4M8N3V5K7T2W9Y1C0"
  }
}
```

## curl

```bash
curl -si https://api.talyn.dev/v1/me \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  | grep -i '^ratelimit'
```

## TypeScript

This helper waits when the budget is low, and waits for `Retry-After` after a `429`.

```ts
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function limited(path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://api.talyn.dev/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${process.env.TALYN_TOKEN}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string>),
      },
    });

    if (res.status !== 429) {
      // Slow down before the budget is empty.
      if (Number(res.headers.get("ratelimit-remaining")) === 0) {
        await sleep(Number(res.headers.get("ratelimit-reset") ?? 1) * 1000);
      }
      return res;
    }

    const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
    await sleep(wait * 1000);
  }
  throw new Error("Still rate limited after 5 tries.");
}
```

## Good practice

- Follow a running chat with the [stream](streaming.md). Do not poll `GET /chats/{id}/events` more than once each second.
- Use `limit=200` on lists to make fewer requests.
- Share one token between the parts of one program. Limits are per token.
- Use an `Idempotency-Key` on creates. A retry after a `429` then cannot start work twice.
- Add random jitter to your delays, so that many workers do not retry at the same time.
