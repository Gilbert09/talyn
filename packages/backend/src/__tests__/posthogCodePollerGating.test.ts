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
import * as websocketModule from '../services/websocket.js';
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
    transcriptFinal: false,
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
      transcriptFinal: false,
      isActive: false,
      expectEnsure: true,
      expectStop: false,
    },
    {
      name: 'in_progress + unwatched with an active stream → stream torn down',
      status: 'in_progress',
      watched: false,
      transcriptFinal: false,
      isActive: true,
      expectEnsure: false,
      expectStop: true,
    },
    {
      name: 'in_progress + unwatched with no stream → nothing to do',
      status: 'in_progress',
      watched: false,
      transcriptFinal: false,
      isActive: false,
      expectEnsure: false,
      expectStop: false,
    },
    {
      name: 'terminal + no stored record → one-shot durable backfill regardless of watch',
      status: 'completed',
      watched: false,
      transcriptFinal: false,
      isActive: false,
      expectEnsure: true,
      expectStop: false,
    },
    {
      name: 'terminal + the record already stored → lingering stream stopped',
      status: 'completed',
      watched: false,
      transcriptFinal: true,
      isActive: true,
      expectEnsure: false,
      expectStop: true,
    },
    {
      // The regression: a live stream torn down mid-run (watch TTL lapsed,
      // deploy) settles its buffer into the column on the way out. That
      // transcript is NOT empty and is NOT the run's log, and gating on
      // emptiness meant this task was never backfilled again.
      name: 'terminal + a provisional transcript from a torn-down stream → still backfilled',
      status: 'completed',
      watched: false,
      transcriptFinal: false,
      isActive: false,
      expectEnsure: true,
      expectStop: false,
    },
  ])('$name', async ({ status, watched, transcriptFinal, isActive, expectEnsure, expectStop }) => {
    mockClient.getTask.mockResolvedValue(remoteTask(status));
    mockStreamer.isActive.mockReturnValue(isActive);

    await postHogCodePoller.reconcileTask(row({ watched, transcriptFinal }));

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

  /**
   * A task the poller finished is re-selected for the backfill window, and the
   * run it is about to fetch the log for cannot change — so asking the vendor
   * about it again is ~180 requests that cannot alter the answer.
   */
  it('a finished task backfills from its stored run id without asking the vendor', async () => {
    await postHogCodePoller.reconcileTask(row({ status: 'failed', transcriptFinal: false }));

    expect(mockClient.getTask).not.toHaveBeenCalled();
    expect(mockStreamer.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, posthogRunId: 'pr', backfillOnly: true }),
    );
  });

  it('a finished task that already has its log does nothing at all', async () => {
    await postHogCodePoller.reconcileTask(row({ status: 'failed', transcriptFinal: true }));

    expect(mockClient.getTask).not.toHaveBeenCalled();
    expect(mockStreamer.ensure).not.toHaveBeenCalled();
  });

  /**
   * The reason the guard above has to exist at all: everything past it ends in
   * `finalize`, which re-emits the status and re-files the outcome analytics.
   * Before the window covered non-`completed` statuses this was unreachable;
   * widening it is what made it a live hazard.
   */
  it('never re-finalizes an already-terminal task', async () => {
    const statusSpy = vi.spyOn(websocketModule, 'emitTaskStatus');
    mockClient.getTask.mockResolvedValue(remoteTask('completed'));

    await postHogCodePoller.reconcileTask(row({ status: 'failed', transcriptFinal: false }));
    await postHogCodePoller.reconcileTask(row({ status: 'cancelled', transcriptFinal: false }));
    await postHogCodePoller.reconcileTask(row({ status: 'completed', transcriptFinal: false }));

    expect(statusSpy).not.toHaveBeenCalled();
  });

  /**
   * `reviveEligible` is the gate, not the status. A task finalised the ordinary
   * way — because the REMOTE run reached a terminal state — can never resume.
   */
  it('re-checks the vendor only for an optimistically-finalized task', async () => {
    mockClient.getTask.mockResolvedValue(remoteTask('in_progress'));

    await postHogCodePoller.reconcileTask(
      row({
        status: 'completed',
        transcriptFinal: false,
        metadata: { posthogTaskId: 'pt', posthogRunId: 'pr', reviveEligible: true },
      }),
    );

    expect(mockClient.getTask).toHaveBeenCalled();
  });

  it('finalizing a terminal run clears the watch and completes the task', async () => {
    markWatched(TASK);
    const statusSpy = vi.spyOn(websocketModule, 'emitTaskStatus');
    mockClient.getTask.mockResolvedValue(remoteTask('completed'));

    await postHogCodePoller.reconcileTask(row({ transcriptFinal: true, watched: true }));

    // Also pins the spy used by the negative assertion above: a finalize that
    // really happens does reach it.
    expect(statusSpy).toHaveBeenCalledWith(WS, TASK, 'completed', expect.anything());
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

describe('postHogCodePoller — a run that stopped for a human', () => {
  let cleanup: () => Promise<void>;
  let db: Database;

  // Verbatim from task ae66b426 on PostHog/posthog#100390 — the run that
  // prompted this whole state. PostHog returned it as `failed` with the
  // agent's own prose in `error_message`, which is why the admin console
  // rendered a correct refusal under a red "Error:" heading.
  const REFUSAL =
    'PR #100390 is clean except the Visual Review gate. Storybook run 9282adc0 has 6 new / 0 ' +
    'changed / 0 unresolved snapshots; I verified all 6 PNGs as correct first baselines. ' +
    'Finalizing commits a baseline and greens a merge gate, which repo policy requires an ' +
    'explicit per-run human yes for. This run is unattended and two prior PR comments already ' +
    'state the verdict and ask, so I did not duplicate them. Needs a human to finalize or ' +
    'authorize me.';
  const SENTINEL_LINE =
    'TALYN_NEEDS_HUMAN: Finalize the 6 Visual Review baselines, or authorize me to.';

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
      type: 'pr_response',
      status: 'in_progress',
      title: 'Get PostHog/posthog#100390 mergeable',
      description: 'D',
      metadata: { posthogTaskId: 'pt', posthogRunId: 'pr' },
    });
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 50));
    await cleanup();
  });

  async function settled() {
    const rows = await db
      .select({ status: schema.tasks.status, result: schema.tasks.result })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, TASK))
      .limit(1);
    return rows[0]!;
  }

  it('lands needs_human when a FAILED run carries the sentinel', async () => {
    // The incident's exact path, and the one a design that only looked at
    // `completed` runs would have missed entirely.
    mockClient.getTask.mockResolvedValue({
      id: 'pt',
      latest_run: {
        id: 'pr',
        status: 'failed',
        updated_at: new Date().toISOString(),
        error_message: `${REFUSAL}\n${SENTINEL_LINE}`,
      },
    });

    await postHogCodePoller.reconcileTask(row({ status: 'in_progress' }));

    const task = await settled();
    expect(task.status).toBe('needs_human');
    const result = task.result as {
      success: boolean;
      error?: string;
      needsHuman?: { reason: string };
    };
    expect(result.needsHuman?.reason).toBe(
      'Finalize the 6 Visual Review baselines, or authorize me to.'
    );
    expect(result.success).toBe(false);
    // NOT an error: this string is what the admin console renders in red.
    expect(result.error).toBeUndefined();
  });

  it('still fails a run whose error carries no sentinel', async () => {
    // The guard rail. Infra failures must keep failing, or the watcher would
    // stand down on a transient and never retry.
    mockClient.getTask.mockResolvedValue({
      id: 'pt',
      latest_run: {
        id: 'pr',
        status: 'failed',
        updated_at: new Date().toISOString(),
        error_message: 'sandbox exited with code 137',
      },
    });

    await postHogCodePoller.reconcileTask(row({ status: 'in_progress' }));

    const task = await settled();
    expect(task.status).toBe('failed');
    expect((task.result as { error?: string }).error).toBe('sandbox exited with code 137');
  });

  it('lands needs_human when a COMPLETED run carries the sentinel in final_message', async () => {
    mockClient.getTask.mockResolvedValue({
      id: 'pt',
      latest_run: {
        id: 'pr',
        status: 'completed',
        updated_at: new Date().toISOString(),
        output: { final_message: `${REFUSAL}\n${SENTINEL_LINE}` },
      },
    });

    await postHogCodePoller.reconcileTask(row({ status: 'in_progress' }));

    expect((await settled()).status).toBe('needs_human');
  });

  it('completes normally when the closing message has no sentinel', async () => {
    // A workspace that forked the prompt template loses the instruction. That
    // must degrade to exactly today's behaviour, never a mis-classification.
    mockClient.getTask.mockResolvedValue({
      id: 'pt',
      latest_run: {
        id: 'pr',
        status: 'completed',
        updated_at: new Date().toISOString(),
        output: { final_message: 'All checks are green and the PR is mergeable.' },
      },
    });

    await postHogCodePoller.reconcileTask(row({ status: 'in_progress' }));

    const task = await settled();
    expect(task.status).toBe('completed');
    expect((task.result as { success: boolean }).success).toBe(true);
  });
});
