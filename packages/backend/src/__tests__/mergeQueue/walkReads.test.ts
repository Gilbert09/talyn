// The per-walk memo of workspace-wide reads, and the delay before a dirty
// group walks again. Both exist so a 100-entry eager queue on a busy repo does
// not re-read the same workspace facts once per entry, walk after walk.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWalkReads, type WalkReads } from '../../services/mergeQueue/executor.js';
import {
  DIRTY_RERUN_DELAY_MS,
  scheduleGroupEvaluation,
} from '../../services/mergeQueue/evaluator.js';
import * as storeModule from '../../services/mergeQueue/store.js';
import { createTestDb } from '../helpers/testDb.js';

function spyReaders() {
  return {
    cloudEnv: vi.fn(async (ws: string) => ({ envId: `env-${ws}`, provider: 'posthog_code' as const })),
    visualReviewSettings: vi.fn(async (ws: string) => ({ projectId: `p-${ws}` })),
  };
}

describe('createWalkReads', () => {
  it.each([
    ['cloudEnv', 1],
    ['cloudEnv', 5],
    ['visualReviewSettings', 1],
    ['visualReviewSettings', 5],
  ] as const)('%s reads once for %i entries of one workspace', async (read, entries) => {
    const readers = spyReaders();
    const reads = createWalkReads(readers);
    const answers = await Promise.all(
      Array.from({ length: entries }, () => (reads[read] as WalkReads[typeof read])('ws1'))
    );
    expect(readers[read]).toHaveBeenCalledTimes(1);
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
  });

  it('reads each workspace separately', async () => {
    const readers = spyReaders();
    const reads = createWalkReads(readers);
    expect(await reads.cloudEnv('ws1')).toEqual({ envId: 'env-ws1', provider: 'posthog_code' });
    expect(await reads.cloudEnv('ws2')).toEqual({ envId: 'env-ws2', provider: 'posthog_code' });
    await reads.cloudEnv('ws1');
    expect(readers.cloudEnv).toHaveBeenCalledTimes(2);
  });

  it('reads nothing until an entry asks', () => {
    const readers = spyReaders();
    createWalkReads(readers);
    expect(readers.cloudEnv).not.toHaveBeenCalled();
    expect(readers.visualReviewSettings).not.toHaveBeenCalled();
  });

  it.each(['cloudEnv', 'visualReviewSettings'] as const)(
    'forgets a failed %s read, so the next entry asks again',
    async (read) => {
      const readers = spyReaders();
      readers[read].mockRejectedValueOnce(new Error('transient'));
      const reads = createWalkReads(readers);
      await expect(reads[read]('ws1')).rejects.toThrow('transient');
      await expect(reads[read]('ws1')).resolves.toBeTruthy();
      await reads[read]('ws1');
      expect(readers[read]).toHaveBeenCalledTimes(2);
    }
  );

  it('a new walk reads again', async () => {
    const readers = spyReaders();
    await createWalkReads(readers).cloudEnv('ws1');
    await createWalkReads(readers).cloudEnv('ws1');
    expect(readers.cloudEnv).toHaveBeenCalledTimes(2);
  });
});

describe('scheduleGroupEvaluation re-run delay', () => {
  let cleanup: () => Promise<void>;
  let walkStarts: number[];

  beforeEach(async () => {
    cleanup = (await createTestDb()).cleanup;
    walkStarts = [];
    // An empty group: the walk records its start, waits a moment so triggers
    // can land mid-walk, and ends.
    vi.spyOn(storeModule, 'loadActiveGroup').mockImplementation(async () => {
      walkStarts.push(Date.now());
      await new Promise((r) => setTimeout(r, 50));
      return [];
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  it.each([
    ['a check burst waits out the delay', ['webhook:check_run', 'webhook:check_run'], true],
    ['a reconcile waits out the delay', ['reconcile'], true],
    ['a user enqueue does not wait', ['webhook:check_run', 'user:enqueue'], false],
    ['a user dequeue does not wait', ['user:dequeue'], false],
  ])('%s', async (_label, midWalk, waits) => {
    const base = `b-${Math.random()}`;
    scheduleGroupEvaluation('repo1', base, 'pr:snapshot');
    await vi.waitFor(() => expect(walkStarts).toHaveLength(1));
    for (const trigger of midWalk) scheduleGroupEvaluation('repo1', base, trigger);

    await vi.waitFor(() => expect(walkStarts).toHaveLength(2), { timeout: 5_000 });
    const gap = walkStarts[1]! - walkStarts[0]!;
    if (waits) expect(gap).toBeGreaterThanOrEqual(DIRTY_RERUN_DELAY_MS - 50);
    else expect(gap).toBeLessThan(DIRTY_RERUN_DELAY_MS / 2);

    // Every mid-walk trigger was folded into that one re-run.
    await new Promise((r) => setTimeout(r, 100));
    expect(walkStarts).toHaveLength(2);
  });

  it('a user trigger during the delay ends the wait', async () => {
    const base = `b-${Math.random()}`;
    scheduleGroupEvaluation('repo1', base, 'pr:snapshot');
    await vi.waitFor(() => expect(walkStarts).toHaveLength(1));
    scheduleGroupEvaluation('repo1', base, 'webhook:check_run');
    // Let the first walk end and the delay begin.
    await new Promise((r) => setTimeout(r, 200));
    expect(walkStarts).toHaveLength(1);
    scheduleGroupEvaluation('repo1', base, 'user:enqueue');

    await vi.waitFor(() => expect(walkStarts).toHaveLength(2), { timeout: 1_000 });
    expect(walkStarts[1]! - walkStarts[0]!).toBeLessThan(DIRTY_RERUN_DELAY_MS / 2);
  });
});
