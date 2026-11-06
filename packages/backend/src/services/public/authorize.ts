import type { ApiTokenPrincipal } from '../apiTokens.js';
import { scopeAllows } from '@talyn/shared';
import { isFeatureEnabled } from '../featureFlags.js';
import { assertSpaceMember, canViewItem } from '../teams/access.js';
import { resolveHomeWorkspace } from '../teams/membership.js';
import { userMayUseWorkbenches, workbenchesRefusalReason } from '../workbenches/access.js';
import { PublicApiError, notFound } from './errors.js';
import { getChatQuery, getSessionQuery, workspaceOwner } from './queries.js';
import type { PublicChatRow, PublicSessionRow } from './projections.js';

/**
 * Who may reach what on `/v1`. Two rules on top of ownership:
 *  - A token bound to workspaces reaches only those.
 *  - Anything outside the token's reach is 404, never 403, so an id does not
 *    tell a caller that it exists. The same rule as `requireWorkspaceAccess`.
 */

/** Refuse a workspace the token cannot reach, as if it did not exist. */
export async function authorizeWorkspace(token: ApiTokenPrincipal, workspaceId: string): Promise<void> {
  if (token.workspaceIds && !token.workspaceIds.includes(workspaceId)) throw notFound('workspace');
  if ((await workspaceOwner(workspaceId)) !== token.ownerId) throw notFound('workspace');
}

/**
 * The workspace a list or a create is about. When the request does not name
 * one, a token bound to exactly one workspace answers for it.
 */
export async function resolveWorkspaceId(token: ApiTokenPrincipal, provided: string | undefined): Promise<string> {
  let workspaceId = provided;
  if (!workspaceId) {
    if (token.workspaceIds?.length === 1) workspaceId = token.workspaceIds[0];
    else {
      throw new PublicApiError(400, 'missing_parameter', 'workspace_id is required. A token bound to one workspace may leave it out.', {
        param: 'workspace_id',
      });
    }
  }
  await authorizeWorkspace(token, workspaceId);
  return workspaceId;
}

/** Sessions also need the `workbenches` flag for the token owner. */
export async function assertSessionsAvailable(token: ApiTokenPrincipal): Promise<void> {
  if (!(await userMayUseWorkbenches({ distinctId: token.ownerId, email: token.email }))) {
    throw new PublicApiError(403, 'workbenches_unavailable', `Sessions are not available: ${workbenchesRefusalReason()}.`);
  }
}

export async function authorizedSession(token: ApiTokenPrincipal, id: string): Promise<PublicSessionRow> {
  const [row] = await getSessionQuery(id);
  if (!row) throw notFound('session');
  try {
    await authorizeWorkspace(token, row.workspaceId);
  } catch {
    throw notFound('session');
  }
  return row;
}

export async function assertSpacesAvailable(token: ApiTokenPrincipal): Promise<void> {
  if (!(await isFeatureEnabled('spaces', { distinctId: token.ownerId, email: token.email }))) {
    throw new PublicApiError(403, 'spaces_unavailable', 'Spaces are not available.');
  }
}

export function assertSpacesWrite(token: ApiTokenPrincipal): void {
  if (!scopeAllows(token.scopes, 'spaces:write')) {
    throw new PublicApiError(403, 'insufficient_scope', 'This token does not have the "spaces:write" scope.', {
      details: { required_scope: 'spaces:write' },
      headers: { 'WWW-Authenticate': 'Bearer realm="talyn-api", error="insufficient_scope", scope="spaces:write"' },
    });
  }
}

export async function authorizedReadableSession(token: ApiTokenPrincipal, id: string): Promise<PublicSessionRow> {
  const [row] = await getSessionQuery(id);
  if (!row) throw notFound('session');
  if ((await workspaceOwner(row.workspaceId)) === token.ownerId) {
    if (token.workspaceIds && !token.workspaceIds.includes(row.workspaceId)) throw notFound('session');
    return row;
  }
  if (!row.spaceId) throw notFound('session');
  if (!(await isFeatureEnabled('spaces', { distinctId: token.ownerId, email: token.email }))) throw notFound('session');
  try {
    const space = await assertSpaceMember(token.ownerId, row.spaceId);
    if (token.workspaceIds) {
      const home = await resolveHomeWorkspace(space.teamId, token.ownerId);
      if (!home || !token.workspaceIds.includes(home)) throw notFound('session');
    }
    if (await canViewItem(token.ownerId, { workspaceId: row.workspaceId, spaceId: row.spaceId, repoFullName: row.repoFullName || null })) return row;
  } catch {
    // A missing space or membership has the same answer as a missing session.
  }
  throw notFound('session');
}

export async function authorizedReadableChat(token: ApiTokenPrincipal, id: string): Promise<PublicChatRow> {
  const [row] = await getChatQuery(id);
  if (!row) throw notFound('chat');
  try {
    await authorizedReadableSession(token, row.workbenchId);
    return row;
  } catch {
    throw notFound('chat');
  }
}

export async function authorizedChat(token: ApiTokenPrincipal, id: string): Promise<PublicChatRow> {
  const [row] = await getChatQuery(id);
  if (!row) throw notFound('chat');
  try {
    await authorizeWorkspace(token, row.workspaceId);
  } catch {
    throw notFound('chat');
  }
  return row;
}

/** A local session runs in the desktop app. The API reads it and changes nothing. */
export function refuseLocalRuntime(session: Pick<PublicSessionRow, 'runtime'>): void {
  if (session.runtime === 'local') {
    throw new PublicApiError(
      409,
      'local_runtime',
      'This session runs on a computer in the desktop app. The API can read it, but only the desktop app can change it.',
    );
  }
}
