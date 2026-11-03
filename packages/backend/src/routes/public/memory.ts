import type { MemoryScope } from '@talyn/shared';
import { CreateMemoryBody, ListMemoriesQuery, Memory, MemoryList, UpdateMemoryBody } from '../../schemas/public/memory.js';
import { IdParams } from '../../schemas/public/resources.js';
import { resolveWorkspaceId } from '../../services/public/authorize.js';
import { decodeCursor, pageOf } from '../../services/public/cursor.js';
import { notFound } from '../../services/public/errors.js';
import { toPublicMemory } from '../../services/public/workProjections.js';
import { authorizedMemory, getMemoryQuery, listMemoriesPageQuery } from '../../services/public/workQueries.js';
import { forgetMemory, putMemory, restoreMemory, updateMemory } from '../../services/workbenches/memory.js';
import { definePublicRoute, type PublicRoute } from './define.js';

async function memoryById(id: string) {
  const [row] = await getMemoryQuery(id);
  if (!row) throw notFound('memory');
  return toPublicMemory(row);
}

/**
 * Workspace memory. The same entries the app's Memory page shows and the
 * sessions read through their memory index. A delete is a soft delete:
 * `forgotten_at` is set, and restore undoes it.
 */
export const memoryRoutes: PublicRoute[] = [
  definePublicRoute({
    method: 'get',
    path: '/memories',
    operationId: 'listMemories',
    summary: 'List memory entries',
    description: 'Newest first. Bodies only with `include_body=true`. Forgotten entries only with `include_forgotten=true`.',
    tag: 'Memory',
    scope: 'memory:read',
    sessions: true,
    query: ListMemoriesQuery,
    responses: { 200: { description: 'A page of entries.', schema: MemoryList } },
    async handler({ query, token }) {
      const workspaceId = await resolveWorkspaceId(token, query.workspace_id);
      const rows = await listMemoriesPageQuery(
        workspaceId,
        {
          ...(query.scope !== undefined ? { scope: query.scope as MemoryScope } : {}),
          ...(query.repository_id !== undefined ? { repositoryId: query.repository_id } : {}),
          ...(query.thread_id !== undefined ? { threadId: query.thread_id } : {}),
          ...(query.q !== undefined ? { q: query.q } : {}),
          includeForgotten: query.include_forgotten === true,
          includeBody: query.include_body === true,
        },
        decodeCursor(query.cursor),
        query.limit,
      );
      const page = pageOf(rows, query.limit);
      return {
        status: 200,
        body: { object: 'list', data: page.rows.map(toPublicMemory), has_more: page.hasMore, next_cursor: page.nextCursor },
      };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/memories',
    operationId: 'createMemory',
    summary: 'Save a memory entry',
    description:
      'Creates an entry. When a live entry with the same scope, target and name exists (the name is not case-sensitive), ' +
      'that entry is updated instead and the answer is 200. A workspace holds at most 500 live entries.',
    tag: 'Memory',
    scope: 'memory:write',
    sessions: true,
    creates: true,
    body: CreateMemoryBody,
    responses: {
      200: { description: 'An entry with this name existed and is updated.', schema: Memory },
      201: { description: 'The new entry.', schema: Memory },
    },
    async handler({ body, token }) {
      const workspaceId = await resolveWorkspaceId(token, body.workspace_id);
      const { entry, outcome } = await putMemory(token.ownerId, {
        workspaceId,
        scope: body.scope,
        repositoryId: body.repository_id ?? null,
        threadId: body.thread_id ?? null,
        type: body.type,
        name: body.name,
        description: body.description,
        body: body.body,
      });
      return { status: outcome === 'created' ? 201 : 200, body: await memoryById(entry.id) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/memories/{id}',
    operationId: 'getMemory',
    summary: 'Get a memory entry',
    description: 'With its body. A forgotten entry too.',
    tag: 'Memory',
    scope: 'memory:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The entry.', schema: Memory } },
    async handler({ params, token }) {
      return { status: 200, body: toPublicMemory(await authorizedMemory(token, params.id)) };
    },
  }),

  definePublicRoute({
    method: 'patch',
    path: '/memories/{id}',
    operationId: 'updateMemory',
    summary: 'Update a memory entry',
    description: 'Change the type, name, description or body. The scope stays. A forgotten entry answers 409 `memory_forgotten`.',
    tag: 'Memory',
    scope: 'memory:write',
    sessions: true,
    params: IdParams,
    body: UpdateMemoryBody,
    responses: { 200: { description: 'The entry.', schema: Memory } },
    async handler({ params, body, token }) {
      const row = await authorizedMemory(token, params.id);
      await updateMemory(row.id, body);
      return { status: 200, body: await memoryById(row.id) };
    },
  }),

  definePublicRoute({
    method: 'delete',
    path: '/memories/{id}',
    operationId: 'forgetMemory',
    summary: 'Forget a memory entry',
    description: 'Sessions stop seeing the entry. It stays, with `forgotten_at` set, so it can be restored. Forgetting it twice changes nothing.',
    tag: 'Memory',
    scope: 'memory:write',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The forgotten entry.', schema: Memory } },
    async handler({ params, token }) {
      const row = await authorizedMemory(token, params.id);
      await forgetMemory(row.id);
      return { status: 200, body: await memoryById(row.id) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/memories/{id}/restore',
    operationId: 'restoreMemory',
    summary: 'Restore a forgotten entry',
    description: 'Refused with 409 `memory_name_taken` when a live entry took its name, and with 409 `memory_limit_reached` at the limit.',
    tag: 'Memory',
    scope: 'memory:write',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The entry.', schema: Memory } },
    async handler({ params, token }) {
      const row = await authorizedMemory(token, params.id);
      await restoreMemory(row.id);
      return { status: 200, body: await memoryById(row.id) };
    },
  }),
];
