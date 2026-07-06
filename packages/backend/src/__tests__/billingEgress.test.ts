import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { countActiveTasksQuery } from '../services/billing/entitlements.js';

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
});
