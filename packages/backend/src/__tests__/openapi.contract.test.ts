import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_SCOPES } from '@talyn/shared';
import { publicApiRouter } from '../routes/public/index.js';
import { expressPath } from '../routes/public/define.js';
import { OPENAPI_DOCUMENT_PATH, buildOpenApiDocument, serializeOpenApiDocument } from '../routes/public/openapi.js';
import { PUBLIC_ROUTES } from '../routes/public/routes.js';

/**
 * The contract of `/v1`:
 *  - the committed `docs/api/openapi.json` is what the routes generate, so a
 *    change to the API is a reviewed diff of that file;
 *  - every route the router mounts is in the spec, and every route has a scope.
 *
 * When the first test fails after a deliberate change, run
 * `npm run openapi:generate -w @talyn/backend` and commit the file.
 */

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

function mountedRoutes(): string[] {
  const router = publicApiRouter();
  const out: string[] = [];
  for (const layer of (router as unknown as { stack: Layer[] }).stack) {
    if (!layer.route) continue;
    for (const [method, on] of Object.entries(layer.route.methods)) if (on) out.push(`${method.toUpperCase()} ${layer.route.path}`);
  }
  return out.sort();
}

describe('the /v1 contract', () => {
  it('the committed openapi.json matches the routes', () => {
    const committed = fs.readFileSync(OPENAPI_DOCUMENT_PATH, 'utf8');
    expect(serializeOpenApiDocument(buildOpenApiDocument(PUBLIC_ROUTES))).toBe(committed);
  });

  it('every mounted route is in the spec, and the spec has nothing that is not mounted', () => {
    const doc = buildOpenApiDocument(PUBLIC_ROUTES) as { paths: Record<string, Record<string, unknown>> };
    const documented: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) documented.push(`${method.toUpperCase()} ${expressPath(path)}`);
    }
    expect(mountedRoutes()).toEqual(documented.sort());
  });

  it('every route names what it needs, and only the spec itself needs no token', () => {
    for (const route of PUBLIC_ROUTES) {
      expect(route.scope === 'any' || route.scope === 'none' || (API_SCOPES as readonly string[]).includes(route.scope), route.path).toBe(true);
    }
    expect(PUBLIC_ROUTES.filter((r) => r.scope === 'none').map((r) => r.path)).toEqual(['/openapi.json']);
  });

  it('every write needs a write scope, and every read a read scope', () => {
    for (const route of PUBLIC_ROUTES) {
      if (route.scope === 'any' || route.scope === 'none') continue;
      expect(route.scope.endsWith(route.method === 'get' ? ':read' : ':write'), `${route.method} ${route.path}`).toBe(true);
    }
  });

  it('a route that calls GitHub documents the 502 GitHub answer, and a plan-limited one the 402', () => {
    const doc = buildOpenApiDocument(PUBLIC_ROUTES) as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
    for (const route of PUBLIC_ROUTES) {
      const responses = doc.paths[route.path][route.method].responses;
      expect('502' in responses, `${route.method} ${route.path}`).toBe(Boolean(route.github));
      expect('402' in responses, `${route.method} ${route.path}`).toBe(Boolean(route.creates || route.planLimited));
    }
  });

  it('operation ids are unique', () => {
    const ids = PUBLIC_ROUTES.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only creates and idempotent writes take an Idempotency-Key, and each is a POST', () => {
    for (const route of PUBLIC_ROUTES.filter((r) => r.creates || r.idempotent)) expect(route.method).toBe('post');
    const doc = buildOpenApiDocument(PUBLIC_ROUTES) as {
      paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }> }>>;
    };
    for (const route of PUBLIC_ROUTES) {
      const params = doc.paths[route.path][route.method].parameters ?? [];
      expect(params.some((p) => p.in === 'header' && p.name === 'Idempotency-Key'), route.path).toBe(
        Boolean(route.creates || route.idempotent),
      );
    }
  });
});
