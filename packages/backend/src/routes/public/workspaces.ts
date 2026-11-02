import {
  IdParams,
  ListRepositoriesQuery,
  ListWorkspacesQuery,
  RepositoryList,
  Workspace,
  WorkspaceList,
} from '../../schemas/public/resources.js';
import { authorizeWorkspace, resolveWorkspaceId } from '../../services/public/authorize.js';
import { decodeCursor, pageOf } from '../../services/public/cursor.js';
import { notFound } from '../../services/public/errors.js';
import { toPublicRepository, toPublicWorkspace } from '../../services/public/projections.js';
import { getWorkspaceQuery, listRepositoriesQuery, listWorkspacesQuery } from '../../services/public/queries.js';
import { definePublicRoute, type PublicRoute } from './define.js';

/** Workspaces and their repositories, read only. Creating and deleting them stays in the app. */
export const workspaceRoutes: PublicRoute[] = [
  definePublicRoute({
    method: 'get',
    path: '/workspaces',
    operationId: 'listWorkspaces',
    summary: 'List workspaces',
    description: 'The workspaces the token can reach, newest first.',
    tag: 'Workspaces',
    scope: 'workspaces:read',
    query: ListWorkspacesQuery,
    responses: { 200: { description: 'A page of workspaces.', schema: WorkspaceList } },
    async handler({ query, token }) {
      const rows = await listWorkspacesQuery(token.ownerId, token.workspaceIds, decodeCursor(query.cursor), query.limit);
      const page = pageOf(rows, query.limit);
      return {
        status: 200,
        body: { object: 'list', data: page.rows.map(toPublicWorkspace), has_more: page.hasMore, next_cursor: page.nextCursor },
      };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/workspaces/{id}',
    operationId: 'getWorkspace',
    summary: 'Get a workspace',
    tag: 'Workspaces',
    scope: 'workspaces:read',
    params: IdParams,
    responses: { 200: { description: 'The workspace.', schema: Workspace } },
    async handler({ params, token }) {
      await authorizeWorkspace(token, params.id);
      const [row] = await getWorkspaceQuery(params.id);
      if (!row) throw notFound('workspace');
      return { status: 200, body: toPublicWorkspace(row) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/repositories',
    operationId: 'listRepositories',
    summary: 'List repositories',
    description: 'The repositories a workspace watches, newest first.',
    tag: 'Repositories',
    scope: 'repositories:read',
    query: ListRepositoriesQuery,
    responses: { 200: { description: 'A page of repositories.', schema: RepositoryList } },
    async handler({ query, token }) {
      const workspaceId = await resolveWorkspaceId(token, query.workspace_id);
      const rows = await listRepositoriesQuery(workspaceId, decodeCursor(query.cursor), query.limit);
      const page = pageOf(rows, query.limit);
      return {
        status: 200,
        body: { object: 'list', data: page.rows.map(toPublicRepository), has_more: page.hasMore, next_cursor: page.nextCursor },
      };
    },
  }),
];
