import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The box gate on code review: a cycle start (one small box) and a fix run.
 * A person's start throws the refusal (the route answers 402 with the
 * notice); an automatic one records it on the review once, and the next
 * trigger after the owner hold ends tries again.
 */

const { capture, getReviewForPr, casTransition, ensureReview, runBoxGate, createCloudTask } = vi.hoisted(() => ({
  capture: vi.fn(),
  getReviewForPr: vi.fn(),
  casTransition: vi.fn(async () => true),
  ensureReview: vi.fn(),
  runBoxGate: vi.fn(),
  createCloudTask: vi.fn(),
}));

vi.mock('../services/analytics.js', () => ({ captureWorkspaceEvent: capture }));
vi.mock('../services/codeReview/evaluator.js', () => ({ scheduleReviewEvaluation: vi.fn() }));
vi.mock('../services/billing/boxDeferral.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/billing/boxDeferral.js')>()),
  runBoxGate,
}));
vi.mock('../services/codeReview/store.js', () => ({
  getPrForReview: vi.fn(async () => ({
    id: 'pr-1',
    workspaceId: 'ws-1',
    repositoryId: 'repo-1',
    owner: 'acme',
    repo: 'api',
    number: 7,
    state: 'open',
    lastSummary: { title: 'x', headBranch: 'f', baseBranch: 'main' },
  })),
  getReviewForPr,
  ensureReview,
  casTransition,
  appendReviewEvent: vi.fn(),
}));
vi.mock('../services/codeReview/findings.js', () => ({
  discardFindings: vi.fn(async () => 0),
  findingsForFix: vi.fn(async () => [
    { id: 'f1', severity: 'blocker', filePath: 'a.ts', lineStart: 1, lineEnd: 2, title: 't', body: 'b', suggestion: null },
  ]),
  markFixed: vi.fn(),
  markSelectedForFix: vi.fn(async () => 1),
  unmarkFixed: vi.fn(),
}));
vi.mock('../services/codeReview/workspaceSettings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/codeReview/workspaceSettings.js')>()),
  workspaceOwner: vi.fn(async () => 'owner-1'),
  workspacePreset: vi.fn(async () => 'standard'),
  workspaceReviewSettings: vi.fn(async () => ({
    preset: 'standard',
    builtInReviewers: true,
    customReviewers: [],
    fixSummaryComment: false,
    autoReview: true,
  })),
}));
vi.mock('../services/taskCreate.js', () => ({ createCloudTask }));
vi.mock('../services/prCloudFix.js', () => ({ resolveCloudEnv: vi.fn(async () => ({ envId: 'env-1', provider: 'selfhosted' })) }));
vi.mock('../services/promptTemplates.js', () => ({ workspacePromptTemplate: vi.fn(async () => null) }));
vi.mock('../services/selfHosted/credentials.js', () => ({ getSelfHostedClient: vi.fn() }));
vi.mock('../services/posthogCode/credentials.js', () => ({ getPostHogCodeClient: vi.fn() }));

const { ConcurrentBoxLimitError, SizeRequiresProError, UsageExhaustedError } = await import('../services/billing/entitlements.js');
const { startReviewCycle } = await import('../services/codeReview/cycle.js');
const { startFixRun } = await import('../services/codeReview/fix.js');

const refusals = [
  ['out of hours', () => new UsageExhaustedError({ tier: 'free', periodEnd: new Date(Date.now() + 86_400_000) }), 'usage_exhausted', 'deferred_usage_exhausted'],
  ['at the box cap', () => new ConcurrentBoxLimitError(2, 2), 'box_limit_reached', 'deferred_box_limit'],
  ['a size the plan cannot start', () => new SizeRequiresProError({ tier: 'free', size: 'large' }), 'size_requires_pro', 'deferred_size_requires_pro'],
] as const;

const restingReview = (lastError: string | null = null) => ({
  id: 'rev-1',
  workspaceId: 'ws-1',
  repositoryId: 'repo-1',
  pullRequestId: 'pr-1',
  phase: 'ready',
  cycle: 1,
  version: 3,
  startedBy: null,
  lastError,
});

describe('startReviewCycle and the box gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getReviewForPr.mockResolvedValue(restingReview());
    runBoxGate.mockImplementation(async (_owner: string, _opts: unknown, fn: () => Promise<unknown>) => fn());
  });

  it.each([
    ['a person', {}, false],
    ['the auto-review trigger', { auto: true }, true],
    ['a workflow', { auto: true, trigger: 'workflow' as const }, true],
  ])('%s asks for one small box, unattended=%s', async (_label, input, unattended) => {
    await startReviewCycle({ pullRequestId: 'pr-1', ...input });
    expect(runBoxGate).toHaveBeenCalledWith('owner-1', { size: 'small', unattended, workspaceId: 'ws-1' }, expect.any(Function));
  });

  it.each(refusals)('a person refused %s gets the error (the route makes it a 402)', async (_label, make) => {
    const err = make();
    runBoxGate.mockRejectedValue(err);
    await expect(startReviewCycle({ pullRequestId: 'pr-1' })).rejects.toBe(err);
    expect(casTransition).not.toHaveBeenCalled();
  });

  it.each(refusals)('an automatic start refused %s is recorded on the review once', async (_label, make, reason, eventCode) => {
    const err = make();
    runBoxGate.mockRejectedValue(err);

    const outcome = await startReviewCycle({ pullRequestId: 'pr-1', auto: true });

    expect(outcome).toMatchObject({ ok: false, code: 'deferred', message: err.message, deferral: { reason }, error: err });
    expect(casTransition).toHaveBeenCalledTimes(1);
    expect(casTransition).toHaveBeenCalledWith(
      'rev-1',
      3,
      { lastError: err.message, lastErrorAt: expect.any(Date) },
      expect.objectContaining({ fromPhase: 'ready', toPhase: 'ready', trigger: 'auto', code: eventCode, message: err.message })
    );
    expect(capture.mock.calls.some(([, e]) => e === 'code_review_started')).toBe(false);

    // The next snapshot hands back the same refusal: nothing is written again.
    getReviewForPr.mockResolvedValue(restingReview(err.message));
    await startReviewCycle({ pullRequestId: 'pr-1', auto: true });
    expect(casTransition).toHaveBeenCalledTimes(1);
  });

  it('an automatic refusal on a PR with no review yet opens one to carry the note', async () => {
    getReviewForPr.mockResolvedValue(null);
    ensureReview.mockResolvedValue(restingReview());
    runBoxGate.mockRejectedValue(new ConcurrentBoxLimitError(2, 2));
    await startReviewCycle({ pullRequestId: 'pr-1', auto: true });
    expect(ensureReview).toHaveBeenCalledWith(expect.objectContaining({ pullRequestId: 'pr-1', workspaceId: 'ws-1' }));
    expect(casTransition).toHaveBeenCalledTimes(1);
  });
});

describe('startFixRun and the box gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createCloudTask.mockResolvedValue({ id: 'task-1' });
  });

  it.each([
    ['a person pressed Fix', 'user-1', false],
    ['auto-fix', null, true],
  ])('%s: unattended=%s', async (_label, userId, unattended) => {
    await startFixRun(restingReview() as never, ['f1'], userId);
    expect(createCloudTask).toHaveBeenCalledWith(expect.objectContaining({ source: 'code_review', unattended }));
  });

  it.each(refusals)('refused %s: back to ready with the reason, a deferred outcome carrying the error', async (_label, make, reason, eventCode) => {
    const err = make();
    createCloudTask.mockRejectedValue(err);

    const outcome = await startFixRun(restingReview() as never, ['f1'], 'user-1');

    expect(outcome).toMatchObject({ ok: false, code: 'deferred', message: err.message, deferral: { reason }, error: err });
    // Claimed (version 3 → 4), then rolled back to ready on the claimed version.
    expect(casTransition).toHaveBeenLastCalledWith(
      'rev-1',
      4,
      expect.objectContaining({ phase: 'ready', lastError: err.message }),
      expect.objectContaining({ code: eventCode, message: err.message, toPhase: 'ready' })
    );
    expect(capture).toHaveBeenCalledWith('ws-1', 'paywall_deferred', expect.objectContaining({ source: 'code_review', gate: reason }));
  });
});
