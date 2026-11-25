import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODE_REVIEW_TRANSCRIPT_MAX_FINDINGS } from '@talyn/shared';
import type { ChatRow } from '../services/workbenches/store.js';

/**
 * Code review cards in the session transcript: a `talyn_code_review` event in
 * the newest open chat of the live cloud session on the pull request, once
 * per review, cycle and action.
 */

const m = vi.hoisted(() => ({
  flag: vi.fn(),
  liveSessionActivityForPr: vi.fn(),
  latestChat: vi.fn(),
  appendEvents: vi.fn(),
  emitWorkbenchEvents: vi.fn(),
  emitWorkbenchChat: vi.fn(),
  appendReviewEventOnce: vi.fn(),
  getPrForReview: vi.fn(),
  confirmedOpenFindings: vi.fn(),
  casTransition: vi.fn(),
  runsForCycle: vi.fn(),
  getWorkbench: vi.fn(),
  insertChat: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('../services/featureFlags.js', async (orig) => ({
  ...(await orig<typeof import('../services/featureFlags.js')>()),
  workspaceHasFeature: m.flag,
}));
vi.mock('../services/workbenches/prSessions.js', async (orig) => ({
  ...(await orig<typeof import('../services/workbenches/prSessions.js')>()),
  liveSessionActivityForPr: m.liveSessionActivityForPr,
}));
vi.mock('../services/workbenches/store.js', async (orig) => ({
  ...(await orig<typeof import('../services/workbenches/store.js')>()),
  latestChat: m.latestChat,
  appendEvents: m.appendEvents,
  getWorkbench: m.getWorkbench,
  insertChat: m.insertChat,
  rowToChat: (chat: unknown) => chat,
}));
vi.mock('../services/workbenches/emit.js', async (orig) => ({
  ...(await orig<typeof import('../services/workbenches/emit.js')>()),
  emitWorkbenchEvents: m.emitWorkbenchEvents,
  emitWorkbenchChat: m.emitWorkbenchChat,
}));
vi.mock('../services/workbenches/turns.js', async (orig) => ({
  ...(await orig<typeof import('../services/workbenches/turns.js')>()),
  sendMessage: m.sendMessage,
}));
vi.mock('../services/codeReview/store.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/store.js')>()),
  appendReviewEventOnce: m.appendReviewEventOnce,
  getPrForReview: m.getPrForReview,
  casTransition: m.casTransition,
  runsForCycle: m.runsForCycle,
}));
vi.mock('../services/codeReview/findings.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/findings.js')>()),
  confirmedOpenFindings: m.confirmedOpenFindings,
}));

const {
  appendCodeReviewCard,
  appendFinishedCodeReviewCard,
  codeReviewCardFindings,
  finishedCodeReviewCard,
  TRANSCRIPT_CARD_CODES,
} = await import('../services/codeReview/transcriptCards.js');
const { deliverToSession } = await import('../services/mergeQueue/sessionFix.js');
const { cancelReviewCycle } = await import('../services/codeReview/cycle.js');

const REVIEW = { id: 'rev-1', workspaceId: 'ws-1', pullRequestId: 'pr-1', cycle: 3 };
const SESSION = { id: 'wb-1', name: 'paris', status: 'ready' };
const CHAT = { id: 'chat-1', turnCount: 5, closedAt: null } as unknown as ChatRow;
const STARTED = { action: 'started', headSha: 'a'.repeat(40), fileCount: 4, reviewerCount: 2 } as const;
const STORED = [{ seq: 9, turn: 5, event: { type: 'talyn_code_review' }, createdAt: null }];

const row = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  severity: 'major',
  filePath: 'src/a.ts',
  lineStart: 3,
  lineEnd: 5,
  title: 'Wrong default',
  body: 'The default is 0.  It must be 1.',
  anchorVerified: true,
  ...over,
});

beforeEach(() => {
  m.flag.mockResolvedValue({ enabled: true, source: 'posthog' });
  m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'idle' });
  m.latestChat.mockResolvedValue(CHAT);
  m.appendReviewEventOnce.mockResolvedValue(true);
  m.getPrForReview.mockResolvedValue({ id: 'pr-1', owner: 'acme', repo: 'app', number: 42 });
  m.appendEvents.mockResolvedValue(STORED);
  m.confirmedOpenFindings.mockResolvedValue([row()]);
});

afterEach(() => vi.resetAllMocks());

describe('appendCodeReviewCard', () => {
  it('appends the event to the newest open chat in its current turn, then broadcasts it', async () => {
    expect(await appendCodeReviewCard(REVIEW, STARTED)).toBe(true);

    expect(m.flag).toHaveBeenCalledWith('codeReviewTranscriptCards', 'ws-1');
    expect(m.liveSessionActivityForPr).toHaveBeenCalledWith('ws-1', 'pr-1');
    expect(m.appendEvents).toHaveBeenCalledWith('chat-1', [
      {
        turn: 5,
        event: {
          type: 'talyn_code_review',
          action: 'started',
          reviewId: 'rev-1',
          pullRequestId: 'pr-1',
          prNumber: 42,
          cycle: 3,
          headSha: 'a'.repeat(40),
          fileCount: 4,
          reviewerCount: 2,
        },
      },
    ]);
    expect(m.emitWorkbenchEvents).toHaveBeenCalledWith('ws-1', 'chat-1', STORED);
  });

  it.each([
    { action: 'started' as const, code: 'transcript_card_started', phase: 'reviewing' },
    { action: 'finished' as const, code: 'transcript_card_finished', phase: 'ready' },
    { action: 'failed' as const, code: 'transcript_card_failed', phase: 'failed' },
  ])('claims the $action card once per cycle with $code', async ({ action, code, phase }) => {
    const card =
      action === 'started'
        ? STARTED
        : action === 'finished'
          ? finishedCodeReviewCard([], null, false)
          : ({ action: 'failed', headSha: null, message: 'Boom.' } as const);

    await appendCodeReviewCard(REVIEW, card);

    expect(TRANSCRIPT_CARD_CODES[action]).toBe(code);
    expect(m.appendReviewEventOnce).toHaveBeenCalledWith('rev-1', 3, {
      fromPhase: phase,
      toPhase: phase,
      trigger: 'executor',
      code,
      message: `Added the "${action}" card to the session "paris".`,
      detail: { workbenchId: 'wb-1', chatId: 'chat-1' },
    });
  });

  it.each([
    { name: 'the flag is off', setup: () => m.flag.mockResolvedValue({ enabled: false, source: 'posthog' }) },
    { name: 'no session owns the pull request', setup: () => m.liveSessionActivityForPr.mockResolvedValue(null) },
    {
      name: 'the session is local',
      setup: () => m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity: 'local' }),
    },
    { name: 'the session has no chat', setup: () => m.latestChat.mockResolvedValue(null) },
    {
      name: 'the newest chat is closed',
      setup: () => m.latestChat.mockResolvedValue({ ...CHAT, closedAt: new Date() }),
    },
    { name: 'an earlier call wrote the card', setup: () => m.appendReviewEventOnce.mockResolvedValue(false) },
  ])('writes nothing when $name', async ({ setup }) => {
    setup();

    expect(await appendCodeReviewCard(REVIEW, STARTED)).toBe(false);

    expect(m.appendEvents).not.toHaveBeenCalled();
    expect(m.emitWorkbenchEvents).not.toHaveBeenCalled();
  });

  it.each(['working', 'idle', 'unavailable'])('writes to a %s session', async (activity) => {
    m.liveSessionActivityForPr.mockResolvedValue({ ...SESSION, activity });
    expect(await appendCodeReviewCard(REVIEW, STARTED)).toBe(true);
  });

  it('claims nothing when the flag is off', async () => {
    m.flag.mockResolvedValue({ enabled: false, source: 'posthog' });
    await appendCodeReviewCard(REVIEW, STARTED);
    expect(m.appendReviewEventOnce).not.toHaveBeenCalled();
    expect(m.liveSessionActivityForPr).not.toHaveBeenCalled();
  });

  it('uses the chat it is given, and does not look up the session', async () => {
    const chat = { ...CHAT, id: 'chat-2', turnCount: 8 } as ChatRow;

    expect(await appendCodeReviewCard(REVIEW, STARTED, { workbenchId: 'wb-2', name: 'rome', chat })).toBe(true);

    expect(m.liveSessionActivityForPr).not.toHaveBeenCalled();
    expect(m.latestChat).not.toHaveBeenCalled();
    expect(m.appendEvents).toHaveBeenCalledWith('chat-2', [expect.objectContaining({ turn: 8 })]);
    expect(m.appendReviewEventOnce).toHaveBeenCalledWith(
      'rev-1',
      3,
      expect.objectContaining({ detail: { workbenchId: 'wb-2', chatId: 'chat-2' } })
    );
  });

  it('writes a null PR number when the pull request is gone', async () => {
    m.getPrForReview.mockResolvedValue(null);
    await appendCodeReviewCard(REVIEW, STARTED);
    expect(m.appendEvents).toHaveBeenCalledWith('chat-1', [
      expect.objectContaining({ event: expect.objectContaining({ prNumber: null }) }),
    ]);
  });

  it.each([
    { name: 'the flag read', setup: () => m.flag.mockRejectedValue(new Error('posthog down')) },
    { name: 'the session read', setup: () => m.liveSessionActivityForPr.mockRejectedValue(new Error('db down')) },
    { name: 'the claim', setup: () => m.appendReviewEventOnce.mockRejectedValue(new Error('db down')) },
    { name: 'the append', setup: () => m.appendEvents.mockRejectedValue(new Error('db down')) },
  ])('answers false and does not throw when $name fails', async ({ setup }) => {
    setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(appendCodeReviewCard(REVIEW, STARTED)).resolves.toBe(false);

    expect(warn).toHaveBeenCalledWith('[code-review] started card for rev-1 failed:', expect.any(Error));
  });
});

describe('finished card', () => {
  it('maps the confirmed findings to the snapshot', () => {
    expect(codeReviewCardFindings([row(), row({ id: 'f2', severity: 'nit', filePath: '', lineStart: null, lineEnd: null, body: '' })])).toEqual([
      {
        id: 'f1',
        severity: 'major',
        title: 'Wrong default',
        summary: 'The default is 0.',
        filePath: 'src/a.ts',
        lineStart: 3,
        lineEnd: 5,
      },
      { id: 'f2', severity: 'nit', title: 'Wrong default', summary: '', filePath: null, lineStart: null, lineEnd: null },
    ]);
  });

  it('drops a finding with an unknown severity from the list, not from the count', () => {
    const card = finishedCodeReviewCard([row(), row({ id: 'f2', severity: 'critical' })], 'b'.repeat(40), true);
    expect(card).toMatchObject({ action: 'finished', findingCount: 2, sentToAgent: true, headSha: 'b'.repeat(40) });
    expect(card.action === 'finished' && card.findings.map((f) => f.id)).toEqual(['f1']);
  });

  it.each([
    { n: 0, listed: 0 },
    { n: 1, listed: 1 },
    { n: CODE_REVIEW_TRANSCRIPT_MAX_FINDINGS, listed: CODE_REVIEW_TRANSCRIPT_MAX_FINDINGS },
    { n: CODE_REVIEW_TRANSCRIPT_MAX_FINDINGS + 5, listed: CODE_REVIEW_TRANSCRIPT_MAX_FINDINGS },
  ])('lists $listed of $n findings and counts all', ({ n, listed }) => {
    const rows = Array.from({ length: n }, (_, i) => row({ id: `f${i}` }));
    const card = finishedCodeReviewCard(rows, '', false);
    expect(card).toMatchObject({ findingCount: n, headSha: null });
    expect(card.action === 'finished' && card.findings).toHaveLength(listed);
  });

  it('reads the confirmed open findings and appends one finished card', async () => {
    expect(await appendFinishedCodeReviewCard(REVIEW, 'c'.repeat(40), false)).toBe(true);

    expect(m.confirmedOpenFindings).toHaveBeenCalledWith('rev-1');
    expect(m.appendEvents).toHaveBeenCalledWith('chat-1', [
      {
        turn: 5,
        event: expect.objectContaining({
          type: 'talyn_code_review',
          action: 'finished',
          headSha: 'c'.repeat(40),
          findingCount: 1,
          sentToAgent: false,
          findings: [expect.objectContaining({ id: 'f1', summary: 'The default is 0.' })],
        }),
      },
    ]);
  });

  it('reads no findings when the flag is off', async () => {
    m.flag.mockResolvedValue({ enabled: false, source: 'posthog' });
    expect(await appendFinishedCodeReviewCard(REVIEW, null, false)).toBe(false);
    expect(m.confirmedOpenFindings).not.toHaveBeenCalled();
  });

  it('answers false when the findings read fails', async () => {
    m.confirmedOpenFindings.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(appendFinishedCodeReviewCard(REVIEW, null, false)).resolves.toBe(false);
    expect(m.appendEvents).not.toHaveBeenCalled();
  });
});

describe('deliverToSession', () => {
  beforeEach(() => {
    m.getWorkbench.mockResolvedValue({ id: 'wb-1', workspaceId: 'ws-1', agent: 'claude', model: null });
    m.sendMessage.mockResolvedValue({ queued: false });
  });

  it('runs the hook with the chat, then sends the message with the trigger', async () => {
    const order: string[] = [];
    const beforeSend = vi.fn(async () => {
      order.push('card');
    });
    m.sendMessage.mockImplementation(async () => {
      order.push('message');
      return { queued: false };
    });
    const trigger = { kind: 'code_review' as const, reviewId: 'rev-1', findingCount: 2 };

    expect(await deliverToSession('wb-1', 'Fix these.', { trigger, beforeSend })).toBe('chat-1');

    expect(order).toEqual(['card', 'message']);
    expect(beforeSend).toHaveBeenCalledWith(CHAT);
    expect(m.sendMessage).toHaveBeenCalledWith('chat-1', { text: 'Fix these.' }, { origin: 'talyn', trigger });
  });

  it('sends as before with no options', async () => {
    await deliverToSession('wb-1', 'Fix these.');
    expect(m.sendMessage).toHaveBeenCalledWith('chat-1', { text: 'Fix these.' }, { origin: 'talyn' });
  });

  it('runs the hook with the new chat when the session has no open chat', async () => {
    const fresh = { ...CHAT, id: 'chat-new', turnCount: 0 };
    m.latestChat.mockResolvedValue({ ...CHAT, closedAt: new Date() });
    m.insertChat.mockResolvedValue(fresh);
    const beforeSend = vi.fn(async () => {});

    expect(await deliverToSession('wb-1', 'Fix these.', { beforeSend })).toBe('chat-new');

    expect(beforeSend).toHaveBeenCalledWith(fresh);
  });

  it('sends nothing when the hook throws', async () => {
    const beforeSend = vi.fn(async () => {
      throw new Error('hook failed');
    });
    await expect(deliverToSession('wb-1', 'Fix these.', { beforeSend })).rejects.toThrow('hook failed');
    expect(m.sendMessage).not.toHaveBeenCalled();
  });
});

describe('stopping a review', () => {
  const reviewRow = (phase: string) =>
    ({ ...REVIEW, version: 7, phase, targetHeadSha: 'b'.repeat(40) }) as unknown as Parameters<typeof cancelReviewCycle>[0];

  beforeEach(() => {
    m.runsForCycle.mockResolvedValue([]);
    m.casTransition.mockResolvedValue(true);
  });

  it.each(['reviewing', 'sweeping', 'validating'])('closes the started card when it stops in %s', async (phase) => {
    await cancelReviewCycle(reviewRow(phase));
    expect(m.appendReviewEventOnce).toHaveBeenCalledWith('rev-1', 3, expect.objectContaining({ code: TRANSCRIPT_CARD_CODES.cancelled }));
    expect(m.appendEvents).toHaveBeenCalledWith('chat-1', [
      {
        turn: 5,
        event: {
          type: 'talyn_code_review',
          action: 'cancelled',
          reviewId: 'rev-1',
          pullRequestId: 'pr-1',
          prNumber: 42,
          cycle: 3,
          headSha: 'b'.repeat(40),
        },
      },
    ]);
  });

  it.each(['queued', 'preparing', 'fixing'])('writes no card when it stops in %s', async (phase) => {
    await cancelReviewCycle(reviewRow(phase));
    expect(m.casTransition).toHaveBeenCalled();
    expect(m.appendEvents).not.toHaveBeenCalled();
  });

  it('writes no card when the stop lost the race', async () => {
    m.casTransition.mockResolvedValue(false);
    await cancelReviewCycle(reviewRow('reviewing'));
    expect(m.appendEvents).not.toHaveBeenCalled();
  });
});
