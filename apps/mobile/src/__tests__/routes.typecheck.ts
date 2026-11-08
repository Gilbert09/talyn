import type { Href } from 'expo-router';

import { pullRequestRoute, sessionRoute, threadRoute } from '../navigation/routes';

export const validRoutes: Href[] = [
  '/sessions', '/threads', '/attention', '/settings',
  sessionRoute('session-id'), threadRoute('thread-id'), pullRequestRoute('pr-id'),
];

// @ts-expect-error The route does not exist.
export const missingRoute: Href = '/unknown';

// @ts-expect-error A detail route requires its identifier.
export const missingParameter: Href = { pathname: '/sessions/[id]', params: {} };

// @ts-expect-error The route parameter is id.
export const wrongParameter: Href = { pathname: '/threads/[id]', params: { threadId: 'thread-id' } };
