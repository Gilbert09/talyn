import { describe, expect, it } from 'vitest';
import type { PostHogClaimSummary, WorkflowActionOutcome } from '@talyn/shared';
import { parseReportNotFixedSentinel, posthogClaimText, TALYN_REPORT_NOT_FIXED_SENTINEL } from '@talyn/shared';
import { PostHogCodeApiError } from '../services/posthogCode/client.js';
import { posthogBackoffMs } from '../services/posthogInbox/backoff.js';
import { blockClaims, claimBlockedUntil, classifyClaimError, claimGate, _resetClaimGatesForTests } from '../services/posthogInbox/claims.js';
import { scopeGrantsInbox, scopeGrantsInboxClaims } from '../services/posthogInbox/connection.js';
import { POSTHOG_INBOX_VERIFY_INSTRUCTION } from '../services/workflows/posthogInboxActions.js';
import { isRetryable, settlementFor, statusFromOutcomes } from '../services/workflows/runs.js';
import { claimFailureResult } from '../services/workflows/sessionAction.js';

/**
 * The pure parts of PostHog Inbox claims: what a PostHog answer means, the
 * backoff, the gate, the agent's stop line, the history text, and how a
 * claim refusal settles a run.
 */

const MIN = 60_000;
const apiError = (status: number, retryAfterMs: number | null = null) => new PostHogCodeApiError(status, retryAfterMs, `PostHog said ${status}`);

describe('classifyClaimError', () => {
  it.each([
    [409, 'conflict'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [429, 'rate_limited'],
    [400, 'invalid'],
    [404, 'invalid'],
    [422, 'invalid'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [504, 'unavailable'],
  ])('reads %i as %s', (status, kind) => {
    expect(classifyClaimError(apiError(status))).toMatchObject({ kind, status });
  });

  it.each([
    ['a network failure', new Error('fetch failed')],
    ['a timeout', new Error('The operation was aborted due to timeout')],
    ['a thrown string', 'boom'],
  ])('reads %s as unavailable, with no status', (_name, err) => {
    expect(classifyClaimError(err)).toMatchObject({ kind: 'unavailable', status: null });
  });

  it('keeps the Retry-After', () => {
    expect(classifyClaimError(apiError(429, 42_000)).retryAfterMs).toBe(42_000);
  });
});

describe('posthogBackoffMs', () => {
  it.each([
    [401, null, 30 * MIN],
    [403, 5_000, 30 * MIN],
    [429, null, 3 * MIN],
    [429, 30_000, 3 * MIN],
    [429, 20 * MIN, 20 * MIN],
    [500, null, 10 * MIN],
    [503, 60_000, 10 * MIN],
    [null, null, 10 * MIN],
  ])('waits after %s (Retry-After %s) for %i ms', (status, retryAfter, wait) => {
    expect(posthogBackoffMs(status, retryAfter)).toBe(wait);
  });
});

describe('the claim gate', () => {
  it('blocks a connection for the backoff, keeps the later block, and clears itself', () => {
    _resetClaimGatesForTests();
    const now = 1_000_000;
    blockClaims('c1', classifyClaimError(apiError(503)), now);
    expect(claimBlockedUntil('c1', now)).toBe(now + 10 * MIN);
    // A shorter block does not shorten a longer one.
    blockClaims('c1', classifyClaimError(apiError(429)), now);
    expect(claimBlockedUntil('c1', now)).toBe(now + 10 * MIN);
    // A longer one extends it.
    blockClaims('c1', classifyClaimError(apiError(403)), now);
    expect(claimGate('c1', now)?.failure.status).toBe(403);
    expect(claimBlockedUntil('c2', now)).toBe(0);
    expect(claimBlockedUntil(null, now)).toBe(0);
    expect(claimGate('c1', now + 31 * MIN)).toBeNull();
    expect(claimBlockedUntil('c1', now + 31 * MIN)).toBe(0);
  });
});

describe('scopes', () => {
  it.each([
    ['openid task:read task:write inbox:read inbox:write', true, true],
    ['inbox:read inbox:write task:write', true, true],
    ['openid task:read inbox:read inbox:write', true, false],
    ['openid task:read task:write inbox:read', true, false],
    ['openid task:read task:write', false, false],
    ['inbox:write task:write', false, true],
    ['', false, false],
    [null, false, false],
    [undefined, false, false],
    ['  inbox:read\tinbox:write  task:write ', true, true],
  ])('reads %j as read %s, claim %s', (scope, read, claim) => {
    expect(scopeGrantsInbox(scope)).toBe(read);
    expect(scopeGrantsInboxClaims(scope)).toBe(claim);
  });
});

describe('parseReportNotFixedSentinel', () => {
  const S = TALYN_REPORT_NOT_FIXED_SENTINEL;
  it.each([
    [`${S} the diagnosis is wrong`, 'the diagnosis is wrong'],
    [`Checked it.\n\n${S} already fixed in #12`, 'already fixed in #12'],
    [`Checked it.\n${S} trailing blank lines\n\n  \n`, 'trailing blank lines'],
    [`  ${S}   spaced   `, 'spaced'],
    [`\`${S} in backticks\``, 'in backticks'],
    [`${S}`, 'The agent stopped without a fix.'],
    [`${S}   `, 'The agent stopped without a fix.'],
  ])('reads %j', (text, reason) => {
    expect(parseReportNotFixedSentinel(text)).toEqual({ reason });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['only blank lines', '\n\n  \n'],
    ['not on the last line', `${S} wrong\nThen I fixed it.`],
    ['in the middle of a line', `I did not write ${S} here`],
    ['a near miss', 'TALYN_REPORT_NOT_FIXED wrong'],
    ['lower case', 'talyn_report_not_fixed: wrong'],
  ])('ignores %s', (_name, text) => {
    expect(parseReportNotFixedSentinel(text)).toBeNull();
  });

  it('cuts a long reason', () => {
    const parsed = parseReportNotFixedSentinel(`${S} ${'x'.repeat(1000)}`);
    expect(parsed!.reason.length).toBe(300);
    expect(parsed!.reason.endsWith('…')).toBe(true);
  });

  it('is what the session prompt asks the agent to write', () => {
    expect(POSTHOG_INBOX_VERIFY_INSTRUCTION).toContain(S);
    expect(POSTHOG_INBOX_VERIFY_INSTRUCTION).toMatch(/do not change any files and do not open a pull request/);
  });
});

describe('posthogClaimText', () => {
  const claim = (over: Partial<PostHogClaimSummary>): PostHogClaimSummary => ({
    state: 'claimed',
    prUrl: null,
    reason: null,
    pending: false,
    error: null,
    updatedAt: null,
    ...over,
  });
  it.each([
    [claim({}), 'Claimed the report in PostHog.'],
    [claim({ state: 'pr_attached', prUrl: 'https://github.com/a/b/pull/1' }), 'Attached the pull request to the claim in PostHog.'],
    [claim({ state: 'merged' }), 'The pull request merged. PostHog resolves the report.'],
    [claim({ state: 'released' }), 'Released the claim in PostHog.'],
    [claim({ state: 'released', reason: 'the session was archived without a pull request' }), 'Released the claim in PostHog: the session was archived without a pull request.'],
    [claim({ state: 'released', reason: 'the agent stopped without a fix: wrong.' }), 'Released the claim in PostHog: the agent stopped without a fix: wrong.'],
    [claim({ state: 'lost', reason: 'somebody else took the report over' }), 'PostHog ended the claim: somebody else took the report over.'],
    [claim({ state: 'lost' }), 'PostHog ended the claim.'],
    [claim({ pending: true, error: '503: down' }), 'Claimed the report in PostHog. PostHog did not take the last update (503: down). Talyn tries again.'],
    [claim({ pending: true }), 'Claimed the report in PostHog. Talyn has an update to send to PostHog.'],
  ])('says %j as %s', (input, text) => {
    expect(posthogClaimText(input)).toBe(text);
  });
});

describe('a claim refusal as a run outcome', () => {
  const now = 1_000_000;
  const failure = (status: number, retryAfterMs: number | null = null) => classifyClaimError(apiError(status, retryAfterMs));

  it.each([
    [409, 'report_claimed_elsewhere', null, 'skipped'],
    [401, 'posthog_unauthorized', 30 * MIN, 'pending_retry'],
    [403, 'posthog_unauthorized', 30 * MIN, 'pending_retry'],
    [429, 'rate_gated', 3 * MIN, 'pending_retry'],
    [500, 'posthog_unavailable', 10 * MIN, 'pending_retry'],
    [503, 'posthog_unavailable', 10 * MIN, 'pending_retry'],
    [400, 'error', null, 'failed'],
  ])('settles a %i as %s', (status, code, wait, runStatus) => {
    const result = claimFailureResult(failure(status), 0, now);
    expect(result.outcome).toMatchObject({ type: 'start_session', ok: false, code });
    expect(result.retryAt ? result.retryAt.getTime() - now : null).toBe(wait);
    const settled = settlementFor([result.outcome], {
      blockedUntilMs: result.retryAt?.getTime() ?? 0,
      attempts: 1,
      now,
    });
    expect(settled.status).toBe(runStatus);
  });

  it('waits for the gate when it holds longer than the backoff', () => {
    const result = claimFailureResult(failure(503), now + 25 * MIN, now);
    expect(result.retryAt!.getTime()).toBe(now + 25 * MIN);
  });

  it('gives up a parked claim after the attempt cap', () => {
    const { outcome } = claimFailureResult(failure(503), 0, now);
    expect(settlementFor([outcome], { blockedUntilMs: 0, attempts: 5, now })).toEqual({ status: 'failed', retryAfter: null });
  });

  it.each([
    ['report_claimed_elsewhere', false],
    ['posthog_unavailable', true],
    ['posthog_unauthorized', true],
    ['posthog_claim_unavailable', false],
    ['rate_gated', true],
  ])('retries %s: %s', (code, retryable) => {
    expect(isRetryable({ type: 'start_session', ok: false, code } as WorkflowActionOutcome)).toBe(retryable);
  });

  it('records a run whose only outcome is a lost race as skipped, and a mixed run by its failures', () => {
    const lost: WorkflowActionOutcome = { type: 'start_session', ok: false, code: 'report_claimed_elsewhere', error: 'x' };
    const okOutcome: WorkflowActionOutcome = { type: 'start_session', ok: true, detail: 'ok' };
    const other: WorkflowActionOutcome = { type: 'start_session', ok: false, code: 'error', error: 'x' };
    expect(statusFromOutcomes([lost])).toBe('skipped');
    expect(statusFromOutcomes([lost, lost])).toBe('skipped');
    expect(statusFromOutcomes([lost, other])).toBe('failed');
    expect(statusFromOutcomes([okOutcome, lost])).toBe('partial');
  });
});
