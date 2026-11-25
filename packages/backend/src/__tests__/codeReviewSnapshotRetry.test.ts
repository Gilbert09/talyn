import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCodeReviewSettings } from '@talyn/shared';

/**
 * The PR snapshot poll retries a session-complete review start that the box
 * gate deferred: nothing else tries it again until the session takes a turn.
 */

const m = vi.hoisted(() => ({
  getReviewForPr: vi.fn(),
  getPrForReview: vi.fn(),
  settings: vi.fn(),
  owner: vi.fn(),
  autoFeatures: vi.fn(),
  startCycle: vi.fn(),
  startIfComplete: vi.fn(),
  liveWorkbench: vi.fn(),
  getWorkbench: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock('../services/codeReview/store.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/store.js')>()),
  getReviewForPr: m.getReviewForPr,
  getPrForReview: m.getPrForReview,
}));
vi.mock('../services/codeReview/cycle.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/cycle.js')>()),
  workspaceReviewSettings: m.settings,
  workspaceOwner: m.owner,
  startReviewCycle: m.startCycle,
}));
vi.mock('../services/billing/entitlements.js', async (orig) => ({
  ...(await orig<typeof import('../services/billing/entitlements.js')>()),
  ownerHasAutoFeatures: m.autoFeatures,
}));
vi.mock('../services/codeReview/sessionAutoStart.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/sessionAutoStart.js')>()),
  startReviewIfCodeComplete: m.startIfComplete,
}));
vi.mock('../services/workbenches/prSessions.js', async (orig) => ({
  ...(await orig<typeof import('../services/workbenches/prSessions.js')>()),
  liveWorkbenchForPr: m.liveWorkbench,
}));
vi.mock('../services/workbenches/store.js', async (orig) => ({
  ...(await orig<typeof import('../services/workbenches/store.js')>()),
  getWorkbench: m.getWorkbench,
}));
vi.mock('../services/codeReview/evaluator.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/evaluator.js')>()),
  scheduleReviewEvaluation: m.schedule,
}));

const { onSnapshot } = await import('../services/codeReview/triggers.js');

const HEAD = 'a'.repeat(40);
const DEFERRED = { id: 'rev-1', phase: 'ready', reviewedHeadSha: 'b'.repeat(40), targetHeadSha: 'b'.repeat(40), lastError: 'Your plan allows 2 boxes at once.' };
const WB = { id: 'wb-1', workspaceId: 'ws-1', pullRequestId: 'pr-1' };

beforeEach(() => {
  m.getReviewForPr.mockResolvedValue(DEFERRED);
  m.getPrForReview.mockResolvedValue({ id: 'pr-1', lastSummary: { headSha: HEAD } });
  m.settings.mockResolvedValue(resolveCodeReviewSettings({}));
  m.owner.mockResolvedValue('user-1');
  m.autoFeatures.mockResolvedValue(false);
  m.startCycle.mockResolvedValue({ ok: true, started: true, review: { id: 'rev-1' } });
  m.startIfComplete.mockResolvedValue({ kind: 'started', reviewId: 'rev-1', headSha: HEAD });
  m.liveWorkbench.mockResolvedValue({ id: 'wb-1', name: 'paris', status: 'ready' });
  m.getWorkbench.mockResolvedValue(WB);
});

afterEach(() => vi.resetAllMocks());

describe('onSnapshot retries a deferred session-complete start', () => {
  it('retries with the live session and no box HEAD', async () => {
    await onSnapshot('pr-1', 'ws-1', 'open');
    expect(m.liveWorkbench).toHaveBeenCalledWith('ws-1', 'pr-1');
    expect(m.getWorkbench).toHaveBeenCalledWith('wb-1');
    expect(m.startIfComplete).toHaveBeenCalledWith(WB, null);
    expect(m.startCycle).not.toHaveBeenCalled();
  });

  it('retries when auto review is on but the plan no longer has it', async () => {
    m.settings.mockResolvedValue(resolveCodeReviewSettings({ autoReview: true }));
    m.autoFeatures.mockResolvedValue(false);
    await onSnapshot('pr-1', 'ws-1', 'open');
    expect(m.startIfComplete).toHaveBeenCalledTimes(1);
    expect(m.startCycle).not.toHaveBeenCalled();
  });

  it.each<[string, () => void, 'open' | 'closed' | 'merged']>([
    ['no error is recorded', () => m.getReviewForPr.mockResolvedValue({ ...DEFERRED, lastError: null }), 'open'],
    ['the pull request has no review', () => m.getReviewForPr.mockResolvedValue(null), 'open'],
    ['the workspace turned session reviews off', () => m.settings.mockResolvedValue(resolveCodeReviewSettings({ reviewOnSessionComplete: false })), 'open'],
    ['no live session owns the pull request', () => m.liveWorkbench.mockResolvedValue(null), 'open'],
    ['the session row is gone', () => m.getWorkbench.mockResolvedValue(null), 'open'],
    ['the pull request is closed', () => {}, 'closed'],
    ['the pull request merged', () => {}, 'merged'],
    ['a cycle is in flight', () => m.getReviewForPr.mockResolvedValue({ ...DEFERRED, phase: 'reviewing' }), 'open'],
  ])('does not retry when %s', async (_name, arrange, state) => {
    arrange();
    await onSnapshot('pr-1', 'ws-1', state);
    expect(m.startIfComplete).not.toHaveBeenCalled();
  });

  it('leaves the start to auto review when auto review runs on this plan', async () => {
    m.settings.mockResolvedValue(resolveCodeReviewSettings({ autoReview: true }));
    m.autoFeatures.mockResolvedValue(true);
    await onSnapshot('pr-1', 'ws-1', 'open');
    expect(m.startIfComplete).not.toHaveBeenCalled();
    expect(m.startCycle).toHaveBeenCalledWith({ pullRequestId: 'pr-1', auto: true });
  });
});
