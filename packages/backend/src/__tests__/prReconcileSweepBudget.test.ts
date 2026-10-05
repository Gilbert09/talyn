import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prReconcileSweep } from '../services/prReconcileSweep.js';
import { prMonitorService } from '../services/prMonitor.js';
import { githubService } from '../services/github.js';
import { graphqlBudget } from '../services/graphqlBudget.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';

/**
 * The sweep must end on time, and it must not always sweep the same few.
 *
 * It walked every connected workspace SERIALLY with nothing bounding any of
 * them. On 2026-10-05 GitHub's budgets ran dry across several accounts, every
 * refresh slowed to a crawl, and the sweep blew its 600s ceiling — at which
 * point two mechanisms that each look safe combined into one that is not:
 *
 *   - the lock watchdog ABANDONS an overrunning tick, which stops waiting for
 *     the work but does not stop the work (see `withDeadline` in
 *     advisoryLock.ts);
 *   - `TickGuard` FORCE-RELEASES at the same ceiling, so the next tick starts.
 *
 * So a second sweep began on top of a first that was still running, orphans
 * accumulated holding pool connections, and the 20-connection pool ran out.
 * `dbWatchdog` then restarted production to get it back — which is what the
 * "Talyn is having trouble on our side" banner is, seen from a browser.
 *
 * The fix gives each refresh what is LEFT of the tick's budget and stops the
 * loop when there is none, so the watchdog never has to fire. Pinned here as
 * the two properties that follow: the tick ends by itself, and the workspaces
 * it could not reach are the ones the next tick starts with.
 */
describe('prReconcileSweep — the tick ends inside its own budget', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db
      .insert(workspacesTable)
      .values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    vi.spyOn(githubService, 'accountKeyFor').mockReturnValue('inst:1');
    vi.spyOn(graphqlBudget, 'shouldDefer').mockReturnValue(false);
    vi.spyOn(prMonitorService, 'sweepClosedViaRest').mockResolvedValue(0);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanup();
    vi.restoreAllMocks();
  });

  // The property that stops the orphan pile-up: a refresh that never returns is
  // cut off at the budget, so the tick completes rather than being abandoned
  // with its work still running.
  it('returns even when a workspace refresh never settles', async () => {
    vi.spyOn(githubService, 'getConnectedWorkspaces').mockReturnValue(['ws1']);
    vi.spyOn(prMonitorService, 'refreshWorkspaceNow').mockReturnValue(new Promise(() => {}));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const tick = prReconcileSweep.runOnce();
    // The guard's own ceiling, which is the budget the sweep now honours.
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    await expect(tick).resolves.toBeUndefined();
  });

  // The other half: coverage must rotate — but only where rotation MEANS
  // something. A tick that gets all the way through its list has no remainder
  // and correctly starts again at the front; the case that matters is the one
  // that ran out of budget part-way, which is the case the old code could not
  // even reach because it never stopped.
  it('resumes at the workspace the previous tick could not reach', async () => {
    const ids = ['ws-a', 'ws-b', 'ws-c'];
    vi.spyOn(githubService, 'getConnectedWorkspaces').mockReturnValue(ids);
    const seen: string[] = [];
    // The first workspace each tick touches eats the whole budget, so exactly
    // one workspace is swept per tick and the other two are left for later.
    let hang = '';
    vi.spyOn(prMonitorService, 'refreshWorkspaceNow').mockImplementation((id: string) => {
      seen.push(id);
      if (id === hang) return new Promise(() => {});
      return Promise.resolve({ failedRepos: 0 });
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });

    hang = ids[0]!;
    let tick = prReconcileSweep.runOnce();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    await tick;
    const firstStart = seen[0];
    expect(seen).toEqual([firstStart]);

    // Next tick: the one that was starved goes first, not the one already done.
    const nextExpected = ids[(ids.indexOf(firstStart!) + 1) % ids.length];
    seen.length = 0;
    hang = nextExpected!;
    tick = prReconcileSweep.runOnce();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    await tick;

    expect(seen[0]).toBe(nextExpected);
    expect(seen[0]).not.toBe(firstStart);
  });
});
