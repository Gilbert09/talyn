import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCodeReviewSettings } from '@talyn/shared';

/**
 * Code review auto-start: at turn end, a code-complete session starts a review
 * of its pull request's head, once per head, behind a flag.
 */

const m = vi.hoisted(() => ({
  flag: vi.fn(),
  getPrForReview: vi.fn(),
  getReviewForPr: vi.fn(),
  listChats: vi.fn(),
  runningJobs: vi.fn(),
  storedScriptNames: vi.fn(),
  refresh: vi.fn(),
  settings: vi.fn(),
  owner: vi.fn(),
  autoFeatures: vi.fn(),
  start: vi.fn(),
}));

vi.mock('../services/featureFlags.js', async (orig) => ({
  ...(await orig<typeof import('../services/featureFlags.js')>()),
  workspaceHasFeature: m.flag,
}));
vi.mock('../services/codeReview/store.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/store.js')>()),
  getPrForReview: m.getPrForReview,
  getReviewForPr: m.getReviewForPr,
}));
vi.mock('../services/workbenches/store.js', async (orig) => ({
  ...(await orig<typeof import('../services/workbenches/store.js')>()),
  listChats: m.listChats,
}));
vi.mock('../services/workbenches/backgroundStore.js', async (orig) => ({
  ...(await orig<typeof import('../services/workbenches/backgroundStore.js')>()),
  runningJobsQuery: m.runningJobs,
}));
vi.mock('../services/workbenches/scriptStore.js', async (orig) => ({
  ...(await orig<typeof import('../services/workbenches/scriptStore.js')>()),
  storedScriptNames: m.storedScriptNames,
}));
vi.mock('../services/prRefresh.js', async (orig) => ({
  ...(await orig<typeof import('../services/prRefresh.js')>()),
  refreshPullRequestById: m.refresh,
}));
vi.mock('../services/codeReview/workspaceSettings.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/workspaceSettings.js')>()),
  workspaceReviewSettings: m.settings,
  workspaceOwner: m.owner,
}));
vi.mock('../services/billing/entitlements.js', async (orig) => ({
  ...(await orig<typeof import('../services/billing/entitlements.js')>()),
  ownerHasAutoFeatures: m.autoFeatures,
}));
vi.mock('../services/codeReview/cycle.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/cycle.js')>()),
  startReviewCycle: m.start,
}));

const { startReviewIfCodeComplete } = await import('../services/codeReview/sessionAutoStart.js');

type Wb = Parameters<typeof startReviewIfCodeComplete>[0];

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const WB = {
  id: 'wb-1',
  workspaceId: 'ws-1',
  kind: 'session',
  runtime: 'sandbox',
  sandboxId: 'sb-1',
  pullRequestId: 'pr-1',
  archivedAt: null,
  diffStat: { added: 0, removed: 0, files: 0, uncommittedStats: { added: 0, removed: 0, files: 0 } },
  workUnpushedCommits: 0,
} as unknown as Wb;

function wb(patch: Record<string, unknown> = {}): Wb {
  return { ...WB, ...patch } as Wb;
}

function pr(state: string, headSha: string | undefined = HEAD) {
  return { id: 'pr-1', workspaceId: 'ws-1', owner: 'acme', repo: 'app', number: 7, state, lastSummary: headSha ? { headSha } : {} };
}

beforeEach(() => {
  m.flag.mockResolvedValue({ enabled: true, source: 'posthog' });
  m.getPrForReview.mockResolvedValue(pr('open'));
  m.getReviewForPr.mockResolvedValue(null);
  m.listChats.mockResolvedValue([{ id: 'c1', status: 'idle', queuedMessages: [], closedAt: null }]);
  m.runningJobs.mockResolvedValue([]);
  m.storedScriptNames.mockResolvedValue([]);
  m.refresh.mockResolvedValue({ kind: 'refreshed', rowId: 'pr-1' });
  m.settings.mockResolvedValue(resolveCodeReviewSettings({}));
  m.owner.mockResolvedValue('user-1');
  m.autoFeatures.mockResolvedValue(true);
  m.start.mockResolvedValue({ ok: true, started: true, review: { id: 'rev-1' } });
});

afterEach(() => vi.resetAllMocks());

describe('startReviewIfCodeComplete', () => {
  it('starts an automatic review of the pushed head', async () => {
    const out = await startReviewIfCodeComplete(WB, HEAD);
    expect(out).toEqual({ kind: 'started', reviewId: 'rev-1', headSha: HEAD });
    expect(m.flag).toHaveBeenCalledWith('codeReviewAutoStartOnComplete', 'ws-1');
    expect(m.start).toHaveBeenCalledWith({ pullRequestId: 'pr-1', auto: true, trigger: 'session_complete' });
    expect(m.refresh).not.toHaveBeenCalled();
  });

  it.each<[string, () => void, Wb, string | null, string]>([
    ['the flag is off', () => m.flag.mockResolvedValue({ enabled: false, source: 'fallback' }), WB, HEAD, 'flag_off'],
    ['the session is local', () => {}, wb({ runtime: 'local', sandboxId: null }), HEAD, 'local'],
    ['the session is a thread', () => {}, wb({ kind: 'thread' }), HEAD, 'thread'],
    ['the session has no pull request', () => {}, wb({ pullRequestId: null }), HEAD, 'no_pull_request'],
    ['the pull request is closed', () => m.getPrForReview.mockResolvedValue(pr('closed')), WB, HEAD, 'pull_request_not_open'],
    ['the pull request merged', () => m.getPrForReview.mockResolvedValue(pr('merged')), WB, HEAD, 'pull_request_not_open'],
    ['the pull request is gone', () => m.getPrForReview.mockResolvedValue(null), WB, HEAD, 'pull_request_not_open'],
    ['the head is already reviewed', () => m.getReviewForPr.mockResolvedValue({ phase: 'ready', reviewedHeadSha: HEAD, targetHeadSha: HEAD }), WB, HEAD, 'already_reviewed'],
    ['a cycle is in flight', () => m.getReviewForPr.mockResolvedValue({ phase: 'reviewing', reviewedHeadSha: OLD, targetHeadSha: OLD }), WB, HEAD, 'already_reviewed'],
    ['a person cancelled the cycle for the head', () => m.getReviewForPr.mockResolvedValue({ phase: 'cancelled', reviewedHeadSha: OLD, targetHeadSha: HEAD }), WB, HEAD, 'already_reviewed'],
    ['the reviewers are off', () => m.settings.mockResolvedValue(resolveCodeReviewSettings({ builtInReviewers: false })), WB, HEAD, 'settings_off'],
    ['the plan has no automatic features', () => m.autoFeatures.mockResolvedValue(false), WB, HEAD, 'plan'],
    ['the pull request has no head', () => m.getPrForReview.mockResolvedValue(pr('open', '')), WB, null, 'no_head'],
  ])('skips when %s', async (_name, arrange, row, boxHead, reason) => {
    arrange();
    const out = await startReviewIfCodeComplete(row, boxHead);
    expect(out).toMatchObject({ kind: 'skipped', reason });
    expect(m.start).not.toHaveBeenCalled();
  });

  it.each<[string, () => void, Wb, string]>([
    ['a background job runs', () => m.runningJobs.mockResolvedValue([{ id: 'job-1' }]), WB, 'background_job_running'],
    ['a session script runs', () => m.storedScriptNames.mockResolvedValue(['dev']), WB, 'script_running'],
    ['a turn runs', () => m.listChats.mockResolvedValue([{ status: 'running', queuedMessages: [], closedAt: null }]), WB, 'turn_running'],
    ['a message waits in the queue', () => m.listChats.mockResolvedValue([{ status: 'idle', queuedMessages: [{ id: 'q' }], closedAt: null }]), WB, 'turn_queued'],
    ['the agent asked a question', () => m.listChats.mockResolvedValue([{ status: 'awaiting_input', queuedMessages: [], closedAt: null }]), WB, 'chat_not_idle'],
    ['the files have uncommitted changes', () => {}, wb({ diffStat: { added: 1, removed: 0, files: 2, uncommittedStats: { added: 1, removed: 0, files: 2 } } }), 'uncommitted_changes'],
    ['the session is archived', () => {}, wb({ archivedAt: new Date() }), 'archived'],
  ])('is not code complete when %s', async (_name, arrange, row, blocker) => {
    arrange();
    const out = await startReviewIfCodeComplete(row, HEAD);
    expect(out).toMatchObject({ kind: 'skipped', reason: 'not_code_complete' });
    expect((out as { blockers: string[] }).blockers).toContain(blocker);
    expect(m.start).not.toHaveBeenCalled();
  });

  it('uses the stored unpushed count when the box did not answer', async () => {
    const out = await startReviewIfCodeComplete(wb({ workUnpushedCommits: 2 }), null);
    expect(out).toMatchObject({ kind: 'skipped', reason: 'not_code_complete', blockers: ['unpushed_commits'] });
  });

  it('starts with no box HEAD when the stored count says pushed', async () => {
    const out = await startReviewIfCodeComplete(wb({ workUnpushedCommits: 0 }), null);
    expect(out).toMatchObject({ kind: 'started' });
    expect(m.refresh).not.toHaveBeenCalled();
  });

  it('reads the pull request again when the row has an older head, then starts', async () => {
    m.getPrForReview.mockResolvedValueOnce(pr('open', OLD)).mockResolvedValueOnce(pr('open', HEAD));
    const out = await startReviewIfCodeComplete(WB, HEAD);
    expect(m.refresh).toHaveBeenCalledWith('pr-1');
    expect(out).toEqual({ kind: 'started', reviewId: 'rev-1', headSha: HEAD });
  });

  it('skips when the box HEAD is still not the pull request head after a refresh', async () => {
    m.getPrForReview.mockResolvedValue(pr('open', OLD));
    const out = await startReviewIfCodeComplete(WB, HEAD);
    expect(m.refresh).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ kind: 'skipped', reason: 'head_not_pushed' });
    expect(m.start).not.toHaveBeenCalled();
  });

  it('skips when the refresh finds the pull request closed', async () => {
    m.getPrForReview.mockResolvedValueOnce(pr('open', OLD)).mockResolvedValueOnce(pr('closed', HEAD));
    const out = await startReviewIfCodeComplete(WB, HEAD);
    expect(out).toMatchObject({ kind: 'skipped', reason: 'pull_request_not_open' });
  });

  it('starts once per head', async () => {
    expect(await startReviewIfCodeComplete(WB, HEAD)).toMatchObject({ kind: 'started' });
    m.getReviewForPr.mockResolvedValue({ phase: 'queued', reviewedHeadSha: '', targetHeadSha: '' });
    expect(await startReviewIfCodeComplete(WB, HEAD)).toMatchObject({ kind: 'skipped', reason: 'already_reviewed' });
    m.getReviewForPr.mockResolvedValue({ phase: 'ready', reviewedHeadSha: HEAD, targetHeadSha: HEAD });
    expect(await startReviewIfCodeComplete(WB, HEAD)).toMatchObject({ kind: 'skipped', reason: 'already_reviewed' });
    expect(m.start).toHaveBeenCalledTimes(1);
  });

  it('starts again for a new head', async () => {
    m.getReviewForPr.mockResolvedValue({ phase: 'ready', reviewedHeadSha: OLD, targetHeadSha: OLD });
    expect(await startReviewIfCodeComplete(WB, HEAD)).toMatchObject({ kind: 'started' });
  });

  it('reports a start that raced another one as already reviewed', async () => {
    m.start.mockResolvedValue({ ok: true, started: false, review: { id: 'rev-1' } });
    expect(await startReviewIfCodeComplete(WB, HEAD)).toMatchObject({ kind: 'skipped', reason: 'already_reviewed' });
  });

  it('reports a refused start', async () => {
    m.start.mockResolvedValue({ ok: false, code: 'no_reviewers', message: 'none' });
    expect(await startReviewIfCodeComplete(WB, HEAD)).toEqual({ kind: 'declined', code: 'no_reviewers' });
  });

  it.each([
    ['repo:acme/app:review', 'started'],
    ['repo:acme/other:review', 'skipped'],
  ])('with only the custom reviewer %s, the outcome is %s', async (skillKey, kind) => {
    m.settings.mockResolvedValue(
      resolveCodeReviewSettings({ builtInReviewers: false, customReviewers: [{ skillKey, name: 'Ours' }] }),
    );
    const out = await startReviewIfCodeComplete(WB, HEAD);
    expect(out.kind).toBe(kind);
    if (out.kind === 'skipped') expect(out.reason).toBe('settings_off');
  });

  it('never throws', async () => {
    m.listChats.mockRejectedValue(new Error('db down'));
    expect(await startReviewIfCodeComplete(WB, HEAD)).toEqual({ kind: 'failed', error: 'db down' });
  });
});
