# Webhooks

A webhook endpoint is a URL on your server. Talyn sends an HTTP `POST` to it when something happens in your workspaces, for example when a session is ready or a turn ends. You do not have to poll.

Each request is signed with the [Standard Webhooks](https://www.standardwebhooks.com) scheme. Any Standard Webhooks library can verify it.

You need the `webhooks:write` scope to create endpoints. The `webhooks:read` scope lets you read endpoints and their deliveries.

The token form in the app does not offer the `webhooks` scopes yet.

## Create an endpoint

```bash
curl -s https://api.talyn.dev/v1/webhooks \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "url": "https://example.com/talyn/webhooks",
    "description": "CI bot",
    "event_types": ["session.updated", "chat.turn_completed", "pull_request.merged"]
  }'
```

```json
{
  "object": "webhook_endpoint",
  "id": "4b0d7d1e-2f0c-4f43-9a0e-6f3a1c2b9d10",
  "workspace_id": null,
  "url": "https://example.com/talyn/webhooks",
  "description": "CI bot",
  "event_types": ["session.updated", "chat.turn_completed", "pull_request.merged"],
  "enabled": true,
  "disabled_reason": null,
  "disabled_at": null,
  "consecutive_failures": 0,
  "failing_since": null,
  "created_at": "2026-11-02T09:30:00.000Z",
  "updated_at": "2026-11-02T09:30:00.000Z",
  "secret": "whsec_kT0p..."
}
```

- `secret` is the signing secret. The API shows it in this answer and after a rotation only. Store it now.
- `event_types` empty or absent means all events, also events that Talyn adds later.
- `workspace_id` absent means all of your workspaces. Set it to receive the events of one workspace only.
- A token bound to workspaces must name one of its workspaces. A token bound to exactly one workspace can leave `workspace_id` out; the endpoint then gets that workspace.
- An account can have 20 endpoints. Each endpoint gets its own copy of each event. If you need more receivers, fan out from one of your endpoints.

Send `POST /webhooks/{id}/test` to send a `ping` event now. Then read the delivery to see the answer of your server.

## Which URLs are allowed

- The URL must use `https`.
- The URL can have 2048 characters at most.
- The URL must not contain a user name, a password or a fragment (`#`).
- The host must be on the public internet. Talyn refuses private, loopback, link-local, CGNAT and cloud metadata addresses, in IPv4 and IPv6. This includes IPv4 addresses inside IPv6 addresses.
- Talyn checks the URL when you create or change the endpoint. Talyn also checks the address again before each delivery, because DNS can change.
- Talyn does not follow redirects. A `3xx` answer is a failed attempt.

A URL that is not allowed gives `400` with the code `invalid_webhook_url`.

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
| `id` | The event id. It is also the `webhook-id` header. It is the same for each retry and each redelivery. |
| `type` | The event type, for example `session.updated`. |
| `created_at` | When Talyn made the event. |
| `workspace_id` | The workspace of the event. Null for a `ping` to an endpoint that has no workspace. |
| `data.object` | The object that the event is about. Sessions and chats have the same shape as in the REST API. |

Some events have more fields in `data`, for example `previous_attributes` or `turn`. The catalogue below lists them. New fields can appear. Ignore fields that you do not know.

## Answer quickly

- Answer with a `2xx` status within 10 seconds. Talyn records any other answer as a failed attempt.
- Do the work after you answer. For example, put the event in a queue, answer `200`, then process the event.
- The body of your answer is ignored.

## Verify the signature

Verify each request before you use it. The signed content is `{webhook-id}.{webhook-timestamp}.{raw body}`. The key is the secret without `whsec_`, decoded from base64. The signature is HMAC-SHA256, in base64.

- Use the RAW body, as the bytes arrived. Do not parse and serialize it again: that changes the bytes.
- Refuse a timestamp that is more than 5 minutes from your clock. This stops a replay of an old request.
- The header can hold more than one signature, separated by spaces (see [rotate the secret](#rotate-the-secret)). Accept the request when one of them matches.

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

## Handle each event once

Talyn sends each event at least once. A network fault after your server answered can cause a second delivery of the same event. A redelivery also sends the same event again.

- Use `webhook-id` (the same as the body's `id`) as the key.
- Store the ids that you processed. Skip an id that you have already processed.
- Keep the ids for at least 2 days. Retries continue for about 28 hours.

Talyn does not promise the order of events. Two events can arrive in the opposite order. When the order matters, compare `created_at`, or read the object again from the REST API, for example `GET /sessions/{id}`.

## Retries

Talyn retries a failed attempt. A failed attempt is an answer that is not `2xx`, no answer within 10 seconds, a network error, or an address that is not allowed.

| Attempt | Wait before it |
| --- | --- |
| 1 | none |
| 2 | 5 seconds |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |
| 6 | 5 hours |
| 7 | 10 hours |
| 8 | 10 hours |

After attempt 8 fails, the delivery status is `failed`. The waits are a little longer in practice, because the worker looks for due deliveries every few seconds.

### When Talyn disables an endpoint

- An answer of `410 Gone` disables the endpoint at once. Use it when you remove your receiver.
- If every attempt fails for 3 days, and at least 10 attempts failed in a row, Talyn disables the endpoint. One success resets the count.
- A disabled endpoint has `enabled: false` and a `disabled_reason`. Its pending deliveries change to `abandoned`.
- To start again, fix your receiver, then send `PATCH /webhooks/{id}` with `{"enabled": true}`. This also resets the failure count. Talyn does not send the events of the time when the endpoint was disabled.

## Deliveries

Each event to each endpoint is one delivery.

```bash
curl -s "https://api.talyn.dev/v1/webhooks/$ENDPOINT_ID/deliveries?status=failed" \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

| `status` | Meaning |
| --- | --- |
| `pending` | Waiting for an attempt. `next_attempt_at` says when. |
| `succeeded` | Your server answered `2xx`. |
| `failed` | All attempts failed, or your server answered `410`. |
| `abandoned` | The endpoint was disabled before the delivery succeeded. |

- A list item has no payload. `GET /webhook-deliveries/{id}` gives the delivery with its `payload`.
- `last_response_status`, `last_error` and `last_response_ms` describe the last attempt.
- `POST /webhook-deliveries/{id}/redeliver` sends a delivery again, from attempt 1, with the same `webhook-id`. It is refused while the delivery is `pending`, and when the endpoint is disabled.
- Talyn keeps deliveries for 30 days.

## Rotate the secret

```bash
curl -s https://api.talyn.dev/v1/webhooks/$ENDPOINT_ID/rotate-secret \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "expire_previous_in_seconds": 86400 }'
```

The answer has the new `secret`. For `expire_previous_in_seconds` (default 24 hours, at most 3 days), Talyn signs each request with the new secret AND the old secret. So you can deploy the new secret to your server after the rotation, with no failed deliveries. Send `0` to stop the old secret at once, for example after a leak.

## Event catalogue

`GET /webhook-event-types` lists the event types. An endpoint cannot subscribe to `ping`. Talyn sends `ping` only for `POST /webhooks/{id}/test`.

| Type | When | More fields in `data` |
| --- | --- | --- |
| `session.created` | A session or thread was started, in the app or through the API. | |
| `session.updated` | The `status` of a session changed, for example `provisioning` to `ready` or `error`. | `previous_attributes` |
| `session.archived` | A session was archived. | |
| `session.pull_request_opened` | A pull request was linked to the session: the agent or a person opened it from the session, or linked an existing one. | `pull_request` |
| `chat.turn_started` | The agent started a turn in a chat. | `turn` |
| `chat.turn_completed` | A turn ended. | `turn`, `final_status` |
| `pull_request.updated` | A tracked pull request changed its title, its draft state or its open state (a reopen). | `previous_attributes` |
| `pull_request.merged` | A tracked pull request was merged. | |
| `pull_request.closed` | A tracked pull request was closed without a merge. | |
| `merge_queue.blocked` | The merge queue stopped work on a pull request after its fix attempts. A person must act. | `reason`, `attempts` |
| `code_review.completed` | A code review cycle finished. | |

### How Talyn decides to send an event

- `session.updated`, `session.archived` and `pull_request.*` are changes. Talyn stores the last state that it announced for each session and each pull request, and sends an event when the new state is different.
- The first time Talyn sees a session after you add an endpoint, it sends `session.updated` with the current state and empty `previous_attributes`.
- The first time Talyn sees a pull request after you add an endpoint, it records the state and sends nothing. Pull requests change on every check run, and a first event for each of them has no news. A merge or a close that is the first change Talyn sees for a pull request is therefore not sent.
- `session.updated` is not sent for the change to `archived`. `session.archived` is sent for it.
- `chat.turn_completed` `final_status` is `idle` (the turn finished or was cancelled), `awaiting_input` (the agent asks a question) or `error`.
- A new endpoint can take up to 30 seconds to receive events.

### Examples

`session.updated`:

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
      "workspace_id": "c0ffee00-0000-4000-8000-000000000001",
      "kind": "session",
      "repository_full_name": "acme/app",
      "branch": "talyn/faster-tests",
      "agent": "claude",
      "status": "ready",
      "pull_request_id": null,
      "created_at": "2026-11-02T09:30:00.000Z",
      "updated_at": "2026-11-02T09:31:12.000Z"
    },
    "previous_attributes": { "status": "provisioning" }
  }
}
```

The session object has all the fields of `GET /sessions/{id}`, without `chats`. The example leaves some out.

`chat.turn_completed`:

```json
{
  "id": "evt_9b1f...",
  "type": "chat.turn_completed",
  "created_at": "2026-11-02T09:40:02.000Z",
  "workspace_id": "c0ffee00-0000-4000-8000-000000000001",
  "data": {
    "object": {
      "object": "chat",
      "id": "5e2b...",
      "session_id": "7d1c2a4e-0b5f-4c39-9a51-3f6b2d8e9c10",
      "status": "idle",
      "turn_count": 1,
      "queued_message_count": 0
    },
    "turn": 1,
    "final_status": "idle"
  }
}
```

`data.object` is the chat when Talyn made the event. Read the transcript with `GET /chats/{id}/events`.

`pull_request.merged`:

```json
{
  "id": "evt_41aa...",
  "type": "pull_request.merged",
  "created_at": "2026-11-02T11:02:41.000Z",
  "workspace_id": "c0ffee00-0000-4000-8000-000000000001",
  "data": {
    "object": {
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
  }
}
```

`pull_request.updated` has the same object and `previous_attributes`, for example `{ "title": "WIP", "draft": true }`. `session.pull_request_opened` has the session in `data.object` and this pull request object in `data.pull_request`.

`merge_queue.blocked`:

```json
{
  "type": "merge_queue.blocked",
  "data": {
    "object": { "object": "pull_request", "number": 412, "state": "open", "...": "..." },
    "reason": "merge conflicts with the base branch",
    "attempts": 3
  }
}
```

`code_review.completed`:

```json
{
  "type": "code_review.completed",
  "data": {
    "object": {
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
  }
}
```

`result` is `ready` when the findings are ready, or `failed` with a `failure_reason`.

`ping`:

```json
{
  "id": "evt_77c0...",
  "type": "ping",
  "created_at": "2026-11-02T09:30:05.000Z",
  "workspace_id": null,
  "data": { "object": { "object": "webhook_endpoint", "id": "4b0d7d1e-2f0c-4f43-9a0e-6f3a1c2b9d10", "...": "..." } }
}
```
