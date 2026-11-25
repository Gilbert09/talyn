import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCodeReviewSettings } from '@talyn/shared';

/**
 * Code review report-back: when a cycle finishes on a pull request that a live
 * cloud session owns, the confirmed findings go to that session as one
 * message, and auto-fix does not run beside it.
 */

const m = vi.hoisted(() => ({
  flag: vi.fn(),
  getReview: vi.fn(),
  getPrForReview: vi.fn(),
  appendReviewEvent: vi.fn(),
  appendReviewEventOnce: vi.fn(),
  listFindings: vi.fn(),
  confirmedOpenFindings: vi.fn(),
  settings: vi.fn(),
  startFixRun: vi.fn(),
  liveWorkbenchForPr: vi.fn(),
  liveSessionActivityForPr: vi.fn(),
  deliverToSession: vi.fn(),
  cas: vi.fn(),
  appendCard: vi.fn(),
  appendFinishedCard: vi.fn(),
}));

vi.mock('../services/featureFlags.js', async (orig) => ({
  ...(await orig<typeof import('../services/featureFlags.js')>()),
  workspaceHasFeature: m.flag,
}));
vi.mock('../services/codeReview/findings.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/findings.js')>()),
  markStale: vi.fn().mockResolvedValue(0),
  listFindings: m.listFindings,
  confirmedOpenFindings: m.confirmedOpenFindings,
}));
vi.mock('../services/codeReview/store.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/store.js')>()),
  casTransition: m.cas,
  getReview: m.getReview,
  getPrForReview: m.getPrForReview,
  appendReviewEvent: m.appendReviewEvent,
  appendReviewEventOnce: m.appendReviewEventOnce,
}));
vi.mock('../services/codeReview/analytics.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/analytics.js')>()),
  captureCycleFinished: vi.fn(),
  captureCycleFailed: vi.fn(),
}));
vi.mock('../services/codeReview/cycle.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/cycle.js')>()),
  workspaceReviewSettings: m.settings,
}));
vi.mock('../services/codeReview/fix.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/fix.js')>()),
  startFixRun: m.startFixRun,
}));
vi.mock('../services/workbenches/prSessions.js', async (orig) => ({
  ...(await orig<typeof import('../services/workbenches/prSessions.js')>()),
  liveWorkbenchForPr: m.liveWorkbenchForPr,
  liveSessionActivityForPr: m.liveSessionActivityForPr,
}));
vi.mock('../services/mergeQueue/sessionFix.js', async (orig) => ({
  ...(await orig<typeof import('../services/mergeQueue/sessionFix.js')>()),
  deliverToSession: m.deliverToSession,
}));
vi.mock('../services/codeReview/transcriptCards.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/transcriptCards.js')>()),
  appendCodeReviewCard: m.appendCard,
  appendFinishedCodeReviewCard: m.appendFinishedCard,
}));

const { failCycle, finishCycle } = await import('../services/codeReview/executor.js');
const {
  findingSummary,
  reportFindingsToSession,
  sessionReportMessage,
  SESSION_REPORT_MAX_LISTED,
} = await import('../services/codeReview/sessionReport.js');

const review = {
  id: 'rev-1',
  workspaceId: 'ws-1',
  pullRequestId: 'pr-1',
  phase: 'judging',
  version: 1,
  cycle: 3,
  targetHeadSha: 'a'.repeat(40),
} as unknown as Parameters<typeof finishCycle>[0];

const ready = { ...review, phase: 'ready', version: 2, reviewedHeadSha: 'a'.repeat(40) };

const blocker = {
  id: 'f1',
  severity: 'blocker',
  filePath: 'src/a.ts',
  lineStart: 10,
  lineEnd: 12,
  title: 'Null read on empty list',
  body: 'The loop reads items[0] before it checks the length. It throws on an empty list.',
  anchorVerified: true,
};
const minor = {
  id: 'f2',
  severity: 'minor',
  filePath: 'src/b.ts',
  lineStart: 4,
  lineEnd: 4,
  title: 'Unused import',
  body: '',
  anchorVerified: false,
};

const SESSION = { id: 'wb-1', name: 'paris', status: 'ready' };
const CHAT = { id: 'chat-1', turnCount: 4, closedAt: null };
type DeliverOpts = { trigger?: unknown; beforeSend?: (chat: typeof CHAT) => Promise<unknown> };

/** The order in which the card and the report message happen. */
let calls: string[] = [];

function eventCodes(): string[] {
  return m.appendReviewEvent.mock.calls.map((c) => (c[1] as { code: string }).code);
}

beforeEach(() => {
  m.flag.mockResolvedValue({ enabled: true, source: 'posthog' });
  m.getReview.mockResolvedValue(ready);
  m.getPrForReview.mockResolvedValue({ id: 'pr-1', owner: 'acme', repo: 'app', number: 42 });
  m.settings.mockResolvedValue(resolveCodeReviewSettings({ autoFix: true }));
  m.listFindings.mockResolvedValue([
    { id: 'f1', severity: 'blocker', verdict: 'confirmed', disposition: 'open', anchorVerified: true },
  ]);
  m.confirmedOpenFindings.mockResolvedValue([blocker, minor]);
  m.appendReviewEventOnce.mockResolvedValue(true);
  m.liveWorkbenchForPr.mockResolvedValue(SESSION);
  m.cas.mockResolvedValue(true);
  calls = [];
  // As the real one: the hook runs with the chosen chat, then the message goes.
  m.deliverToSession.mockImplementation(async (_id: string, _text: string, opts: DeliverOpts = {}) => {
    await opts.beforeSend?.(CHAT);
    calls.push('message');
    return 'chat-1';
  });
  m.appendCard.mockImplementation(async (_review: unknown, card: { action: string }) => {
    calls.push(`card:${card.action}`);
    return true;
  });
  m.appendFinishedCard.mockImplementation(async () => {
    calls.push('card:finished');
    return true;
  });
  m.startFixRun.mockResolvedValue({ ok: true, taskId: 't1' });
});

afterEach(() => vi.resetAllMocks());

describe('finishCycle with a live session on the pull request', () => {
  it.each([
    // activity, flag, sent to session, auto-fix held back, fix run started
    { activity: 'idle', flag: true, sent: true, held: false, fixed: false },
    { activity: 'working', flag: true, sent: true, held: false, fixed: false },
    { activity: 'local', flag: true, sent: false, held: true, fixed: false },
    { activity: 'unavailable', flag: true, sent: false, held: true, fixed: false },
    { activity: 'idle', flag: false, sent: false, held: true, fixed: false },
    { activity: 'working', flag: false, sent: false, held: true, fixed: false },
    { activity: 'local', flag: false, sent: false, held: true, fixed: false },
  ])('$activity session, flag $flag: sent=$sent held=$held', async ({ activity, flag, sent, held, fixed }) => {
    m.flag.mockResolvedValue({ enabled: flag, source: 'posthog' });
    m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity });

    await finishCycle(review);

    expect(m.flag).toHaveBeenCalledWith('codeReviewSessionReportBack', 'ws-1');
    expect(m.deliverToSession).toHaveBeenCalledTimes(sent ? 1 : 0);
    expect(m.appendReviewEventOnce).toHaveBeenCalledTimes(sent ? 1 : 0);
    expect(eventCodes().includes('auto_fix_session_active')).toBe(held);
    expect(m.startFixRun).toHaveBeenCalledTimes(fixed ? 1 : 0);
    if (!flag) expect(m.liveSessionActivityForPr).not.toHaveBeenCalled();
  });

  it('records the report once per cycle, with the session and the findings', async () => {
    m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'working' });

    await finishCycle(review);

    expect(m.appendReviewEventOnce).toHaveBeenCalledWith(
      'rev-1',
      3,
      expect.objectContaining({
        code: 'session_report_sent',
        message: expect.stringContaining('"paris"'),
        detail: { workbenchId: 'wb-1', activity: 'working', findingIds: ['f1', 'f2'] },
      })
    );
    expect(m.deliverToSession).toHaveBeenCalledWith(
      'wb-1',
      expect.stringContaining('acme/app#42'),
      expect.objectContaining({ trigger: { kind: 'code_review', reviewId: 'rev-1', findingCount: 2 } })
    );
  });

  it('sends nothing twice for the same cycle, and auto-fix still stands down', async () => {
    m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'idle' });
    m.appendReviewEventOnce.mockResolvedValue(false);

    await finishCycle(review);

    expect(m.deliverToSession).not.toHaveBeenCalled();
    expect(m.startFixRun).not.toHaveBeenCalled();
    expect(eventCodes()).toEqual([]);
  });

  it('sends nothing for a review with no confirmed findings', async () => {
    m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'idle' });
    m.confirmedOpenFindings.mockResolvedValue([]);
    m.listFindings.mockResolvedValue([]);

    await finishCycle(review);

    expect(m.appendReviewEventOnce).not.toHaveBeenCalled();
    expect(m.deliverToSession).not.toHaveBeenCalled();
    expect(m.startFixRun).not.toHaveBeenCalled();
  });

  it('sends the findings also when auto-fix is off', async () => {
    m.settings.mockResolvedValue(resolveCodeReviewSettings({ autoFix: false }));
    m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'idle' });

    await finishCycle(review);

    expect(m.deliverToSession).toHaveBeenCalledTimes(1);
    expect(m.startFixRun).not.toHaveBeenCalled();
  });

  it('runs auto-fix as before when no session owns the pull request', async () => {
    m.liveSessionActivityForPr.mockResolvedValue(null);
    m.liveWorkbenchForPr.mockResolvedValue(null);

    await finishCycle(review);

    expect(m.deliverToSession).not.toHaveBeenCalled();
    expect(m.startFixRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'rev-1' }), ['f1'], null);
  });

  it('records a failed delivery, then keeps the earlier hold', async () => {
    m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'idle' });
    m.deliverToSession.mockRejectedValue(new Error('The session is gone.'));

    await finishCycle(review);

    expect(eventCodes()).toEqual(['session_report_failed', 'auto_fix_session_active']);
    expect(m.appendReviewEvent).toHaveBeenCalledWith(
      'rev-1',
      expect.objectContaining({ message: expect.stringContaining('The session is gone.') })
    );
    expect(m.startFixRun).not.toHaveBeenCalled();
  });

  it('keeps the earlier behaviour when the flag cannot be read', async () => {
    m.flag.mockRejectedValue(new Error('posthog down'));
    m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'idle' });

    await finishCycle(review);

    expect(m.deliverToSession).not.toHaveBeenCalled();
    expect(eventCodes()).toEqual(['auto_fix_session_active']);
  });
});

describe('finishCycle transcript cards', () => {
  it('writes the finished card before the report message, with the findings sent to the agent', async () => {
    m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'idle' });

    await finishCycle(review);

    expect(calls).toEqual(['card:finished', 'message']);
    expect(m.appendFinishedCard).not.toHaveBeenCalled();
    expect(m.appendCard).toHaveBeenCalledTimes(1);
    expect(m.appendCard).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rev-1', cycle: 3 }),
      {
        action: 'finished',
        headSha: 'a'.repeat(40),
        findingCount: 2,
        findings: [
          {
            id: 'f1',
            severity: 'blocker',
            title: 'Null read on empty list',
            summary: 'The loop reads items[0] before it checks the length.',
            filePath: 'src/a.ts',
            lineStart: 10,
            lineEnd: 12,
          },
          {
            id: 'f2',
            severity: 'minor',
            title: 'Unused import',
            summary: '',
            filePath: 'src/b.ts',
            lineStart: 4,
            lineEnd: 4,
          },
        ],
        sentToAgent: true,
      },
      { workbenchId: 'wb-1', name: 'paris', chat: CHAT }
    );
  });

  it('writes no card when an earlier call already sent the report for this cycle', async () => {
    m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'idle' });
    m.appendReviewEventOnce.mockResolvedValue(false);

    await finishCycle(review);

    expect(calls).toEqual([]);
  });

  it.each([
    { name: 'a local session', setup: () => m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'local' }) },
    { name: 'no session', setup: () => m.liveSessionActivityForPr.mockResolvedValue(null) },
    {
      name: 'the report flag off',
      setup: () => {
        m.flag.mockResolvedValue({ enabled: false, source: 'posthog' });
        m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'idle' });
      },
    },
    {
      name: 'a clean review',
      setup: () => {
        m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'idle' });
        m.confirmedOpenFindings.mockResolvedValue([]);
        m.listFindings.mockResolvedValue([]);
      },
    },
    {
      name: 'a delivery that throws before the send',
      setup: () => {
        m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'idle' });
        m.deliverToSession.mockRejectedValue(new Error('The session is gone.'));
      },
    },
  ])('writes one finished card, not sent to the agent, for $name', async ({ setup }) => {
    setup();

    await finishCycle(review);

    expect(calls).toEqual(['card:finished']);
    expect(m.appendCard).not.toHaveBeenCalled();
    expect(m.appendFinishedCard).toHaveBeenCalledWith(review, 'a'.repeat(40), false);
  });

  it('writes no card when another evaluation finished the cycle first', async () => {
    m.cas.mockResolvedValue(false);
    m.liveSessionActivityForPr.mockResolvedValue(null);

    await finishCycle(review);

    expect(calls).toEqual([]);
  });
});

describe('failCycle transcript card', () => {
  it.each([
    { phase: 'reviewing', targetHeadSha: 'b'.repeat(40), headSha: 'b'.repeat(40) },
    { phase: 'judging', targetHeadSha: '', headSha: null },
    { phase: 'preparing', targetHeadSha: 'b'.repeat(40), headSha: null },
    { phase: 'queued', targetHeadSha: 'b'.repeat(40), headSha: null },
  ])('writes the failed card from $phase with head $headSha', async ({ phase, targetHeadSha, headSha }) => {
    const failing = { ...review, phase, targetHeadSha };

    await failCycle(failing, 'no_reviewers', 'No reviewer finished.');

    expect(m.appendCard).toHaveBeenCalledTimes(1);
    expect(m.appendCard).toHaveBeenCalledWith(failing, { action: 'failed', headSha, message: 'No reviewer finished.' });
  });

  it('writes no failed card when auto-fix fails, because the finished card came first', async () => {
    await failCycle({ ...review, phase: 'fixing' }, 'pr_closed', 'The pull request was closed.');

    expect(m.cas).toHaveBeenCalled();
    expect(m.appendCard).not.toHaveBeenCalled();
  });

  it('writes no card when the transition lost', async () => {
    m.cas.mockResolvedValue(false);

    await failCycle(review, 'no_reviewers', 'No reviewer finished.');

    expect(m.appendCard).not.toHaveBeenCalled();
  });
});

describe('reportFindingsToSession', () => {
  it.each([
    { name: 'the review moved to a new cycle', fresh: { ...ready, cycle: 4 } },
    { name: 'a new commit queued the review', fresh: { ...ready, phase: 'queued' } },
    { name: 'the review is gone', fresh: null },
  ])('sends nothing when $name', async ({ fresh }) => {
    m.getReview.mockResolvedValue(fresh);
    m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'idle' });

    expect(await reportFindingsToSession(review)).toEqual({ kind: 'skipped', reason: 'not_ready' });
    expect(m.deliverToSession).not.toHaveBeenCalled();
  });

  it.each([
    { activity: 'local', outcome: { kind: 'skipped', reason: 'local' } },
    { activity: 'unavailable', outcome: { kind: 'skipped', reason: 'unavailable' } },
    { activity: 'idle', outcome: { kind: 'sent', workbenchId: 'wb-1', chatId: 'chat-1', findings: 2 } },
    { activity: 'working', outcome: { kind: 'sent', workbenchId: 'wb-1', chatId: 'chat-1', findings: 2 } },
  ])('answers $outcome.kind for a $activity session', async ({ activity, outcome }) => {
    m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity });
    expect(await reportFindingsToSession(review)).toEqual(outcome);
  });
  it('answers failed when the delivery throws, and records why', async () => {
    m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'idle' });
    m.deliverToSession.mockRejectedValue(new Error('The session is gone.'));
    m.appendReviewEvent.mockResolvedValue(undefined);

    expect(await reportFindingsToSession(review)).toEqual({ kind: 'failed', error: 'The session is gone.' });
    expect(m.appendReviewEvent).toHaveBeenCalledWith(
      'rev-1',
      expect.objectContaining({ code: 'session_report_failed', detail: { workbenchId: 'wb-1', cycle: 3 } })
    );
  });
});

describe('sessionReportMessage', () => {
  const base = {
    reviewId: 'rev-1',
    pullRequestId: 'pr-1',
    prRef: 'acme/app#42',
    headSha: 'b'.repeat(40),
  };

  it('lists each finding and tells the agent to fix or dismiss', () => {
    const text = sessionReportMessage({ ...base, findings: [blocker, minor] });

    expect(text).toContain('acme/app#42 at bbbbbbbbbbbb finished with 2 confirmed findings');
    expect(text).toContain('Review: rev-1. Pull request id for the Talyn tools: pr-1.');
    expect(text).toContain('- f1 [blocker] src/a.ts:10-12: Null read on empty list');
    expect(text).toContain('  The loop reads items[0] before it checks the length.');
    expect(text).not.toContain('It throws on an empty list.');
    expect(text).toContain('- f2 [minor] src/b.ts:4 (location not verified): Unused import');
    expect(text).toContain('talyn_get_code_review_finding');
    expect(text).toContain('talyn_dismiss_code_review_finding');
    expect(text).toContain('not_a_problem, already_handled, wont_fix_here, wrong_about_code');
    expect(text).toContain('push');
  });

  it('says "finding" for one, and leaves the head out when unknown', () => {
    const text = sessionReportMessage({ ...base, headSha: null, findings: [blocker] });
    expect(text).toContain('The code review of acme/app#42 finished with 1 confirmed finding.');
  });

  it('caps the list and points to the review for the rest', () => {
    const many = Array.from({ length: SESSION_REPORT_MAX_LISTED + 3 }, (_, i) => ({ ...blocker, id: `f${i}` }));
    const text = sessionReportMessage({ ...base, findings: many });
    expect(text).toContain(`f${SESSION_REPORT_MAX_LISTED - 1} [blocker]`);
    expect(text).not.toContain(`f${SESSION_REPORT_MAX_LISTED} [blocker]`);
    expect(text).toContain('- 3 more. Get them with talyn_get_code_review.');
  });

  it.each([
    { body: 'One sentence. Two sentences.', out: 'One sentence.' },
    { body: '  spread\n\nover   lines  ', out: 'spread over lines' },
    { body: 'no stop at all', out: 'no stop at all' },
    { body: 'a.b is fine here. Next.', out: 'a.b is fine here.' },
    { body: 'x'.repeat(300), out: `${'x'.repeat(199)}…` },
  ])('summarises "$body"', ({ body, out }) => {
    expect(findingSummary(body)).toBe(out);
  });

  it.each([
    { name: 'no file', f: { ...blocker, filePath: '' }, line: '- f1 [blocker] no file: Null' },
    { name: 'no line', f: { ...blocker, lineStart: null, lineEnd: null }, line: '- f1 [blocker] src/a.ts: Null' },
    { name: 'one line', f: { ...blocker, lineEnd: null }, line: '- f1 [blocker] src/a.ts:10: Null' },
  ])('writes the location with $name', ({ f, line }) => {
    expect(sessionReportMessage({ ...base, findings: [f] })).toContain(line);
  });
});
