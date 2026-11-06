import type { WorkbenchEffort } from '@talyn/shared';
import {
  Chat,
  EventPage,
  IdParams,
  ListEventsQuery,
  MAX_EVENT_PAGE,
  MessageReceipt,
  SendMessageBody,
  StreamEventsQuery,
} from '../../schemas/public/resources.js';
import { authorizedChat, authorizedReadableChat, authorizedSession, refuseLocalRuntime } from '../../services/public/authorize.js';
import { PublicApiError, notFound } from '../../services/public/errors.js';
import { toPublicChat, toPublicEvent } from '../../services/public/projections.js';
import { getChatQuery } from '../../services/public/queries.js';
import { lastEventId, streamChatEvents } from '../../services/public/sse.js';
import { listEvents, listOlderEvents } from '../../services/workbenches/store.js';
import { cancelTurn, sendMessage } from '../../services/workbenches/turns.js';
import { definePublicRoute, type PublicRoute } from './define.js';

/** A chat is one agent conversation in a session. Its transcript is a list of events numbered by `seq`. */
export const chatRoutes: PublicRoute[] = [
  definePublicRoute({
    method: 'get',
    path: '/chats/{id}',
    operationId: 'getChat',
    summary: 'Get a chat',
    tag: 'Chats',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The chat.', schema: Chat } },
    async handler({ params, token }) {
      return { status: 200, body: toPublicChat(await authorizedReadableChat(token, params.id)) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/chats/{id}/messages',
    operationId: 'sendMessage',
    summary: 'Send a message',
    description:
      'Starts a turn, or queues the message behind the running turn. While the session is still provisioning, ' +
      'the message waits for the sandbox. Follow the reply on the events endpoints.',
    tag: 'Chats',
    scope: 'sessions:write',
    sessions: true,
    creates: true,
    params: IdParams,
    body: SendMessageBody,
    responses: { 202: { description: 'The message is accepted.', schema: MessageReceipt } },
    async handler({ params, body, token }) {
      const sentAt = new Date().toISOString();
      const chat = await authorizedChat(token, params.id);
      refuseLocalRuntime(await authorizedSession(token, chat.workbenchId));
      if (chat.closedAt) throw new PublicApiError(409, 'chat_closed', 'This chat is closed.');
      const { queued } = await sendMessage(chat.id, {
        text: body.text,
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.effort !== undefined ? { effort: body.effort as WorkbenchEffort } : {}),
        ...(body.plan_mode !== undefined ? { planMode: body.plan_mode } : {}),
      }, { sentAt });
      return { status: 202, body: { object: 'message_receipt', chat_id: chat.id, queued } };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/chats/{id}/cancel',
    operationId: 'cancelChat',
    summary: 'Stop the running turn',
    description: 'Stops the agent. The transcript so far stays. Messages queued behind the turn start after it.',
    tag: 'Chats',
    scope: 'sessions:write',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The chat.', schema: Chat } },
    async handler({ params, token }) {
      const chat = await authorizedChat(token, params.id);
      refuseLocalRuntime(await authorizedSession(token, chat.workbenchId));
      await cancelTurn(chat.id);
      const [row] = await getChatQuery(chat.id);
      if (!row) throw notFound('chat');
      return { status: 200, body: toPublicChat(row) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/chats/{id}/events',
    operationId: 'listChatEvents',
    summary: 'Read a transcript page',
    description:
      'Forward with `after` (oldest first; poll with the returned `last_seq`), or backward with `before` ' +
      '(`latest`, or a `seq`), which returns whole turns. Poll no more than once a second; to follow a running turn, use the stream.',
    tag: 'Events',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    query: ListEventsQuery,
    responses: { 200: { description: 'A page of events.', schema: EventPage } },
    async handler({ params, query, token }) {
      const chat = await authorizedReadableChat(token, params.id);
      if (query.before !== undefined) {
        if (query.after !== undefined) throw new PublicApiError(400, 'invalid_parameter', 'Send after or before, not both.', { param: 'before' });
        const page = await listOlderEvents(chat.id, query.before === 'latest' ? null : query.before, query.limit, MAX_EVENT_PAGE);
        return {
          status: 200,
          body: {
            object: 'list',
            data: page.events.map((e) => toPublicEvent(chat.id, e)),
            has_more: page.hasOlder,
            first_seq: page.oldestSeq,
            last_seq: page.events.length > 0 ? page.cursor : null,
          },
        };
      }
      const after = query.after ?? 0;
      // One more than asked, to know whether there is a next page.
      const { events } = await listEvents(chat.id, after, query.limit + 1);
      const page = events.slice(0, query.limit);
      return {
        status: 200,
        body: {
          object: 'list',
          data: page.map((e) => toPublicEvent(chat.id, e)),
          has_more: events.length > query.limit,
          first_seq: page.length > 0 ? page[0].seq : null,
          last_seq: page.length > 0 ? page[page.length - 1].seq : after,
        },
      };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/chats/{id}/events/stream',
    operationId: 'streamChatEvents',
    summary: 'Stream a transcript',
    description:
      'Server-sent events. Each `transcript` frame is one event, with `id:` set to its `seq`. On connect the stream ' +
      'sends the stored events after `after` (or after the `Last-Event-ID` header), then new events as they arrive. ' +
      '`chat` frames carry the chat when its status changes. An `end` frame closes the stream when the chat is closed ' +
      'or the session is archived or deleted. A comment line (`: ping`) every 15 seconds keeps the connection open.',
    tag: 'Events',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    query: StreamEventsQuery,
    responses: { 200: { description: 'A `text/event-stream`.', contentType: 'text/event-stream' } },
    async handler({ req, res, params, query, token }) {
      const chat = await authorizedReadableChat(token, params.id);
      const after = lastEventId(req) ?? query.after ?? 0;
      await streamChatEvents(req, res, { token, chat, after });
    },
  }),
];
