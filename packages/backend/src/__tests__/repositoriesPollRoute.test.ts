import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { NextFunction, Request, Response } from 'express';
import { repositoryRoutes } from '../routes/repositories.js';
import { prMonitorService, type RefreshOutcome } from '../services/prMonitor.js';

/**
 * The Refresh button's route. The client re-reads the cached list right after
 * it, so a refresh that never reached GitHub must say so: a 200 there reads as
 * "nothing new" to the person who pressed it.
 */

let server: Server;
let base: string;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: 'user-1', email: 'me@example.test', isAdmin: false };
    next();
  });
  app.use('/api/v1/repositories', repositoryRoutes());
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function pressRefresh() {
  const res = await fetch(`${base}/api/v1/repositories/poll`, { method: 'POST' });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /repositories/poll', () => {
  it.each<[string, RefreshOutcome | null, number, Record<string, unknown>]>([
    [
      'every repo refreshed',
      { repos: 13, failedRepos: 0, failure: null },
      200,
      { success: true, data: { message: 'Poll triggered', skipped: false, repos: 13, failedRepos: 0, failure: null } },
    ],
    [
      'some repos failed',
      { repos: 13, failedRepos: 2, failure: 'PostHog/secrets: HTTP 502' },
      200,
      {
        success: true,
        data: { message: 'Poll triggered', skipped: false, repos: 13, failedRepos: 2, failure: 'PostHog/secrets: HTTP 502' },
      },
    ],
    [
      'every repo failed',
      { repos: 13, failedRepos: 13, failure: 'GitHub is rate-limiting your account. Try again in about 5 min.' },
      503,
      { success: false, error: 'GitHub is rate-limiting your account. Try again in about 5 min.' },
    ],
    [
      'nothing to poll',
      { repos: 0, failedRepos: 0, failure: null },
      200,
      { success: true, data: { message: 'Poll triggered', skipped: false, repos: 0, failedRepos: 0, failure: null } },
    ],
    [
      'another poll held the guard',
      null,
      200,
      { success: true, data: { message: 'A refresh is already running', skipped: true, repos: 0, failedRepos: 0, failure: null } },
    ],
  ])('%s', async (_label, outcome, status, body) => {
    const spy = vi.spyOn(prMonitorService, 'forcePollForOwner').mockResolvedValue(outcome);

    const res = await pressRefresh();

    expect(spy).toHaveBeenCalledWith('user-1', { untilListReady: true });
    expect(res.status).toBe(status);
    expect(res.body).toEqual(body);
  });

  it('answers 500 with the message when the refresh throws', async () => {
    vi.spyOn(prMonitorService, 'forcePollForOwner').mockRejectedValue(new Error('boom'));

    const res = await pressRefresh();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'boom' });
  });
});
