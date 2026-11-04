import { v4 as uuid } from 'uuid';
import type { WorkbenchAgent, WorkbenchEffort } from '@talyn/shared';
import {
  Chat,
  CreateChatBody,
  CreateSessionBody,
  IdParams,
  ListSessionsQuery,
  Session,
  SessionList,
} from '../../schemas/public/resources.js';
import {
  authorizedSession,
  refuseLocalRuntime,
  resolveWorkspaceId,
} from '../../services/public/authorize.js';
import { decodeCursor, pageOf } from '../../services/public/cursor.js';
import { PublicApiError, notFound } from '../../services/public/errors.js';
import { toPublicChat, toPublicSession } from '../../services/public/projections.js';
import { getChatQuery, getSessionQuery, listSessionsQuery, openChatsQuery } from '../../services/public/queries.js';
import { streamSession } from '../../services/public/sse.js';
import { createWorkbench, type CreateWorkbenchServiceInput } from '../../services/workbenches/create.js';
import { emitWorkbenchChat } from '../../services/workbenches/emit.js';
import { archiveWorkbench, restoreWorkbench, retryWorkbench } from '../../services/workbenches/lifecycle.js';
import { sandboxRefusal, workbenchReadiness } from '../../services/workbenches/readiness.js';
import { getWorkbench, insertChat, rowToChat } from '../../services/workbenches/store.js';
import { definePublicRoute, type PublicRoute } from './define.js';

/** A session with its open chats, read again after a change so the answer is what is stored. */
async function sessionWithChats(id: string) {
  const [row] = await getSessionQuery(id);
  if (!row) throw notFound('session');
  return toPublicSession(row, await openChatsQuery(id));
}

/**
 * Sessions: a sandbox with a branch, an agent and its chats. The handlers call
 * the same services as the app's routes (`createWorkbench`, `archiveWorkbench`,
 * ...), so plan limits, readiness and provisioning behave the same.
 */
export const sessionRoutes: PublicRoute[] = [
  definePublicRoute({
    method: 'get',
    path: '/sessions',
    operationId: 'listSessions',
    summary: 'List sessions',
    description: 'Sessions in a workspace, newest first. Archived sessions only when asked for.',
    tag: 'Sessions',
    scope: 'sessions:read',
    sessions: true,
    query: ListSessionsQuery,
    responses: { 200: { description: 'A page of sessions. Chats are not embedded in lists.', schema: SessionList } },
    async handler({ query, token }) {
      const workspaceId = await resolveWorkspaceId(token, query.workspace_id);
      const rows = await listSessionsQuery(
        workspaceId,
        { statuses: query.status, kinds: query.kind, includeArchived: query.include_archived },
        decodeCursor(query.cursor),
        query.limit,
      );
      const page = pageOf(rows, query.limit);
      return {
        status: 200,
        body: { object: 'list', data: page.rows.map((r) => toPublicSession(r)), has_more: page.hasMore, next_cursor: page.nextCursor },
      };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/sessions',
    operationId: 'createSession',
    summary: 'Start a session',
    description:
      'Creates a sandbox session on a repository (or a thread, with `kind: "thread"`) and starts provisioning. ' +
      'With a `prompt`, the agent starts on it when the sandbox is ready. Counts against the plan like a session started in the app.',
    tag: 'Sessions',
    scope: 'sessions:write',
    sessions: true,
    creates: true,
    body: CreateSessionBody,
    responses: { 201: { description: 'The new session. `status` is `provisioning`.', schema: Session } },
    async handler({ body, token }) {
      const sentAt = new Date().toISOString();
      const workspaceId = await resolveWorkspaceId(token, body.workspace_id);
      const input: CreateWorkbenchServiceInput = {
        workspaceId,
        runtime: 'sandbox',
        agent: body.agent,
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.repository_id !== undefined ? { repositoryId: body.repository_id } : {}),
        ...(body.thread_id !== undefined ? { threadId: body.thread_id } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.base_branch !== undefined ? { baseBranch: body.base_branch } : {}),
        ...(body.branch !== undefined ? { branch: body.branch } : {}),
        ...(body.pull_request_id !== undefined ? { fromPullRequestId: body.pull_request_id } : {}),
        ...(body.internet_access !== undefined ? { internetAccess: body.internet_access } : {}),
        ...(body.auto_create_pr !== undefined ? { autoCreatePr: body.auto_create_pr } : {}),
      };
      if ((body.kind ?? 'session') === 'session' && body.repository_id === undefined) {
        throw new PublicApiError(400, 'missing_parameter', 'repository_id is required for a session.', { param: 'repository_id' });
      }
      const created = await createWorkbench(input, { id: token.ownerId, email: token.email }, sentAt);
      return { status: 201, body: await sessionWithChats(created.id) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/sessions/{id}',
    operationId: 'getSession',
    summary: 'Get a session',
    tag: 'Sessions',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The session, with its open chats.', schema: Session } },
    async handler({ params, token }) {
      const row = await authorizedSession(token, params.id);
      return { status: 200, body: toPublicSession(row, await openChatsQuery(row.id)) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/sessions/{id}/archive',
    operationId: 'archiveSession',
    summary: 'Archive a session',
    description: 'Stops a running turn, saves the work and stops the sandbox. The answer comes before the sandbox has stopped.',
    tag: 'Sessions',
    scope: 'sessions:write',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The session.', schema: Session } },
    async handler({ params, token }) {
      const row = await authorizedSession(token, params.id);
      refuseLocalRuntime(row);
      if (!row.archivedAt) await archiveWorkbench(row.id);
      return { status: 200, body: await sessionWithChats(row.id) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/sessions/{id}/restore',
    operationId: 'restoreSession',
    summary: 'Restore an archived session',
    description: 'Starts a new sandbox from the saved work. Waits up to a minute for an archive that is still running to finish.',
    tag: 'Sessions',
    scope: 'sessions:write',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The session.', schema: Session } },
    async handler({ params, token }) {
      const row = await authorizedSession(token, params.id);
      refuseLocalRuntime(row);
      await restoreWorkbench(row.id);
      return { status: 200, body: await sessionWithChats(row.id) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/sessions/{id}/retry',
    operationId: 'retrySession',
    summary: 'Retry a session that failed or is stuck while it starts',
    description: 'Provisions again on a new sandbox after `status: "error"`, or while `status` is `provisioning` and the start is stuck. Refused while the account still cannot run a sandbox.',
    tag: 'Sessions',
    scope: 'sessions:write',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The session.', schema: Session } },
    async handler({ params, token }) {
      const row = await authorizedSession(token, params.id);
      refuseLocalRuntime(row);
      if ((row.status === 'error' || row.status === 'provisioning') && !row.archivedAt) {
        const refusal = sandboxRefusal(
          await workbenchReadiness(row.workspaceId, { id: token.ownerId, email: token.email }),
          row.agent as WorkbenchAgent,
        );
        if (refusal) throw refusal;
      }
      await retryWorkbench(row.id);
      return { status: 200, body: await sessionWithChats(row.id) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/sessions/{id}/chats',
    operationId: 'createChat',
    summary: 'Open a new chat in a session',
    description: 'A new agent conversation on the same sandbox and branch. Send it a message to start a turn.',
    tag: 'Chats',
    scope: 'sessions:write',
    sessions: true,
    creates: true,
    params: IdParams,
    body: CreateChatBody,
    responses: { 201: { description: 'The new chat.', schema: Chat } },
    async handler({ params, body, token }) {
      const row = await authorizedSession(token, params.id);
      refuseLocalRuntime(row);
      if (row.archivedAt) throw new PublicApiError(409, 'archived', 'This session is archived. Restore it first.');
      const workbench = await getWorkbench(row.id);
      if (!workbench) throw notFound('session');
      const chat = await insertChat({
        id: uuid(),
        workbenchId: workbench.id,
        workspaceId: workbench.workspaceId,
        title: body.title?.trim() || 'Chat',
        // A sandbox's vendor is fixed when it boots, so its chats use the session's agent.
        agent: workbench.agent,
        model: body.model?.trim() || workbench.model,
        effort: (body.effort as WorkbenchEffort | undefined) ?? null,
        planMode: body.plan_mode === true,
      });
      emitWorkbenchChat(workbench.workspaceId, rowToChat(chat));
      const [stored] = await getChatQuery(chat.id);
      return { status: 201, body: toPublicChat(stored) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/sessions/{id}/stream',
    operationId: 'streamSession',
    summary: 'Stream session changes',
    description:
      'Server-sent events: `session.updated` when the session changes, `chat.updated` when one of its chats changes, ' +
      'and `end` when the session is deleted. Frames have no ids: on reconnect, read the session again. ' +
      'A comment line (`: ping`) every 15 seconds keeps the connection open.',
    tag: 'Sessions',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'A `text/event-stream`.', contentType: 'text/event-stream' } },
    async handler({ req, res, params, token }) {
      const row = await authorizedSession(token, params.id);
      await streamSession(req, res, { token, session: row });
    },
  }),
];
