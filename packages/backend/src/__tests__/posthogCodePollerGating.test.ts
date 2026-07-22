import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The poller resolves its PostHog client via the credentials module; mock it
// so each case scripts the remote run's status. The streamer is mocked too —
// these tests pin WHICH lifecycle calls the gate makes, not the stream itself
// (posthogCodeStreamer.test.ts covers that).
const { mockClient, mockStreamer } = vi.hoisted(() => ({
  mockClient: {
    getTask: vi.fn(),
    getSessionLogs: vi.fn(),
  },
  mockStreamer: {
    ensure: vi.fn(),
    stop: vi.fn(),
    isActive: vi.fn(() => false),
    flushNow: vi.fn(async () => undefined),
  },
}));
vi.mock('../services/posthogCode/credentials.js', () => ({
  getPostHogCodeClient: vi.fn(async () => mockClient),
}));
vi.mock('../services/posthogCode/streamer.js', () => ({
  postHogCodeStreamer: mockStreamer,
}));

import { eq } from 'drizzle-orm';
import { postHogCodePoller } from '../services/posthogCode/poller.js';
import {
  markWatched,
  isWatched,
  _resetTaskWatch,
} from '../services/cloudProviders/taskWatch.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import * as schema from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { CloudTaskRow } from '../services/cloudProviders/types.js';

const WS = 'ws-1';
const TASK = 'task-1';

function row(overrides: Partial<CloudTaskRow> = {}): CloudTaskRow {
  return {
    id: TASK,
    workspaceId: WS,
    title: 'T',
    repositoryId: null,
    metadata: { posthogTaskId: 'pt', posthogRunId: 'pr' },
    transcriptEmpty: true,
    watched: false,
    status: 'in_progress',
    completedAt: null,
    ...overrides,
  };
}

/** Script the remote task; `updated_at` is recent so idle-finalize is inert. */
function remoteTask(status: string): unknown {
  return {
    id: 'pt',
    latest_run: {
      id: 'pr',
      status,
      updated_at: new Date().toISOString(),
      output: 'done',
    },
  };
}

describe('postHogCodePoller stream gating', () => {
  let cleanup: () => Promise<void>;
  let db: Database;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    cleanup = ctx.cleanup;
    mockClient.getTask.mockReset();
    mockClient.getSessionLogs.mockReset();
    mockStreamer.ensure.mockReset();
    mockStreamer.stop.mockReset();
    mockStreamer.isActive.mockReset().mockReturnValue(false);
    _resetTaskWatch();

    await seedUser(db);
    await db.insert(schema.workspaces).values({ id: WS, ownerId: 'user-test', name: 'WS' });
    await db.insert(schema.tasks).values({
      id: TASK,
      workspaceId: WS,
      type: 'code_writing',
      status: 'in_progress',
      title: 'T',
      description: 'D',
      metadata: { posthogTaskId: 'pt', posthogRunId: 'pr' },
    });
  });

  afterEach(async () => {
    // finalize() fires a void-ed captureOutcome DB read; let it settle
    // before tearing pglite down so the close doesn't race an in-flight
    // query.
    await new Promise((r) => setTimeout(r, 50));
    await cleanup();
  });

  it.each([
    {
      name: 'in_progress + watched → live stream ensured',
      status: 'in_progress',
      watched: true,
      transcriptEmpty: true,
      isActive: false,
      expectEnsure: true,
      expectStop: false,
    },
    {
      name: 'in_progress + unwatched with an active stream → stream torn down',
      status: 'in_progress',
      watched: false,
      transcriptEmpty: true,
      isActive: true,
      expectEnsure: false,
      expectStop: true,
    },
    {
      name: 'in_progress + unwatched with no stream → nothing to do',
      status: 'in_progress',
      watched: false,
      transcriptEmpty: true,
      isActive: false,
      expectEnsure: false,
      expectStop: false,
    },
    {
      name: 'terminal + empty transcript → one-shot durable backfill regardless of watch',
      status: 'completed',
      watched: false,
      transcriptEmpty: true,
      isActive: false,
      expectEnsure: true,
      expectStop: false,
    },
    {
      name: 'terminal + transcript present → lingering stream stopped',
      status: 'completed',
      watched: false,
      transcriptEmpty: false,
      isActive: true,
      expectEnsure: false,
      expectStop: true,
    },
  ])('$name', async ({ status, watched, transcriptEmpty, isActive, expectEnsure, expectStop }) => {
    mockClient.getTask.mockResolvedValue(remoteTask(status));
    mockStreamer.isActive.mockReturnValue(isActive);

    await postHogCodePoller.reconcileTask(row({ watched, transcriptEmpty }));

    if (expectEnsure) {
      expect(mockStreamer.ensure).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: TASK, posthogTaskId: 'pt', posthogRunId: 'pr' }),
      );
    } else {
      expect(mockStreamer.ensure).not.toHaveBeenCalled();
    }
    if (expectStop) {
      expect(mockStreamer.stop).toHaveBeenCalledWith(TASK);
    } else {
      expect(mockStreamer.stop).not.toHaveBeenCalled();
    }
  });

  it('finalizing a terminal run clears the watch and completes the task', async () => {
    markWatched(TASK);
    mockClient.getTask.mockResolvedValue(remoteTask('completed'));

    await postHogCodePoller.reconcileTask(row({ transcriptEmpty: false, watched: true }));

    expect(isWatched(TASK)).toBe(false);
    const rows = await db
      .select({ status: schema.tasks.status })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, TASK));
    expect(rows[0]?.status).toBe('completed');
  });

  it('a run with no started run yet leaves the stream alone', async () => {
    mockClient.getTask.mockResolvedValue({ id: 'pt', latest_run: null });

    await postHogCodePoller.reconcileTask(row({ watched: true }));

    expect(mockStreamer.ensure).not.toHaveBeenCalled();
    expect(mockStreamer.stop).not.toHaveBeenCalled();
  });
});
