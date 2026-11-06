import {
  IdParams, ListSpacesQuery, ListSpaceSessionsQuery, ListWorkspacesQuery,
  SpaceList, SpaceSessionList, TeamList,
} from '../../schemas/public/resources.js';
import { assertSpacesAvailable } from '../../services/public/authorize.js';
import { decodeCursor, pageOf } from '../../services/public/cursor.js';
import { notFound } from '../../services/public/errors.js';
import { toPublicSpace, toPublicSpaceSession, toPublicTeam } from '../../services/public/projections.js';
import { listSpacesQuery, listSpaceSessionsQuery, listTeamsQuery } from '../../services/public/queries.js';
import { assertSpaceMember, filterViewable } from '../../services/teams/access.js';
import { callerGithubIdentity, memberTeamIds, resolveHomeWorkspace } from '../../services/teams/membership.js';
import { TeamError } from '../../services/billing/teams.js';
import { definePublicRoute, type PublicRoute } from './define.js';

export const spaceRoutes: PublicRoute[] = [
  definePublicRoute({
    method: 'get', path: '/teams', operationId: 'listTeams', summary: 'List teams', tag: 'Teams',
    scope: 'teams:read', query: ListWorkspacesQuery,
    responses: { 200: { description: 'Teams you belong to.', schema: TeamList } },
    async handler({ token, query }) {
      await assertSpacesAvailable(token);
      const { githubUserId } = await callerGithubIdentity(token.ownerId);
      const rows = await listTeamsQuery(token.ownerId, githubUserId, decodeCursor(query.cursor), query.limit);
      const page = pageOf(rows, query.limit);
      return { status: 200, body: { object: 'list', data: page.rows.map(toPublicTeam), has_more: page.hasMore, next_cursor: page.nextCursor } };
    },
  }),
  definePublicRoute({
    method: 'get', path: '/spaces', operationId: 'listSpaces', summary: 'List spaces', tag: 'Spaces',
    scope: 'spaces:read', query: ListSpacesQuery,
    responses: { 200: { description: 'Live spaces in your teams.', schema: SpaceList } },
    async handler({ token, query }) {
      await assertSpacesAvailable(token);
      const teamIds = await memberTeamIds(token.ownerId);
      if (query.team_id && !teamIds.includes(query.team_id)) throw notFound('team');
      const rows = await listSpacesQuery(teamIds, query.team_id, decodeCursor(query.cursor), query.limit);
      const page = pageOf(rows, query.limit);
      return { status: 200, body: { object: 'list', data: page.rows.map(toPublicSpace), has_more: page.hasMore, next_cursor: page.nextCursor } };
    },
  }),
  definePublicRoute({
    method: 'get', path: '/spaces/{id}/sessions', operationId: 'listSpaceSessions',
    summary: 'List sessions in a space', tag: 'Spaces', scope: 'spaces:read', sessions: true,
    params: IdParams, query: ListSpaceSessionsQuery,
    responses: { 200: { description: 'Visible sessions and the count hidden by repository access.', schema: SpaceSessionList } },
    async handler({ token, params, query }) {
      await assertSpacesAvailable(token);
      try {
        const space = await assertSpaceMember(token.ownerId, params.id);
        if (token.workspaceIds) {
          const home = await resolveHomeWorkspace(space.teamId, token.ownerId);
          if (!home || !token.workspaceIds.includes(home)) throw notFound('space');
        }
      } catch (err) {
        if (err instanceof TeamError && err.status === 404) throw notFound('space');
        throw err;
      }
      const rows = await listSpaceSessionsQuery(params.id, decodeCursor(query.cursor), query.limit);
      const page = pageOf(rows, query.limit);
      const { visible, hiddenCount } = await filterViewable(token.ownerId, page.rows);
      return { status: 200, body: {
        object: 'list', data: visible.map(toPublicSpaceSession), hidden_count: hiddenCount,
        has_more: page.hasMore, next_cursor: page.nextCursor,
      } };
    },
  }),
];
