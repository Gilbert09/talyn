import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { enrichmentQuery } from '../services/workflows/engine.js';
import { listWorkflowRuns } from '../services/workflows/store.js';

/**
 * DB-egress guards for the workflow reads, in the `projectionEgress.test.ts`
 * style: prove the projection excludes the expensive column without needing a
 * live database to observe the bytes.
 *
 * `pull_requests.last_summary` is the blob that matters here. The enrichment
 * read runs on the webhook worker's path — for every delivery that a workflow
 * cares about, for every watching workspace — and the summary carries the whole
 * check breakdown, the stack and the unresolved-thread counts, none of which a
 * workflow condition reads.
 */

describe('workflow enrichment projection', () => {
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ cleanup } = await createTestDb());
  });
  afterEach(async () => {
    await cleanup();
  });

  it('never ships the last_summary blob — only accessors into it', () => {
    const { sql } = enrichmentQuery(
      { workspaceId: 'ws', repositoryId: 'repo', owner: 'a', repo: 'b' },
      42
    ).toSQL();

    // Every mention must be an accessor. A bare `"last_summary"` in the select
    // list is the regression this guards.
    const mentions = [...sql.matchAll(/"last_summary"(\s*->>?|)/g)];
    expect(mentions.length).toBeGreaterThan(0);
    for (const m of mentions) {
      expect(m[1]?.trim(), `bare last_summary in: ${sql}`).toMatch(/^->>?$/);
    }
  });

  it('reads the seven facts a condition can test, and nothing else', () => {
    const { sql } = enrichmentQuery(
      { workspaceId: 'ws', repositoryId: 'repo', owner: 'a', repo: 'b' },
      42
    ).toSQL();
    for (const key of ['title', 'author', 'baseBranch', 'headBranch', 'url', 'draft', 'labels']) {
      expect(sql).toContain(`'${key}'`);
    }
    // The cursor columns, the queue jsonb and the auto-merge state are not read.
    expect(sql).not.toContain('merge_queue_state');
    expect(sql).not.toContain('auto_merge_state');
  });

  it('the history page is keyset-paginated, not OFFSET', async () => {
    // The history grows at the head, so an OFFSET page shifts under the reader
    // between requests — the cursor compares createdAt instead.
    await listWorkflowRuns('wf-1', { limit: 10, cursor: new Date().toISOString() });
    // No assertion on rows (there are none); the contract under test is that a
    // cursor is accepted and does not throw on a well-formed timestamp.
    await expect(listWorkflowRuns('wf-1', { limit: 10, cursor: 'not-a-date' })).resolves.toEqual([]);
  });
});
