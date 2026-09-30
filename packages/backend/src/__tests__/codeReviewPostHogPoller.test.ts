import { describe, it, expect, beforeEach, vi } from 'vitest';

// Every PostHog Code review unit used to time out at 30 minutes (12 of 12,
// 2026-09-28/29): PostHog leaves a background run `in_progress` after the agent
// ends its turn, and the poller waited for a terminal status that never came,
// while the sessions stayed open. These pin the turn_complete path and the
// release of the remote run.

const { client, settleRun, patchRun, ingestUnitOutput, getReview } = vi.hoisted(() => ({
  client: {
    getTask: vi.fn(),
    getSessionLogs: vi.fn(),
    cancelRun: vi.fn(),
  },
  settleRun: vi.fn(),
  patchRun: vi.fn(),
  ingestUnitOutput: vi.fn(),
  getReview: vi.fn(),
}));
vi.mock('../services/posthogCode/credentials.js', () => ({
  getPostHogCodeClient: vi.fn(async () => client),
}));
vi.mock('../services/codeReview/store.js', () => ({
  getReview,
  loadDispatchedRuns: vi.fn(async () => []),
  patchRun,
  settleRun,
}));
vi.mock('../services/codeReview/executor.js', () => ({ ingestUnitOutput }));
vi.mock('../services/codeReview/evaluator.js', () => ({ scheduleReviewEvaluation: vi.fn() }));

import { codeReviewPoller } from '../services/codeReview/poller.js';
import type { RunRow } from '../services/codeReview/store.js';

type Reconcile = { reconcileRun(run: RunRow): Promise<void> };
const reconcile = (run: RunRow) => (codeReviewPoller as unknown as Reconcile).reconcileRun(run);

let seq = 0;
function unit(over: Partial<RunRow> = {}): RunRow {
  seq += 1;
  return {
    id: `run-${seq}`,
    reviewId: 'rev-1',
    workspaceId: 'ws-1',
    provider: 'posthog_code',
    remoteTaskId: 'task-1',
    remoteRunId: 'remote-1',
    sandboxId: null,
    eventCursor: 0,
    dispatchedAt: new Date(Date.now() - 4 * 60_000),
    status: 'running',
    ...over,
  } as RunRow;
}

const update = (sessionUpdate: string, text?: string) => ({
  notification: {
    method: 'session/update',
    params: { update: { sessionUpdate, ...(text ? { content: { type: 'text', text } } : {}) } },
  },
});
const turnComplete = { notification: { method: '_posthog/turn_complete' } };
const FINDINGS = 'Reviewed.\nTALYN_CODE_REVIEW_FINDINGS:\n```json\n[]\n```';

describe('code review poller — PostHog Code units', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getReview.mockResolvedValue({ id: 'rev-1' });
    client.cancelRun.mockResolvedValue({});
    client.getTask.mockResolvedValue({
      latest_run: { status: 'in_progress', updated_at: new Date().toISOString(), output: {} },
    });
  });

  it('settles a unit whose agent ended its turn, from the message rebuilt out of the log', async () => {
    client.getSessionLogs.mockResolvedValue({
      entries: [
        update('tool_call'),
        update('agent_message_chunk', FINDINGS.slice(0, 20)),
        update('agent_message_chunk', FINDINGS.slice(20)),
        turnComplete,
      ],
    });
    const run = unit();
    await reconcile(run);

    expect(ingestUnitOutput).toHaveBeenCalledWith({ id: 'rev-1' }, run, FINDINGS);
    // The session is released rather than left idling on PostHog's side.
    expect(client.cancelRun).toHaveBeenCalledWith('task-1', 'remote-1');
    expect(settleRun).not.toHaveBeenCalled();
  });

  it('prefers the structured final message when PostHog wrote one', async () => {
    client.getTask.mockResolvedValue({
      latest_run: { status: 'in_progress', updated_at: new Date().toISOString(), output: { final_message: FINDINGS } },
    });
    client.getSessionLogs.mockResolvedValue({ entries: [update('agent_message_chunk', 'partial'), turnComplete] });
    const run = unit();
    await reconcile(run);
    expect(ingestUnitOutput).toHaveBeenCalledWith({ id: 'rev-1' }, run, FINDINGS);
  });

  it.each([
    ['a tool call', [update('agent_message_chunk', 'x'), update('tool_call')]],
    ['an agent message still streaming', [update('agent_message_chunk', 'x')]],
    ['nothing yet', []],
  ])('leaves a unit alone while its log ends on %s', async (_l, entries) => {
    client.getSessionLogs.mockResolvedValue({ entries });
    await reconcile(unit());
    expect(ingestUnitOutput).not.toHaveBeenCalled();
    expect(client.cancelRun).not.toHaveBeenCalled();
  });

  it('reads the log at most once per window for a unit still working', async () => {
    client.getSessionLogs.mockResolvedValue({ entries: [update('tool_call')] });
    const run = unit();
    await reconcile(run);
    await reconcile(run);
    expect(client.getSessionLogs).toHaveBeenCalledTimes(1);
  });

  it('still settles a run PostHog reports as completed', async () => {
    client.getTask.mockResolvedValue({ latest_run: { status: 'completed', output: { final_message: FINDINGS } } });
    const run = unit();
    await reconcile(run);
    expect(client.getSessionLogs).not.toHaveBeenCalled();
    expect(ingestUnitOutput).toHaveBeenCalledWith({ id: 'rev-1' }, run, FINDINGS);
  });

  it('cancels the remote run when a unit is reaped as overdue', async () => {
    await reconcile(unit({ dispatchedAt: new Date(Date.now() - 31 * 60_000) }));
    expect(settleRun).toHaveBeenCalledWith(expect.any(String), { status: 'failed', failureCode: 'timeout' });
    expect(client.cancelRun).toHaveBeenCalledWith('task-1', 'remote-1');
  });
});
