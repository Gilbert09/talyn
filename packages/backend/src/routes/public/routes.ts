import { chatWorkRoutes } from './chatWork.js';
import { chatRoutes } from './chats.js';
import { codeReviewRoutes } from './codeReviews.js';
import { definePublicRoute, type PublicRoute } from './define.js';
import { memoryRoutes } from './memory.js';
import { mergeQueueRoutes } from './mergeQueue.js';
import { metaRoutes } from './meta.js';
import { buildOpenApiDocument } from './openapi.js';
import { pullRequestRoutes } from './pullRequests.js';
import { repositorySettingsRoutes } from './repositorySettings.js';
import { sessionWorkRoutes } from './sessionWork.js';
import { sessionRoutes } from './sessions.js';
import { webhookRoutes } from './webhooks.js';
import { workspaceRoutes } from './workspaces.js';

/**
 * Every `/v1` route, in the order the spec lists them. The router mounts
 * these and nothing else; the spec is generated from these and nothing else.
 */
export const PUBLIC_ROUTES: PublicRoute[] = [
  ...metaRoutes,
  ...workspaceRoutes,
  ...sessionRoutes,
  ...chatRoutes,
  ...pullRequestRoutes,
  ...mergeQueueRoutes,
  ...codeReviewRoutes,
  ...webhookRoutes,
  ...sessionWorkRoutes,
  ...chatWorkRoutes,
  ...memoryRoutes,
  ...repositorySettingsRoutes,
];

let cachedDocument: ReturnType<typeof buildOpenApiDocument> | null = null;

/** The spec, built once per process. */
export function publicOpenApiDocument(): ReturnType<typeof buildOpenApiDocument> {
  cachedDocument ??= buildOpenApiDocument(PUBLIC_ROUTES);
  return cachedDocument;
}

PUBLIC_ROUTES.push(
  definePublicRoute({
    method: 'get',
    path: '/openapi.json',
    operationId: 'getOpenApiSpec',
    summary: 'Get this OpenAPI document',
    tag: 'Meta',
    scope: 'none',
    responses: { 200: { description: 'The OpenAPI 3.1 document of `/v1`.' } },
    async handler() {
      return { status: 200, body: publicOpenApiDocument() };
    },
  }),
);
