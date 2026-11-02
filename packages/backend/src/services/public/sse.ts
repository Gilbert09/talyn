import type { Request, Response } from 'express';
import {
  formatSseEventFrame,
  SSE_KEEPALIVE_FRAME,
  type WorkbenchWsPayloads,
  type WSEvent,
} from '@talyn/shared';
import type { ApiTokenPrincipal } from '../apiTokens.js';
import { subscribeWorkspace } from '../websocket.js';
import { listEvents } from '../workbenches/store.js';
import { PublicApiError } from './errors.js';
import { toPublicChat, toPublicEvent, toPublicSession, type PublicChatRow, type PublicSessionRow } from './projections.js';
import { getChatQuery, getSessionQuery } from './queries.js';

/**
 * Server-sent event streams for `/v1`.
 *
 * Live frames come from the same fan-out the WebSocket clients get
 * (`subscribeWorkspace` in websocket.ts), which includes frames relayed from
 * other replicas through Redis. The database stays the record: a transcript
 * stream replays stored events first, and when a live batch does not follow
 * the last `seq` it sent, it reads the gap from the database. So a frame lost
 * between replicas is a short delay, never a hole.
 */

/** Open streams per token. Each one holds a socket and a fan-out listener. */
export const MAX_STREAMS_PER_TOKEN = 20;
/** Railway's edge closes an idle connection; a comment line keeps it open. */
const DEFAULT_KEEPALIVE_MS = 15_000;
/** Events per database read while catching up. The REST page default. */
const CATCH_UP_PAGE = 500;

let keepaliveMs = DEFAULT_KEEPALIVE_MS;
const openStreams = new Map<string, number>();

export function setSseKeepaliveMsForTests(ms: number | null): void {
  keepaliveMs = ms ?? DEFAULT_KEEPALIVE_MS;
}

export function openStreamCountForTests(tokenId: string): number {
  return openStreams.get(tokenId) ?? 0;
}

/** The `Last-Event-ID` header as a `seq`, or undefined when absent. */
export function lastEventId(req: Request): number | undefined {
  const raw = req.header('last-event-id');
  if (raw === undefined || raw.trim() === '') return undefined;
  const seq = Number(raw.trim());
  if (!Number.isInteger(seq) || seq < 0) {
    throw new PublicApiError(400, 'invalid_parameter', 'Last-Event-ID must be the seq of an event.', { param: 'Last-Event-ID' });
  }
  return seq;
}

interface Stream {
  /** Write a frame; resolves when the socket can take more. */
  write(frame: string): Promise<void>;
  end(reason: string): void;
  readonly closed: boolean;
}

/** Start the response and hold one of the token's stream slots until it closes. */
function openStream(req: Request, res: Response, token: ApiTokenPrincipal, onClose: () => void): Stream {
  const open = openStreams.get(token.tokenId) ?? 0;
  if (open >= MAX_STREAMS_PER_TOKEN) {
    throw new PublicApiError(429, 'too_many_streams', `A token can hold ${MAX_STREAMS_PER_TOKEN} streams at once. Close one first.`);
  }
  openStreams.set(token.tokenId, open + 1);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Stops a buffering proxy from holding frames back.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  const timer = setInterval(() => {
    if (!closed) res.write(SSE_KEEPALIVE_FRAME);
  }, keepaliveMs);
  timer.unref();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    const left = (openStreams.get(token.tokenId) ?? 1) - 1;
    if (left > 0) openStreams.set(token.tokenId, left);
    else openStreams.delete(token.tokenId);
    onClose();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);

  return {
    get closed() {
      return closed;
    },
    async write(frame) {
      if (closed) return;
      if (!res.write(frame)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.on('drain', done);
          res.on('close', done);
        });
      }
    },
    end(reason) {
      if (closed) return;
      res.write(formatSseEventFrame({ event: 'end', data: { reason } }));
      res.end();
      cleanup();
    },
  };
}

/** Run stream work one step at a time, in order. A fault ends the stream. */
function serial(stream: Stream) {
  let chain: Promise<void> = Promise.resolve();
  return (step: () => Promise<void>) => {
    chain = chain.then(async () => {
      if (stream.closed) return;
      try {
        await step();
      } catch (err) {
        console.warn('[public-api] stream step failed:', err instanceof Error ? err.message : err);
        stream.end('error');
      }
    });
  };
}

type Payload<K extends keyof WorkbenchWsPayloads> = WorkbenchWsPayloads[K];

/**
 * `GET /v1/chats/{id}/events/stream`. Replays the stored events after `after`,
 * then follows new ones. Frames: `transcript` (with `id: <seq>`), `chat`, `end`.
 */
export async function streamChatEvents(
  req: Request,
  res: Response,
  input: { token: ApiTokenPrincipal; chat: PublicChatRow; after: number },
): Promise<void> {
  const { chat } = input;
  let lastSeq = input.after;
  let unsubscribe: () => void = () => undefined;
  const stream = openStream(req, res, input.token, () => unsubscribe());
  const run = serial(stream);

  const writeEvents = async (events: Array<{ seq: number; turn: number; event: Record<string, unknown> }>) => {
    for (const e of events) {
      if (e.seq <= lastSeq) continue;
      await stream.write(
        formatSseEventFrame({ id: String(e.seq), event: 'transcript', data: toPublicEvent(chat.id, e) }),
      );
      lastSeq = e.seq;
    }
  };

  const catchUp = async () => {
    for (;;) {
      const { events } = await listEvents(chat.id, lastSeq, CATCH_UP_PAGE);
      await writeEvents(events);
      if (events.length < CATCH_UP_PAGE || stream.closed) return;
    }
  };

  const checkOpen = async () => {
    const [[chatRow], [sessionRow]] = await Promise.all([getChatQuery(chat.id), getSessionQuery(chat.workbenchId)]);
    if (!sessionRow) return stream.end('session_deleted');
    if (!chatRow || chatRow.closedAt) return stream.end('chat_closed');
    if (sessionRow.archivedAt) return stream.end('session_archived');
  };

  unsubscribe = subscribeWorkspace(chat.workspaceId, (event: WSEvent) => {
    switch (event.type) {
      case 'workbench:event': {
        const payload = event.payload as Payload<'workbench:event'>;
        if (payload.chatId !== chat.id) return;
        const events = [...payload.events].sort((a, b) => a.seq - b.seq);
        run(async () => {
          const fresh = events.filter((e) => e.seq > lastSeq);
          if (fresh.length === 0) return;
          // Contiguous with what was sent: write the batch. A gap: read it from the database.
          if (fresh[0].seq === lastSeq + 1) await writeEvents(fresh);
          else await catchUp();
        });
        return;
      }
      case 'workbench:chat': {
        const payload = event.payload as Payload<'workbench:chat'>;
        if (payload.chat.id !== chat.id) return;
        run(async () => {
          const [row] = await getChatQuery(chat.id);
          if (!row) return stream.end('chat_closed');
          await stream.write(formatSseEventFrame({ event: 'chat', data: toPublicChat(row) }));
        });
        return;
      }
      case 'workbench:updated': {
        const payload = event.payload as Payload<'workbench:updated'>;
        if (payload.workbench.id === chat.workbenchId) run(checkOpen);
        return;
      }
      case 'workbench:deleted': {
        const payload = event.payload as Payload<'workbench:deleted'>;
        if (payload.id === chat.workbenchId) run(async () => stream.end('session_deleted'));
        return;
      }
    }
  });
  if (stream.closed) unsubscribe();

  run(catchUp);
  run(checkOpen);
}

/**
 * `GET /v1/sessions/{id}/stream`. Frames: `session.updated` (first with the
 * current state), `chat.updated`, `end`. No ids: the REST reads are the record.
 */
export async function streamSession(
  req: Request,
  res: Response,
  input: { token: ApiTokenPrincipal; session: PublicSessionRow },
): Promise<void> {
  const sessionId = input.session.id;
  let unsubscribe: () => void = () => undefined;
  const stream = openStream(req, res, input.token, () => unsubscribe());
  const run = serial(stream);

  const sendSession = async () => {
    const [row] = await getSessionQuery(sessionId);
    if (!row) return stream.end('session_deleted');
    await stream.write(formatSseEventFrame({ event: 'session.updated', data: toPublicSession(row) }));
  };

  unsubscribe = subscribeWorkspace(input.session.workspaceId, (event: WSEvent) => {
    switch (event.type) {
      case 'workbench:updated': {
        const payload = event.payload as Payload<'workbench:updated'>;
        if (payload.workbench.id === sessionId) run(sendSession);
        return;
      }
      case 'workbench:chat': {
        const payload = event.payload as Payload<'workbench:chat'>;
        if (payload.chat.workbenchId !== sessionId) return;
        const chatId = payload.chat.id;
        run(async () => {
          const [row] = await getChatQuery(chatId);
          if (row) await stream.write(formatSseEventFrame({ event: 'chat.updated', data: toPublicChat(row) }));
        });
        return;
      }
      case 'workbench:deleted': {
        const payload = event.payload as Payload<'workbench:deleted'>;
        if (payload.id === sessionId) run(async () => stream.end('session_deleted'));
        return;
      }
    }
  });
  if (stream.closed) unsubscribe();

  run(sendSession);
}
