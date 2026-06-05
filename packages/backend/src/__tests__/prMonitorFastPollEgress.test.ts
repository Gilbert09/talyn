import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import { inProgressChecks } from '../services/prMonitor.js';
import type { Database } from '../db/client.js';

/**
 * `prMonitor.fastPollWorkspace` no longer selects the `lastSummary` jsonb for
 * every authored open PR every 10s — it derives the only field it needs (the
 * in-flight check count) server-side. This pins that SQL expression to the
 * exact JS semantics it replaced (`inProgressChecks`) across every summary
 * shape, using real Postgres jsonb semantics via pglite.
 */

let db: Database;
let cleanup: () => Promise<void>;

/** The exact derivation used in prMonitor.fastPollWorkspace's select. */
const inProgressChecksExpr = sql<number>`COALESCE((${pullRequestsTable.lastSummary} -> 'checks' ->> 'inProgress')::int, 0)`;

async function seedPr(id: string, lastSummary: unknown): Promise<void> {
  await db.insert(pullRequestsTable).values({
    id,
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    owner: 'acme',
    repo: 'app',
    number: Number(id.replace(/\D/g, '')) || 1,
    state: 'open',
    authored: true,
    lastSummary: lastSummary as object,
  });
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  await seedUser(db, { id: 'owner1' });
  await db
    .insert(workspacesTable)
    .values({ id: 'ws1', ownerId: 'owner1', name: 'ws', settings: {} });
  await db
    .insert(repositoriesTable)
    .values({ id: 'repo1', workspaceId: 'ws1', name: 'acme/app', url: 'https://x' });
});

afterEach(async () => {
  await cleanup();
});

describe('narrowed inProgressChecks SQL', () => {
  it.each([
    ['null-ish empty summary', {}, 0],
    ['no checks key', { title: 't' }, 0],
    ['empty checks object', { checks: {} }, 0],
    ['inProgress 0', { checks: { inProgress: 0 } }, 0],
    ['inProgress 3', { checks: { inProgress: 3 } }, 3],
    ['inProgress with other fields', { checks: { inProgress: 2, failed: 1 } }, 2],
  ])('%s → %s, matching inProgressChecks()', async (label, summary, expected) => {
    const id = `pr-${label.replace(/\s+/g, '-')}`;
    await seedPr(id, summary);

    const [row] = await db
      .select({ id: pullRequestsTable.id, inProgressChecks: inProgressChecksExpr })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, id));

    expect(row.inProgressChecks).toBe(expected);
    // Must stay equivalent to the canonical JS definition the SQL replaced.
    expect(row.inProgressChecks).toBe(inProgressChecks(summary));
  });

  it('filters to PRs with in-flight checks, like the fast loop', async () => {
    await seedPr('pr1', { checks: { inProgress: 2 } });
    await seedPr('pr2', { checks: { inProgress: 0 } });
    await seedPr('pr3', {});

    const rows = await db
      .select({ id: pullRequestsTable.id, inProgressChecks: inProgressChecksExpr })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.authored, true));

    const due = rows.filter((r) => r.inProgressChecks > 0).map((r) => r.id);
    expect(due).toEqual(['pr1']);
  });
});
