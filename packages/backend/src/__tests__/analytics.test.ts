import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  captureServerEvent,
  captureWorkspaceEvent,
  isServerAnalyticsConfigured,
  resetAnalyticsCacheForTests,
} from '../services/analytics.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';

/**
 * Server-side analytics is env-gated and best-effort: no key → no HTTP at
 * all; with a key, one capture POST per event with the right shape; any
 * failure is swallowed (analytics must never break task processing).
 */

const fetchMock = vi.fn();

async function flushMicrotasks(): Promise<void> {
  // captureWorkspaceEvent is fire-and-forget (owner lookup then POST) —
  // a couple of macrotask turns lets the chain settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('server analytics', () => {
  const origFetch = globalThis.fetch;
  let cleanup: (() => Promise<void>) | null = null;
  let db: Database;

  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    resetAnalyticsCacheForTests();
    delete process.env.FASTOWL_POSTHOG_KEY;
    delete process.env.FASTOWL_POSTHOG_HOST;

    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db);
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'mine',
      settings: {},
    });
  });

  afterEach(async () => {
    globalThis.fetch = origFetch;
    delete process.env.FASTOWL_POSTHOG_KEY;
    delete process.env.FASTOWL_POSTHOG_HOST;
    await cleanup?.();
    cleanup = null;
  });

  it('is disabled without FASTOWL_POSTHOG_KEY — no HTTP at all', async () => {
    expect(isServerAnalyticsConfigured()).toBe(false);
    await captureServerEvent('user-1', 'task_completed', { a: 1 });
    captureWorkspaceEvent('ws1', 'task_dispatched');
    await flushMicrotasks();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('captures with the documented payload shape', async () => {
    process.env.FASTOWL_POSTHOG_KEY = 'phc_test';
    await captureServerEvent('user-1', 'task_completed', {
      task_id: 't1',
      opened_pr: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://us.i.posthog.com/i/v0/e/');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.api_key).toBe('phc_test');
    expect(body.event).toBe('task_completed');
    expect(body.distinct_id).toBe('user-1');
    expect(body.timestamp).toBeTruthy();
    expect(body.properties).toMatchObject({
      $lib: 'fastowl-backend',
      task_id: 't1',
      opened_pr: true,
    });
    expect(body.properties.environment).toBeTruthy();
  });

  it('respects a custom FASTOWL_POSTHOG_HOST (trailing slash stripped)', async () => {
    process.env.FASTOWL_POSTHOG_KEY = 'phc_test';
    process.env.FASTOWL_POSTHOG_HOST = 'https://eu.i.posthog.com/';
    await captureServerEvent('user-1', 'task_failed');
    expect(fetchMock.mock.calls[0][0]).toBe('https://eu.i.posthog.com/i/v0/e/');
  });

  it('captureWorkspaceEvent resolves the workspace owner and stamps workspace_id', async () => {
    process.env.FASTOWL_POSTHOG_KEY = 'phc_test';
    captureWorkspaceEvent('ws1', 'task_dispatched', { provider: 'posthog_code' });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.distinct_id).toBe(TEST_USER_ID);
    expect(body.properties).toMatchObject({
      workspace_id: 'ws1',
      provider: 'posthog_code',
    });
  });

  it('captureWorkspaceEvent drops events for unknown workspaces', async () => {
    process.env.FASTOWL_POSTHOG_KEY = 'phc_test';
    captureWorkspaceEvent('nope', 'task_dispatched');
    await flushMicrotasks();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['rejected fetch', () => fetchMock.mockRejectedValue(new Error('boom'))],
    ['non-2xx response', () => fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response)],
  ])('swallows failures: %s', async (_name, arm) => {
    process.env.FASTOWL_POSTHOG_KEY = 'phc_test';
    arm();
    await expect(
      captureServerEvent('user-1', 'task_completed'),
    ).resolves.toBeUndefined();
  });
});
