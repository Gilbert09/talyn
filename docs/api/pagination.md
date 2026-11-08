# Pagination

List endpoints use cursors. Two kinds of list exist:

- Object lists, for example workspaces, repositories and sessions. They use `limit` and `cursor`.
- The event list for a chat. It uses `after`, `before` and `limit`. See [Event pages](#event-pages).

## Object lists

These endpoints return an object list:

- `GET /workspaces`
- `GET /repositories`
- `GET /teams`
- `GET /spaces`
- `GET /spaces/{id}/sessions`
- `GET /sessions`
- `GET /sessions/{id}/sessions`
- `GET /pull-requests`
- `GET /memories`
- `GET /webhooks`
- `GET /webhooks/{id}/deliveries`

The list has this shape.

```json
{
  "object": "list",
  "data": [ { "object": "workspace", "id": "..." } ],
  "has_more": true,
  "next_cursor": "eyJ0IjoiMjAyNi0xMS0wMlQwOTozMDowMC4xMjM0NTZaIiwiaWQiOiIuLi4ifQ"
}
```

| Field | Meaning |
| --- | --- |
| `data` | The items of this page. |
| `has_more` | `true` if more items exist. |
| `next_cursor` | Pass this value as `cursor` to get the next page. `null` on the last page. |

`GET /spaces/{id}/sessions` also has `hidden_count`. It counts the sessions on this page that you cannot see.

### Lists with one page

Some lists are never paged. They take no `limit` or `cursor`. `has_more` is `false` and `next_cursor` is `null`. Examples are `GET /merge-queue`, `GET /pull-requests/{id}/code-reviews`, `GET /webhook-event-types`, `GET /sessions/{id}/scripts`, `GET /sessions/{id}/previews`, `GET /chats/{id}/queue` and `GET /chats/{id}/checkpoints`.

The history lists `GET /pull-requests/{id}/merge-queue/events` and `GET /code-reviews/{id}/events` have only `object` and `data`. They give the newest events first: at most 100 merge-queue events, or 200 code review events.

### Order

Items are newest first. The order is by creation time. Items with the same creation time are ordered by `id`.

### Parameters

| Parameter | Meaning |
| --- | --- |
| `limit` | Items per page. 1 to 200. Default 50. |
| `cursor` | The `next_cursor` of the previous page. Leave it out for the first page. |

An invalid `limit` answers `400` `invalid_parameter`. An invalid `cursor` answers `400` `invalid_cursor`.

### Cursors are opaque

Do not parse a cursor. Do not build one. Do not store one for a long time. Pass back exactly the value that you received. The format can change.

Use the same filters on each request of one walk. A cursor works with the filters of the request that made it.

### Example

```bash
curl -s "https://api.talyn.dev/v1/sessions?workspace_id=$WORKSPACE_ID&limit=100" \
  -H "Authorization: Bearer $TALYN_TOKEN"

curl -s "https://api.talyn.dev/v1/sessions?workspace_id=$WORKSPACE_ID&limit=100&cursor=$NEXT_CURSOR" \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

### Walk all pages in TypeScript

```ts
interface List<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

async function* paginate<T>(path: string, params: Record<string, string> = {}): AsyncGenerator<T> {
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "100", ...params });
    if (cursor) query.set("cursor", cursor);
    const res = await fetch(`https://api.talyn.dev/v1${path}?${query}`, {
      headers: { Authorization: `Bearer ${process.env.TALYN_TOKEN}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.json()).error.code}`);
    const page = (await res.json()) as List<T>;
    yield* page.data;
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
}

for await (const session of paginate<{ id: string; status: string }>("/sessions", {
  workspace_id: process.env.WORKSPACE_ID!,
})) {
  console.log(session.id, session.status);
}
```

### Filters on `GET /sessions`

| Parameter | Meaning |
| --- | --- |
| `workspace_id` | Required, unless the token is bound to exactly one workspace. |
| `status` | Comma-separated statuses: `provisioning`, `ready`, `moving`, `error`, `archived`, `archive_error`. |
| `kind` | Comma-separated kinds. Default `session`. |
| `include_archived` | `true` to include archived sessions. Default `false`. A `status` of `archived` turns it on. |

## Event pages

`GET /chats/{id}/events` returns the transcript of a chat in pages.

```json
{
  "object": "list",
  "data": [ { "object": "event", "chat_id": "...", "seq": 1, "turn": 1, "type": "user", "data": {} } ],
  "has_more": false,
  "first_seq": 1,
  "last_seq": 1
}
```

Each event has a `seq`. The `seq` is gap-free and increases by 1 in a chat.

| Parameter | Meaning |
| --- | --- |
| `after` | Events with a `seq` greater than this value, oldest first. Default 0. |
| `before` | `latest` for the newest page. Or a `seq` for the page before it. |
| `limit` | Events per page. 1 to 2000. Default 500. |

Send `after` or `before`. Do not send both. If you send both, the answer is `400` `invalid_parameter`.

### Forward

Use `after` to read from the start or to poll for new events. Set the next `after` to `last_seq`. `has_more` is `true` when more events follow.

```bash
curl -s "https://api.talyn.dev/v1/chats/$CHAT_ID/events?after=0&limit=500" \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

When the page is empty, `last_seq` is the same as the `after` that you sent.

### Backward

Use `before=latest` to read the end of a long transcript first. Then use `before=<seq>` to go back. A backward page starts at the start of a turn. It can have more events than `limit`, up to 2000. A very long turn can be cut at that maximum. The events in a page are oldest first. Page back with `first_seq`. `has_more` is `true` when older events exist. `first_seq` is the `seq` of the oldest event in the page.

```bash
curl -s "https://api.talyn.dev/v1/chats/$CHAT_ID/events?before=latest&limit=200" \
  -H "Authorization: Bearer $TALYN_TOKEN"

curl -s "https://api.talyn.dev/v1/chats/$CHAT_ID/events?before=$FIRST_SEQ&limit=200" \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

### Read a whole transcript in TypeScript

```ts
interface ChatEvent {
  seq: number;
  turn: number;
  type: string;
  data: Record<string, unknown>;
}

async function readTranscript(chatId: string): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  let after = 0;
  for (;;) {
    const res = await fetch(`https://api.talyn.dev/v1/chats/${chatId}/events?after=${after}&limit=500`, {
      headers: { Authorization: `Bearer ${process.env.TALYN_TOKEN}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.json()).error.code}`);
    const page = await res.json();
    events.push(...page.data);
    if (!page.has_more) return events;
    after = page.last_seq;
  }
}
```

To follow a running turn, use the [stream](streaming.md). Do not poll more than once each second.
