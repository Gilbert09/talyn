import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCodeReviewSettings } from '@talyn/shared';

/**
 * Auto-fix stands down beside a live session. Unattended, it would push to the
 * branch the session's agent is working on; the findings stay for the session.
 */

const m = vi.hoisted(() => ({
  startFixRun: vi.fn(),
  appendReviewEvent: vi.fn(),
  liveWorkbenchForPr: vi.fn(),
}));

vi.mock('../services/codeReview/findings.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/findings.js')>()),
  markStale: vi.fn().mockResolvedValue(0),
  listFindings: vi.fn().mockResolvedValue([
    { id: 'f1', severity: 'blocker', verdict: 'confirmed', disposition: 'open', anchorVerified: true },
  ]),
}));
vi.mock('../services/codeReview/store.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/store.js')>()),
  casTransition: vi.fn().mockResolvedValue(true),
  getReview: vi.fn().mockResolvedValue({
    id: 'rev-1',
    workspaceId: 'ws-1',
    pullRequestId: 'pr-1',
    phase: 'ready',
    version: 2,
  }),
  appendReviewEvent: m.appendReviewEvent,
}));
vi.mock('../services/codeReview/analytics.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/analytics.js')>()),
  captureCycleFinished: vi.fn(),
}));
vi.mock('../services/codeReview/cycle.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/cycle.js')>()),
  workspaceReviewSettings: vi.fn().mockResolvedValue(resolveCodeReviewSettings({ autoFix: true })),
}));
vi.mock('../services/codeReview/fix.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/fix.js')>()),
  startFixRun: m.startFixRun,
}));
vi.mock('../services/workbenches/prSessions.js', async (orig) => ({
  ...(await orig<typeof import('../services/workbenches/prSessions.js')>()),
  liveWorkbenchForPr: m.liveWorkbenchForPr,
}));

const { finishCycle } = await import('../services/codeReview/executor.js');

const review = {
  id: 'rev-1',
  workspaceId: 'ws-1',
  pullRequestId: 'pr-1',
  phase: 'judging',
  version: 1,
  cycle: 1,
  targetHeadSha: 'sha',
} as unknown as Parameters<typeof finishCycle>[0];

afterEach(() => vi.clearAllMocks());

describe('code-review auto-fix beside a live session', () => {
  it('records why it skipped and starts no fix run', async () => {
    m.liveWorkbenchForPr.mockResolvedValue({ id: 'wb-1', name: 'paris', status: 'ready' });

    await finishCycle(review);

    expect(m.liveWorkbenchForPr).toHaveBeenCalledWith('ws-1', 'pr-1');
    expect(m.startFixRun).not.toHaveBeenCalled();
    expect(m.appendReviewEvent).toHaveBeenCalledWith(
      'rev-1',
      expect.objectContaining({
        code: 'auto_fix_session_active',
        message: expect.stringContaining('"paris"'),
        detail: { workbenchId: 'wb-1' },
      })
    );
  });

  it('fixes as before when no session works the PR', async () => {
    m.liveWorkbenchForPr.mockResolvedValue(null);
    m.startFixRun.mockResolvedValue({ ok: true, taskId: 't1' });

    await finishCycle(review);

    expect(m.startFixRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'rev-1' }), ['f1'], null);
    expect(m.appendReviewEvent).not.toHaveBeenCalled();
  });
});
