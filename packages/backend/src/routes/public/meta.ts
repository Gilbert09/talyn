import { Me } from '../../schemas/public/resources.js';
import { definePublicRoute, type PublicRoute } from './define.js';

/** `GET /v1/me`: who the token acts for and what it may do. Any valid token may ask. */
export const metaRoutes: PublicRoute[] = [
  definePublicRoute({
    method: 'get',
    path: '/me',
    operationId: 'getMe',
    summary: 'Get the token and its owner',
    description: 'Returns the token that made the request: its scopes, its workspace binding and its expiry, and the account it acts for.',
    tag: 'Meta',
    scope: 'any',
    responses: { 200: { description: 'The token and its owner.', schema: Me } },
    async handler({ token }) {
      return {
        status: 200,
        body: {
          object: 'token',
          token: {
            id: token.tokenId,
            name: token.name,
            scopes: token.scopes,
            workspace_ids: token.workspaceIds,
            expires_at: token.expiresAt ? token.expiresAt.toISOString() : null,
          },
          user: { id: token.ownerId, email: token.email },
        },
      };
    },
  }),
];
