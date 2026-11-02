# Streaming

The API has two server-sent event (SSE) streams. Both need the scope `sessions:read`.

- Use the **transcript stream** to watch what the agent says and does in one chat: each message, tool call and tool result.
- Use the **session stream** to learn when the session itself changes: its status, a new chat, a turn that starts or ends, or a linked pull request. It does not send the agent's output.

To be told about changes without an open connection, use [webhooks](webhooks.md).

| Stream | Path | Use |
| --- | --- | --- |
| Transcript | `GET /chats/{id}/events/stream` | Follow what the agent does in one chat. |
| Session | `GET /sessions/{id}/stream` | Follow changes to a session and its chats. |

Each stream sends a `: ping` comment line every 15 seconds. This keeps the connection open. Ignore these lines.

A token can hold 20 open streams. The 21st request answers `429` `too_many_streams`.

## Transcript stream

```bash
curl -N https://api.talyn.dev/v1/chats/$CHAT_ID/events/stream \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

On connect, the stream sends the stored events after a start point. Then it sends new events as they arrive. There is no hole between the two parts.

### Frames

| Event | `id:` | `data` |
| --- | --- | --- |
| `transcript` | The `seq` of the event | One event object |
| `chat` | none | The chat object. Sent when the chat status changes. |
| `end` | none | `{"reason": "..."}`. The server closes the stream after it. |

```text
id: 7
event: transcript
data: {"object":"event","chat_id":"...","seq":7,"turn":2,"type":"assistant","data":{...}}

event: chat
data: {"object":"chat","id":"...","status":"idle", ...}

event: end
data: {"reason":"chat_closed"}
```

The `data` field of an event is the agent event in Claude Code stream-json format. Codex output is converted to the same format. New fields can appear. Ignore fields that you do not know.

### End reasons

| `reason` | Meaning |
| --- | --- |
| `chat_closed` | The chat is closed. |
| `session_archived` | The session is archived. |
| `session_deleted` | The session is deleted. |
| `error` | The stream failed on the server side. Reconnect. |

After `end`, do not reconnect, unless the reason is `error`.

### Start point and reconnect

The stream starts after a `seq`. Use one of these:

- The `Last-Event-ID` header. This is the header that an SSE client sends when it reconnects.
- The `after` query parameter.

If you send both, the header wins. If you send neither, the stream starts at the first event (`after=0`).

When the connection drops, reconnect with `Last-Event-ID` set to the `id` of the last event that you got. The stream then continues with the next `seq`. You get no duplicates and no gaps.

An invalid `Last-Event-ID` answers `400` `invalid_parameter`.

```bash
curl -N https://api.talyn.dev/v1/chats/$CHAT_ID/events/stream \
  -H "Authorization: Bearer $TALYN_TOKEN" \
  -H "Last-Event-ID: 7"
```

### TypeScript reader

`EventSource` cannot send an `Authorization` header. This code reads the stream with `fetch`. It parses `id:`, `event:` and `data:` lines. A blank line ends a frame. It reconnects with `Last-Event-ID`.

```ts
interface SseFrame {
  id?: string;
  event: string;
  data: string;
}

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  let frame: SseFrame = { event: "message", data: "" };
  let hasData = false;

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.search(/\r\n|\n|\r/)) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + (buffer.startsWith("\r\n", newline) ? 2 : 1));

      if (line === "") {
        // A blank line ends the frame.
        if (hasData) yield { ...frame, data: frame.data.replace(/\n$/, "") };
        frame = { event: "message", data: "" };
        hasData = false;
      } else if (line.startsWith(":")) {
        // A comment, such as ": ping". Ignore it.
      } else {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "id") frame.id = value;
        else if (field === "event") frame.event = value;
        else if (field === "data") {
          frame.data += value + "\n";
          hasData = true;
        }
      }
    }
  }
}

async function followChat(chatId: string, onEvent: (event: { seq: number; type: string; data: unknown }) => void) {
  let lastEventId: string | undefined;
  let attempt = 0;

  for (;;) {
    try {
      const res = await fetch(`https://api.talyn.dev/v1/chats/${chatId}/events/stream`, {
        headers: {
          Authorization: `Bearer ${process.env.TALYN_TOKEN}`,
          Accept: "text/event-stream",
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
        },
      });
      if (!res.ok || !res.body) {
        const { error } = await res.json();
        // Do not retry a refusal such as 401, 403 or 404.
        if (res.status < 500 && res.status !== 429) throw new Error(`${res.status} ${error.code}`);
        throw new TypeError(`${res.status} ${error.code}`);
      }
      attempt = 0;

      for await (const frame of readSse(res.body)) {
        if (frame.event === "transcript") {
          lastEventId = frame.id;
          onEvent(JSON.parse(frame.data));
        } else if (frame.event === "end") {
          const { reason } = JSON.parse(frame.data);
          if (reason !== "error") return reason;
          break; // Reconnect.
        }
      }
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
    }
    // The connection dropped. Wait, then reconnect with Last-Event-ID.
    await new Promise((r) => setTimeout(r, Math.min(30, 2 ** attempt++) * 1000));
  }
}

const reason = await followChat(process.env.CHAT_ID!, (e) => console.log(e.seq, e.type));
console.log("Stream ended:", reason);
```

The function returns when the server sends an `end` frame, unless the reason is `error`.

## Session stream

```bash
curl -N https://api.talyn.dev/v1/sessions/$SESSION_ID/stream \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

| Event | `data` |
| --- | --- |
| `session.updated` | The session object. The first frame has the current state. Later frames follow each change. |
| `chat.updated` | The chat object, when one of the chats of the session changes. |
| `end` | `{"reason": "..."}`, for example `session_deleted`. The server closes the stream after it. |

```text
event: session.updated
data: {"object":"session","id":"...","status":"provisioning", ...}

event: session.updated
data: {"object":"session","id":"...","status":"ready", ...}

event: chat.updated
data: {"object":"chat","id":"...","status":"running", ...}
```

These frames have no `id:`. `Last-Event-ID` does nothing here. After a reconnect, the first `session.updated` frame gives the current state. To read the chats again, call `GET /sessions/{id}`. The `session.updated` frame does not include the `chats` array.

### TypeScript

This code uses `readSse` from the transcript example.

```ts
async function watchSession(sessionId: string, until: (status: string) => boolean) {
  const res = await fetch(`https://api.talyn.dev/v1/sessions/${sessionId}/stream`, {
    headers: { Authorization: `Bearer ${process.env.TALYN_TOKEN}`, Accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) throw new Error(`${res.status} ${(await res.json()).error.code}`);

  for await (const frame of readSse(res.body)) {
    if (frame.event === "session.updated") {
      const session = JSON.parse(frame.data);
      console.log("session", session.status);
      if (until(session.status)) return session;
    } else if (frame.event === "chat.updated") {
      const chat = JSON.parse(frame.data);
      console.log("chat", chat.id, chat.status);
    } else if (frame.event === "end") {
      return null;
    }
  }
  return null;
}

await watchSession(process.env.SESSION_ID!, (status) => status === "ready");
```

## Polling fallback

If you cannot hold a connection open, poll `GET /chats/{id}/events`. Set `after` to the `last_seq` of the previous page.

```bash
curl -s "https://api.talyn.dev/v1/chats/$CHAT_ID/events?after=7" \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

Poll no more than once each second. If `has_more` is `true`, ask again at once for the next page. An empty page returns the same `last_seq` that you sent.

```ts
async function poll(chatId: string, onEvent: (e: { seq: number; type: string }) => void, signal: AbortSignal) {
  let after = 0;
  while (!signal.aborted) {
    const res = await fetch(`https://api.talyn.dev/v1/chats/${chatId}/events?after=${after}`, {
      headers: { Authorization: `Bearer ${process.env.TALYN_TOKEN}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.json()).error.code}`);
    const page = await res.json();
    for (const e of page.data) onEvent(e);
    after = page.last_seq ?? after;
    if (!page.has_more) await new Promise((r) => setTimeout(r, 1500));
  }
}
```

To check the chat state, call `GET /chats/{id}`. The `status` is `idle`, `running`, `awaiting_input` or `error`.

## Read the end of a transcript first

For a long chat, page backward. Use `before=latest` for the newest turns. Then use `before=<first_seq>` for older turns. See [pagination](pagination.md#backward).

```bash
curl -s "https://api.talyn.dev/v1/chats/$CHAT_ID/events?before=latest&limit=100" \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

Then open the stream with `after` set to the last `seq` that you read. The stream sends only newer events.

```bash
curl -N "https://api.talyn.dev/v1/chats/$CHAT_ID/events/stream?after=$LAST_SEQ" \
  -H "Authorization: Bearer $TALYN_TOKEN"
```

## Proxies

The server sends `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform`. If a proxy of yours buffers the stream, turn off buffering for this path.
