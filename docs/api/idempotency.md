# Idempotency

A network fault can hide the answer to a create. Without protection, a retry starts a second session. The `Idempotency-Key` header prevents this. With the same key, the API runs the request one time. A retry gets the first answer.

## Where to use it

Send the header on the endpoints that start work:

- `POST /sessions`
- `POST /sessions/{id}/chats`
- `POST /chats/{id}/messages`
- `POST /sessions/{id}/thread`
- `POST /sessions/{id}/pull_request`
- `POST /sessions/{id}/fix_checks` and `POST /sessions/{id}/resolve_conflicts`
- `POST /sessions/{id}/merge`
- `POST /sessions/{id}/resize`
- `POST /sessions/{id}/previews`
- `POST /sessions/{id}/scripts/{name}/start`
- `POST /chats/{id}/checkpoints/{turn}/restore`
- `POST /memories`

The OpenAPI document lists the header on each of these endpoints. Other endpoints ignore the header.

## The key

- Choose a unique value for each new request. A UUID is a good choice.
- Use 1 to 255 printable ASCII characters. Do not use spaces.
- A bad key answers `400` `invalid_idempotency_key`.

## Rules

| Rule | Detail |
| --- | --- |
| Scope | A key belongs to one token. Two tokens can use the same key. |
| Lifetime | The API keeps a key for 24 hours. |
| First request | It claims the key, then runs. |
| Success | The API saves the answer. A retry gets the same status and body. The response has the header `Idempotent-Replayed: true`. |
| Error | The API releases the key. The create did not happen. You can fix the cause and retry with the same key. |
| Different request | The same key with a different method, path or body answers `409` `idempotency_key_reused`. |
| Still running | The same key while the first request runs answers `409` `idempotency_in_progress`. |
| Abandoned | A claim with no answer after 15 minutes is abandoned. A retry can take the key. |

Only successful answers are saved. A `4xx` or `5xx` answer is never replayed.

The API compares the method, the path and the JSON body. Send the same body in a retry.

## curl

```bash
KEY=$(uuidgen)

curl -s https://api.talyn.dev/v1/sessions \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $KEY" \
  -d '{"workspace_id":"'"$WORKSPACE_ID"'","repository_id":"'"$REPOSITORY_ID"'","agent":"claude","prompt":"Fix the flaky test."}'

# Same key, same body: the API replays the first answer.
curl -si https://api.talyn.dev/v1/sessions \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $KEY" \
  -d '{"workspace_id":"'"$WORKSPACE_ID"'","repository_id":"'"$REPOSITORY_ID"'","agent":"claude","prompt":"Fix the flaky test."}' \
  | grep -i idempotent-replayed
```

```text
idempotent-replayed: true
```

## TypeScript

Make the key one time, before the first try. Use the same key on each retry.

```ts
async function createSession(body: Record<string, unknown>) {
  const key = crypto.randomUUID();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch("https://api.talyn.dev/v1/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.TALYN_TOKEN}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        if (res.headers.get("idempotent-replayed") === "true") {
          console.log("The first try had worked. This is the saved answer.");
        }
        return await res.json();
      }

      const { error } = await res.json();
      // The first try still runs. Wait, then ask again.
      if (error.code === "idempotency_in_progress") {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      throw new Error(`${res.status} ${error.code}: ${error.message} (${error.request_id})`);
    } catch (err) {
      // A network fault: the session can exist. The same key protects the retry.
      if (err instanceof TypeError) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Could not create the session.");
}
```

## Notes

- A replayed answer has the data from the first answer. The session can have changed since then. Read `GET /sessions/{id}` for the current state.
- A send of `POST /chats/{id}/messages` with a key sends the message one time. Without a key, a retry can send it twice.
- Do not reuse a key for a different request, even after an error. Use a new key for a new request.
