---
title: Webhooks
description: Get a signed HTTP request on your server when a session is ready, a turn ends, a pull request merges or a code review finishes.
---

A webhook endpoint is a URL on your server. Talyn sends an HTTP `POST` to it when something happens in your workspaces, for example when a session is ready or a turn ends. You do not have to poll the API.

Talyn signs each request with the [Standard Webhooks](https://www.standardwebhooks.com) scheme. Any Standard Webhooks library can verify it.

You manage endpoints with the API. Creating an endpoint needs the `webhooks:write` scope. Reading endpoints and deliveries needs `webhooks:read`. The token form in the app does not offer these scopes yet. For each endpoint and its fields, see [Webhooks in the endpoint reference](/docs/api-reference#webhooks).

## Create an endpoint

```bash
curl https://api.talyn.dev/v1/webhooks \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "url": "https://example.com/talyn/webhooks",
    "description": "CI bot",
    "event_types": ["session.updated", "chat.turn_completed", "pull_request.merged"]
  }'
```

The response is the endpoint, with a `secret` that starts with `whsec_`.

- The API shows `secret` in this response and after a rotation only. Store it now.
- If `event_types` is empty or absent, the endpoint gets all events. This includes events that Talyn adds later.
- If `workspace_id` is absent, the endpoint gets the events of all your workspaces. Set it to get the events of one workspace only.
- A token bound to workspaces must name one of its workspaces. A token bound to exactly one workspace can leave `workspace_id` out. The endpoint then gets that workspace.
- An account can have 20 endpoints. Each endpoint gets its own copy of each event.

To check your server, send `POST /v1/webhooks/{id}/test`. Talyn sends a `ping` event at once. Then read the delivery to see how your server answered.

## Which URLs Talyn accepts

- The URL must use `https`.
- The URL can have 2048 characters at most.
- The URL must not contain a user name, a password or a fragment (`#`).
- The host must be on the public internet. Talyn refuses private, loopback, link-local, CGNAT and cloud metadata addresses, in IPv4 and IPv6.
- Talyn checks the URL when you create or change the endpoint. Talyn checks the address again before each delivery, because DNS can change.
- Talyn does not follow redirects. A `3xx` answer is a failed attempt.

If Talyn does not accept the URL, the request returns `400` with the code `invalid_webhook_url`.

## The request

```http
POST /talyn/webhooks HTTP/1.1
Content-Type: application/json
User-Agent: Talyn-Webhooks/1.0 (+https://talyn.dev)
webhook-id: evt_3f8a2c1d9b7e4f60a1c2d3e4f5a6b7c8
webhook-timestamp: 1793611800
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=

{"id":"evt_3f8a2c1d9b7e4f60a1c2d3e4f5a6b7c8","type":"chat.turn_completed","created_at":"2026-11-02T09:31:12.000Z","workspace_id":"...","data":{...}}
```

Every body has the same envelope:

| Field | Meaning |
| --- | --- |
| `id` | The event id. It is also the `webhook-id` header. It stays the same for each retry and each redelivery. |
| `type` | The event type, for example `session.updated`. |
| `created_at` | When Talyn made the event. |
| `workspace_id` | The workspace of the event. Null for a `ping` to an endpoint that has no workspace. |
| `data.object` | The object of the event. Sessions and chats have the same shape as in the REST API. |

Some events have more fields in `data`, for example `previous_attributes` or `turn`. The [event list](#events) shows them. New fields can appear. Ignore fields that you do not know.

## Answer quickly

- Answer with a `2xx` status within 10 seconds. Talyn records any other answer as a failed attempt.
- Do the work after you answer. For example, put the event in a queue, answer `200`, then process the event.
- Talyn ignores the body of your answer.

## Verify the signature

Verify each request before you use it. The signed content is `{webhook-id}.{webhook-timestamp}.{raw body}`. The key is the secret without `whsec_`, decoded from base64. The signature is HMAC-SHA256, in base64.

- Use the raw body, as the bytes arrived. Do not parse the body and serialize it again, because that changes the bytes.
- Refuse a timestamp that is more than 5 minutes from your clock. This stops a replay of an old request.
- The header can hold more than one signature, separated by spaces. This occurs during a [secret rotation](#rotate-the-secret). Accept the request when one signature matches.

With the `standardwebhooks` package:

```ts
import express from "express";
import { Webhook } from "standardwebhooks";

const wh = new Webhook(process.env.TALYN_WEBHOOK_SECRET!); // "whsec_..."
const app = express();

app.post("/talyn/webhooks", express.raw({ type: "application/json" }), (req, res) => {
  let event: { id: string; type: string; data: Record<string, unknown> };
  try {
    // Checks the signature and the timestamp. Throws when either is wrong.
    event = wh.verify(req.body, req.headers as Record<string, string>) as typeof event;
  } catch {
    return res.status(400).send("bad signature");
  }
  res.status(200).end();
  void handle(event); // Do the work after the answer.
});
```

With no library, in Node 18 or later:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;

export function verifyTalynWebhook(
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  secret: string, // "whsec_..."
): boolean {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signatures = headers["webhook-signature"];
  if (!id || !timestamp || !signatures) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(rawBody)
    .digest();

  return signatures.split(" ").some((part) => {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

## Handle each event one time

Talyn sends each event at least one time. A network fault after your server answers can cause a second delivery of the same event. A redelivery also sends the same event again.

- Use `webhook-id` as the key. It is the same as the `id` in the body.
- Store the ids that you processed. Skip an id that you processed before.
- Keep the ids for at least 2 days. Retries continue for about 28 hours.

Talyn does not keep events in order. Two events can arrive in the opposite order. When the order is important, compare `created_at`, or read the object again from the API, for example with `GET /v1/sessions/{id}`.

## Retries

Talyn retries a failed attempt. A failed attempt is an answer that is not `2xx`, no answer within 10 seconds, a network error, or an address that Talyn does not accept.

| Attempt | Wait before it |
| --- | --- |
| 1 | None |
| 2 | 5 seconds |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |
| 6 | 5 hours |
| 7 | 10 hours |
| 8 | 10 hours |

If attempt 8 fails, the delivery status changes to `failed`. In practice the waits are a little longer, because Talyn looks for due deliveries every few seconds.

### When Talyn turns off an endpoint

- An answer of `410 Gone` turns off the endpoint at once. Send it when you remove your receiver.
- If every attempt fails for 3 days, and at least 10 attempts in a row fail, Talyn turns off the endpoint. One success sets the count back to zero.
- An endpoint that is off has `enabled: false` and a `disabled_reason`. Its pending deliveries change to `abandoned`.
- To start again, repair your receiver. Then send `PATCH /v1/webhooks/{id}` with `{"enabled": true}`. This also sets the failure count back to zero. Talyn does not send the events from the time when the endpoint was off.

## Deliveries

Each event to each endpoint is one delivery. To list the deliveries that failed:

```bash
curl "https://api.talyn.dev/v1/webhooks/$ENDPOINT_ID/deliveries?status=failed" \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

| `status` | Meaning |
| --- | --- |
| `pending` | The delivery waits for an attempt. `next_attempt_at` tells you when. |
| `succeeded` | Your server answered `2xx`. |
| `failed` | All attempts failed, or your server answered `410`. |
| `abandoned` | The endpoint was turned off before the delivery succeeded. |

- A list item has no payload. `GET /v1/webhook-deliveries/{id}` gives the delivery with its `payload`.
- `last_response_status`, `last_error` and `last_response_ms` describe the last attempt.
- `POST /v1/webhook-deliveries/{id}/redeliver` sends a delivery again, from attempt 1, with the same `webhook-id`. Talyn refuses it while the delivery is `pending`, and when the endpoint is off.
- Talyn keeps deliveries for 30 days.

## Rotate the secret

```bash
curl https://api.talyn.dev/v1/webhooks/$ENDPOINT_ID/rotate-secret \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "expire_previous_in_seconds": 86400 }'
```

The response has the new `secret`. For `expire_previous_in_seconds`, Talyn signs each request with the new secret and the old secret. The default is 24 hours, and the maximum is 3 days. Thus you can put the new secret on your server after the rotation, with no failed deliveries. Send `0` to stop the old secret at once, for example after a leak.

## Events

`GET /v1/webhook-event-types` lists the event types. An endpoint cannot subscribe to `ping`. Talyn sends `ping` only for `POST /v1/webhooks/{id}/test`.

| Type | When | More fields in `data` |
| --- | --- | --- |
| `session.created` | A session or thread started, in the app or through the API. | |
| `session.updated` | The `status` of a session changed, for example from `provisioning` to `ready` or `error`. | `previous_attributes` |
| `session.archived` | A session was archived. | |
| `session.pull_request_opened` | A pull request was linked to the session. The agent or a person opened it from the session, or linked a pull request that was open before. | `pull_request` |
| `chat.turn_started` | The agent started a turn in a chat. | `turn` |
| `chat.turn_completed` | A turn ended. | `turn`, `final_status` |
| `pull_request.updated` | A tracked pull request changed its title, its draft state or its open state. | `previous_attributes` |
| `pull_request.merged` | A tracked pull request was merged. | |
| `pull_request.closed` | A tracked pull request was closed without a merge. | |
| `merge_queue.blocked` | The merge queue stopped work on a pull request after its fix attempts. A person must act. | `reason`, `attempts` |
| `code_review.completed` | A code review cycle finished. | |

### When Talyn sends an event

- `session.updated`, `session.archived` and the `pull_request` events are changes. Talyn stores the last state that it sent for each session and each pull request. Talyn sends an event when the new state is different.
- When Talyn first sees a session after you add an endpoint, it sends `session.updated` with the current state and empty `previous_attributes`.
- When Talyn first sees a pull request after you add an endpoint, it records the state and sends nothing. Thus Talyn does not send a merge or a close that is the first change it sees for a pull request.
- Talyn does not send `session.updated` for the change to `archived`. It sends `session.archived` instead.
- In `chat.turn_completed`, `final_status` is `idle` (the turn finished or you stopped it), `awaiting_input` (the agent asks a question) or `error`.
- A new endpoint can take up to 30 seconds to get events.

### Event objects

- Session events have the session in `data.object`. It has all the fields of `GET /v1/sessions/{id}`, without `chats`.
- Chat events have the chat in `data.object`, as it was when Talyn made the event. Read the transcript with `GET /v1/chats/{id}/events`.
- Pull request events, `merge_queue.blocked` and `session.pull_request_opened` (in `data.pull_request`) use this short pull request object:

```json
{
  "object": "pull_request",
  "id": "0b9e...",
  "workspace_id": "c0ffee00-0000-4000-8000-000000000001",
  "repository_id": "5b1e...",
  "repository_full_name": "acme/app",
  "number": 412,
  "title": "Make the slowest test faster",
  "state": "merged",
  "draft": false,
  "html_url": "https://github.com/acme/app/pull/412",
  "merged_at": "2026-11-02T11:02:40.000Z"
}
```

- `code_review.completed` uses this code review object. `result` is `ready` when the findings are ready, or `failed` with a `failure_reason`:

```json
{
  "object": "code_review",
  "id": "a71c...",
  "workspace_id": "c0ffee00-0000-4000-8000-000000000001",
  "pull_request_id": "0b9e...",
  "result": "ready",
  "head_sha": "4f2c9e1",
  "open_finding_count": 2,
  "failure_reason": null,
  "finished_at": "2026-11-02T10:12:00.000Z"
}
```

A full `session.updated` event:

```json
{
  "id": "evt_3f8a2c1d9b7e4f60a1c2d3e4f5a6b7c8",
  "type": "session.updated",
  "created_at": "2026-11-02T09:31:12.000Z",
  "workspace_id": "c0ffee00-0000-4000-8000-000000000001",
  "data": {
    "object": {
      "object": "session",
      "id": "7d1c2a4e-0b5f-4c39-9a51-3f6b2d8e9c10",
      "status": "ready",
      "...": "..."
    },
    "previous_attributes": { "status": "provisioning" }
  }
}
```
