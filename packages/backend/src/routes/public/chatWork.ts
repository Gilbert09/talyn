import type { WorkbenchEffort } from '@talyn/shared';
import { Chat, IdParams } from '../../schemas/public/resources.js';
import {
  CheckpointList,
  CheckpointParams,
  QueuedMessageList,
  QueuedMessageParams,
  UpdateChatBody,
} from '../../schemas/public/sessionWork.js';
import type { ApiTokenPrincipal } from '../../services/apiTokens.js';
import { authorizedChat, authorizedSession, refuseLocalRuntime } from '../../services/public/authorize.js';
import { notFound } from '../../services/public/errors.js';
import { toPublicChat } from '../../services/public/projections.js';
import { getChatQuery } from '../../services/public/queries.js';
import { toPublicCheckpoint, toPublicQueuedMessage } from '../../services/public/workProjections.js';
import { queuedMessagesQuery } from '../../services/public/workQueries.js';
import { clearQueuedMessages, closeChat, dropQueuedMessage, patchChat } from '../../services/workbenches/sessionOps.js';
import { getChat, getWorkbench, listCheckpoints, type ChatRow, type WorkbenchRow } from '../../services/workbenches/store.js';
import { restoreCheckpoint } from '../../services/workbenches/turns.js';
import { definePublicRoute, type PublicRoute } from './define.js';

/** A chat the token can change: reachable, and on a sandbox session. Full rows for the services. */
async function writableChat(token: ApiTokenPrincipal, id: string): Promise<{ chat: ChatRow; workbench: WorkbenchRow }> {
  const pub = await authorizedChat(token, id);
  refuseLocalRuntime(await authorizedSession(token, pub.workbenchId));
  const [chat, workbench] = await Promise.all([getChat(pub.id), getWorkbench(pub.workbenchId)]);
  if (!chat || !workbench) throw notFound('chat');
  return { chat, workbench };
}

async function publicChat(id: string) {
  const [row] = await getChatQuery(id);
  if (!row) throw notFound('chat');
  return toPublicChat(row);
}

async function queuedMessages(chatId: string) {
  const [row] = await queuedMessagesQuery(chatId);
  return (row?.messages ?? []).map((m) => toPublicQueuedMessage(chatId, m));
}

/** Chat extras: rename and settings, close, the message queue, checkpoints. */
export const chatWorkRoutes: PublicRoute[] = [
  definePublicRoute({
    method: 'patch',
    path: '/chats/{id}',
    operationId: 'updateChat',
    summary: 'Update a chat',
    description: 'Rename the chat, or change the model, effort or plan mode its next turns use. Send only the fields to change.',
    tag: 'Chats',
    scope: 'sessions:write',
    sessions: true,
    params: IdParams,
    body: UpdateChatBody,
    responses: { 200: { description: 'The chat.', schema: Chat } },
    async handler({ params, body, token }) {
      const { chat } = await writableChat(token, params.id);
      const patch: Parameters<typeof patchChat>[1] = {};
      if (body.title !== undefined) patch.title = body.title.trim().slice(0, 200);
      if (body.model !== undefined) patch.model = body.model?.trim() || null;
      if (body.effort !== undefined) patch.effort = body.effort as WorkbenchEffort | null;
      if (body.plan_mode !== undefined) patch.planMode = body.plan_mode;
      if (Object.keys(patch).length > 0) await patchChat(chat, patch);
      return { status: 200, body: await publicChat(chat.id) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/chats/{id}/close',
    operationId: 'closeChat',
    summary: 'Close a chat',
    description: 'Stops a running turn, empties the queue and closes the chat. The transcript stays readable. Closing a closed chat changes nothing.',
    tag: 'Chats',
    scope: 'sessions:write',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The chat, with `closed_at` set.', schema: Chat } },
    async handler({ params, token }) {
      const { chat, workbench } = await writableChat(token, params.id);
      if (!chat.closedAt) await closeChat(chat, workbench);
      return { status: 200, body: await publicChat(chat.id) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/chats/{id}/queue',
    operationId: 'listQueuedMessages',
    summary: 'List queued messages',
    description: 'Messages that wait for the running turn to end, oldest first. They start one by one after it.',
    tag: 'Chats',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The queue. Never paged.', schema: QueuedMessageList } },
    async handler({ params, token }) {
      const chat = await authorizedChat(token, params.id);
      return { status: 200, body: { object: 'list', data: await queuedMessages(chat.id), has_more: false, next_cursor: null } };
    },
  }),

  definePublicRoute({
    method: 'delete',
    path: '/chats/{id}/queue',
    operationId: 'clearQueuedMessages',
    summary: 'Clear the queue',
    description: 'Removes every queued message. A running turn goes on.',
    tag: 'Chats',
    scope: 'sessions:write',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The chat. `queued_message_count` is 0.', schema: Chat } },
    async handler({ params, token }) {
      const { chat } = await writableChat(token, params.id);
      await clearQueuedMessages(chat);
      return { status: 200, body: await publicChat(chat.id) };
    },
  }),

  definePublicRoute({
    method: 'delete',
    path: '/chats/{id}/queue/{message_id}',
    operationId: 'deleteQueuedMessage',
    summary: 'Remove a queued message',
    description: 'A message that already started, or that is not in the queue, answers 404 `queued_message_not_found`.',
    tag: 'Chats',
    scope: 'sessions:write',
    sessions: true,
    params: QueuedMessageParams,
    responses: { 200: { description: 'The chat.', schema: Chat } },
    async handler({ params, token }) {
      const { chat } = await writableChat(token, params.id);
      if (!(await queuedMessages(chat.id)).some((m) => m.id === params.message_id)) throw notFound('queued_message');
      await dropQueuedMessage(chat.id, params.message_id);
      return { status: 200, body: await publicChat(chat.id) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/chats/{id}/checkpoints',
    operationId: 'listChatCheckpoints',
    summary: 'List checkpoints',
    description: 'One per turn: the files as they were before that turn. Oldest first.',
    tag: 'Chats',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The checkpoints. Never paged.', schema: CheckpointList } },
    async handler({ params, token }) {
      const chat = await authorizedChat(token, params.id);
      const data = (await listCheckpoints(chat.id)).map(toPublicCheckpoint);
      return { status: 200, body: { object: 'list', data, has_more: false, next_cursor: null } };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/chats/{id}/checkpoints/{turn}/restore',
    operationId: 'restoreChatCheckpoint',
    summary: 'Restore a checkpoint',
    description:
      'Puts the files back as they were before the turn. Talyn saves the current files first, so the restore can be undone by hand. ' +
      'The branch and its commits do not move. A running turn answers 409 `chat_running`.',
    tag: 'Chats',
    scope: 'sessions:write',
    sessions: true,
    creates: true,
    params: CheckpointParams,
    responses: { 200: { description: 'The chat.', schema: Chat } },
    async handler({ params, token }) {
      const { chat } = await writableChat(token, params.id);
      await restoreCheckpoint(chat.id, params.turn);
      return { status: 200, body: await publicChat(chat.id) };
    },
  }),
];
