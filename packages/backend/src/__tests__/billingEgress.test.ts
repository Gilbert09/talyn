import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import {
  countActiveReviewCyclesQuery,
  countActiveTasksQuery,
  countOwnerLoopsQuery,
  countOwnerWorkflowsQuery,
  countQueuedPrsQuery,
} from '../services/billing/entitlements.js';

/**
 * Egress regression guard (see projectionEgress.test.ts): the free-limit
 * count runs on every task creation, so it must ship a single count row —
 * never task columns, and above all never the `transcript` jsonb.
 */

let cleanup: () => Promise<void>;

beforeEach(async () => {
  // Registers the process-wide DB client that countActiveTasksQuery builds on.
  ({ cleanup } = await createTestDb());
});

afterEach(async () => {
  await cleanup();
});

describe('billing count egress', () => {
  it('countActiveTasksQuery is a pure count — no task columns, no transcript', () => {
    const { sql } = countActiveTasksQuery('owner-1').toSQL();
    expect(sql).toContain('count(*)');
    expect(sql).not.toContain('transcript');
    expect(sql).not.toContain('"title"');
    expect(sql).not.toContain('last_summary');
  });

  it('excludeTaskId variant stays a pure count too', () => {
    const { sql, params } = countActiveTasksQuery('owner-1', 'task-1').toSQL();
    expect(sql).toContain('count(*)');
    expect(sql).not.toContain('transcript');
    expect(params).toContain('task-1');
  });

  it('countQueuedPrsQuery is a pure count — no PR columns, no lastSummary', () => {
    const { sql } = countQueuedPrsQuery('owner-1').toSQL();
    expect(sql).toContain('count(*)');
    expect(sql).not.toContain('last_summary');
    expect(sql).not.toContain('"title"');
  });

  it('excludePrId variant stays a pure count too', () => {
    const { sql, params } = countQueuedPrsQuery('owner-1', 'pr-1').toSQL();
    expect(sql).toContain('count(*)');
    expect(sql).not.toContain('last_summary');
    expect(params).toContain('pr-1');
  });

  it('countOwnerWorkflowsQuery is a pure count — none of the three jsonb columns', () => {
    const { sql, params } = countOwnerWorkflowsQuery('owner-1').toSQL();
    expect(sql).toContain('count(*)');
    expect(sql).not.toContain('"conditions"');
    expect(sql).not.toContain('"actions"');
    expect(sql).not.toContain('"events"');
    expect(params).toContain('owner-1');
  });

  it('countActiveReviewCyclesQuery is a pure count, and counts only cycles in flight', () => {
    // Runs on every billing snapshot AND before every review start. It must never
    // touch a review's own columns, and it must filter on phase — counting rows
    // at rest would have a user reading their findings occupy the free plan's one
    // slot until they closed the panel.
    const { sql, params } = countActiveReviewCyclesQuery('owner-1').toSQL();
    expect(sql).toContain('count(*)');
    expect(sql).toContain('phase');
    expect(sql).not.toContain('"lens_keys"');
    expect(sql).not.toContain('"last_error"');
    expect(params).toContain('owner-1');
    // `ready` is at rest, so it must be absent from the phases counted.
    expect(params).not.toContain('ready');
    expect(params).toContain('reviewing');
    expect(params).toContain('fixing');
  });

  it('countActiveReviewCyclesQuery can exclude the review being re-run', () => {
    // Same reason the merge-queue gate has it: re-reviewing a pull request that
    // already carries a review must not be blocked by that review.
    const { params } = countActiveReviewCyclesQuery('owner-1', 'rev-1').toSQL();
    expect(params).toContain('rev-1');
  });

  it('countOwnerLoopsQuery is a pure count — never the prompt', () => {
    // `loops.prompt` is unbounded user text and this runs on every billing
    // snapshot, which the desktop refreshes on create, delete and every 402.
    const { sql, params } = countOwnerLoopsQuery('owner-1').toSQL();
    expect(sql).toContain('count(*)');
    expect(sql).not.toContain('"prompt"');
    expect(sql).not.toContain('"cron"');
    expect(params).toContain('owner-1');
  });
});
