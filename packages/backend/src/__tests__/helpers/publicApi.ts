import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { ApiScope } from '@talyn/shared';
import { MemoryRateLimitStore } from '../../middleware/publicRateLimit.js';
import { publicApiRouter } from '../../routes/public/index.js';
import { createApiToken } from '../../services/apiTokens.js';

/** A `/v1` server on a free port, with its own rate-limit counters. */
export async function startPublicApi(): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/v1', publicApiRouter({ rateLimitStore: new MemoryRateLimitStore() }));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    base,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export const ALL_SCOPES: ApiScope[] = ['workspaces:read', 'repositories:read', 'sessions:read', 'sessions:write'];

/** Mint a token directly through the service. */
export async function mintToken(
  ownerId: string,
  opts: { scopes?: ApiScope[]; workspaceIds?: string[] | null; expiresInDays?: number | null; now?: Date } = {},
): Promise<string> {
  const { token } = await createApiToken(
    ownerId,
    {
      name: 'test',
      scopes: opts.scopes ?? ALL_SCOPES,
      workspaceIds: opts.workspaceIds ?? null,
      expiresInDays: opts.expiresInDays === undefined ? 90 : opts.expiresInDays,
    },
    { now: opts.now },
  );
  return token;
}

/** A response body read loosely: tests assert on fields one at a time. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loose = any;

export interface PublicResponse {
  status: number;
  headers: Headers;
  body: Loose;
}

export async function callPublic(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<PublicResponse> {
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await resp.text();
  let body: Loose = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A non-JSON body stays text.
  }
  return { status: resp.status, headers: resp.headers, body };
}
