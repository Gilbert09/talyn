import type { Href } from 'expo-router';

import { pullsRoute } from '../features/prs/lists';
import { HOME, newWorkRoute, pullRequestRoute, sessionRoute, threadRoute } from '../navigation/routes';

export const validRoutes: Href[] = [
  HOME, '/settings', '/workspaces',
  // Old list links, kept for deep links and notification fallbacks.
  '/sessions', '/threads', '/attention',
  sessionRoute('session-id'), threadRoute('thread-id'), pullRequestRoute('pr-id'),
  pullsRoute('mine'), pullsRoute('reviews'), pullsRoute('queue'),
  newWorkRoute('session'), newWorkRoute('thread'), '/new',
  '/spaces', '/automations', '/usage', '/agents', '/insights', '/billing', '/billing/return',
  // Settings editors and their browser return links.
  '/settings/sandboxSetup', '/settings/privateRoutes', '/settings/mcp', '/settings/apiTokens', '/settings/apiTokens/new',
  '/settings/slack', '/settings/integrations', '/settings/skills', '/settings/instructions', '/settings/memory', '/settings/codeReview',
  '/mcp/callback', '/slack/callback', '/posthog/callback',
];

// @ts-expect-error The route does not exist.
export const missingRoute: Href = '/unknown';

// @ts-expect-error A detail route requires its identifier.
export const missingParameter: Href = { pathname: '/sessions/[id]', params: {} };

// @ts-expect-error The route parameter is id.
export const wrongParameter: Href = { pathname: '/threads/[id]', params: { threadId: 'thread-id' } };
