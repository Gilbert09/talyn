import path from 'node:path';
import { OpenAPIRegistry, OpenApiGeneratorV31, type ResponseConfig, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { ErrorBody } from '../../schemas/public/common.js';
import { z } from '../../schemas/public/zod.js';
import { IDEMPOTENCY_HEADER } from '../../services/public/idempotency.js';
import type { PublicRoute } from './define.js';

/**
 * Build the OpenAPI 3.1 document from the route declarations. Pure and
 * deterministic: the same routes give the same JSON, which is what lets
 * `docs/api/openapi.json` be committed and checked by a test.
 */

/** Where the committed document lives: `docs/api/openapi.json` at the repository root. */
export const OPENAPI_DOCUMENT_PATH = path.resolve(__dirname, '../../../../../docs/api/openapi.json');

export const PUBLIC_API_VERSION = '1.0.0';
export const PUBLIC_API_SERVER = 'https://api.talyn.dev/v1';

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The request is not valid. `error.param` names the field.',
  401: 'The token is missing, not valid, expired or revoked.',
  402: 'The plan limit is reached. `error.code` says which limit.',
  403: 'The token lacks the scope, or the API or sessions are not available for this account.',
  404: 'No such resource, or the token cannot reach it.',
  409: 'The resource is not in a state that allows this, e.g. `not_ready`, `local_runtime`, an idempotency conflict.',
  429: 'Too many requests. Wait `Retry-After` seconds.',
  500: 'A fault on our side. Quote `error.request_id`.',
  503: 'Talyn Fleet or GitHub cannot take the request now. Retry later.',
};

const rateLimitHeaders = {
  'X-Request-Id': { description: 'The id of this request. Also in every error body.', schema: { type: 'string' as const } },
  'RateLimit-Limit': { description: 'Requests allowed in the window.', schema: { type: 'integer' as const } },
  'RateLimit-Remaining': { description: 'Requests left in the window.', schema: { type: 'integer' as const } },
  'RateLimit-Reset': { description: 'Seconds until the window ends.', schema: { type: 'integer' as const } },
};

function errorStatuses(route: PublicRoute): number[] {
  if (route.scope === 'none') return [429, 500];
  const statuses = [400, 401, 403, 404, 429, 500];
  if (route.method !== 'get') statuses.push(409, 503);
  if (route.creates) statuses.push(402);
  return statuses.sort((a, b) => a - b);
}

function scopeText(route: PublicRoute): string {
  if (route.scope === 'none') return 'No token needed.';
  if (route.scope === 'any') return 'Any valid token.';
  return `Scope: \`${route.scope}\`.`;
}

export function buildOpenApiDocument(routes: readonly PublicRoute[]) {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'A personal access token (`talyn_pat_...`) from Settings → Developer in the Talyn app.',
  });
  registry.register('Error', ErrorBody);

  for (const route of routes) {
    const responses: Record<number, ResponseConfig> = {};
    for (const [status, spec] of Object.entries(route.responses)) {
      const contentType = spec.contentType ?? 'application/json';
      responses[Number(status)] = {
        description: spec.description,
        ...(route.scope === 'none' ? {} : { headers: rateLimitHeaders }),
        ...(spec.schema
          ? { content: { [contentType]: { schema: spec.schema } } }
          : contentType === 'text/event-stream'
            ? { content: { 'text/event-stream': { schema: z.string() } } }
            : {}),
      };
    }
    for (const status of errorStatuses(route)) {
      responses[status] = {
        description: ERROR_DESCRIPTIONS[status],
        content: { 'application/json': { schema: ErrorBody } },
      };
    }

    const request: NonNullable<RouteConfig['request']> = {};
    if (route.params) request.params = route.params as never;
    if (route.query) request.query = route.query as never;
    if (route.body) request.body = { required: true, content: { 'application/json': { schema: route.body } } };
    if (route.creates) {
      request.headers = z.object({
        [IDEMPOTENCY_HEADER]: z
          .string()
          .max(255)
          .optional()
          .openapi({ description: 'Send the same key when you retry, and the request runs once. Kept for 24 hours.' }),
      });
    }

    registry.registerPath({
      method: route.method,
      path: route.path,
      operationId: route.operationId,
      summary: route.summary,
      description: [route.description, scopeText(route)].filter(Boolean).join('\n\n'),
      tags: [route.tag],
      security: route.scope === 'none' ? [] : [{ bearerAuth: [] }],
      ...(route.scope === 'none' || route.scope === 'any' ? {} : { 'x-talyn-scope': route.scope }),
      ...(Object.keys(request).length > 0 ? { request } : {}),
      responses,
    });
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Talyn API',
      version: PUBLIC_API_VERSION,
      description:
        'Start and drive Talyn sessions from code. Authenticate with a personal access token. ' +
        'See docs/PUBLIC_API.md for the guides.',
    },
    servers: [{ url: PUBLIC_API_SERVER }],
  });
}

/** The document as committed: two-space JSON with a final newline. */
export function serializeOpenApiDocument(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
