import { describe, expect, it, vi } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';
import { POSTHOG_INBOX_PUSH_WINDOW_MS, POSTHOG_INBOX_READY_EVENT, posthogInboxPushActive } from '@talyn/shared';

/**
 * The PostHog Inbox push without a database: the body parser for PostHog's
 * real webhook body and for malformed ones, the delivery id, the URL token and
 * secret checks (and that they compare in constant time), and the poller's
 * switch between the 3-minute poll and the 30-minute reconcile.
 */

const timingSafeEqual = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return {
    ...real,
    default: real,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      timingSafeEqual.calls += 1;
      return real.timingSafeEqual(a, b);
    },
  };
});

const {
  parsePostHogInboxPush,
  posthogInboxPushDeliveryId,
  posthogInboxSecretMatches,
  verifyPostHogInboxPush,
  posthogInboxAdapter,
} = await import('../services/inbound/adapters/posthogInbox.js');
const { hashWebhookToken, BODY_DEDUPE_WINDOW_MS } = await import('../services/inbound/adapters/webhook.js');
const { nextPollDelayMs, POSTHOG_INBOX_POLL_INTERVAL_MS, POSTHOG_INBOX_RECONCILE_INTERVAL_MS } = await import(
  '../services/posthogInbox/poller.js'
);

const REPORT_ID = '0194f0c2-7d1e-7c55-9e41-3c2f8a1b9d10';
const EVENT_UUID = '0194f0c2-aaaa-7c55-9e41-3c2f8a1b9d10';
const UPDATED_AT = '2026-11-16T12:00:00.123456+00:00';

/** The body PostHog's webhook template sends by default: `{event: '{event}', person: '{person}'}`. */
function postHogBody(over: { properties?: Record<string, unknown>; event?: Record<string, unknown> } = {}) {
  return {
    event: {
      uuid: EVENT_UUID,
      event: POSTHOG_INBOX_READY_EVENT,
      elements_chain: '',
      distinct_id: '6b7c8d9e-0000-4000-8000-000000000000',
      properties: {
        report_id: REPORT_ID,
        report_url: `https://us.posthog.com/project/2/inbox/${REPORT_ID}`,
        priority: 'P1',
        actionability: 'immediately_actionable',
        source_products: ['error_tracking'],
        source_products_text: 'error_tracking',
        updated_at: UPDATED_AT,
        ...over.properties,
      },
      timestamp: '2026-11-16T12:00:01.000000+00:00',
      captured_at: null,
      url: '',
      ...over.event,
    },
    person: null,
  };
}

describe('parsePostHogInboxPush', () => {
  it('reads the report id, the version and the event uuid from the real PostHog body', () => {
    expect(parsePostHogInboxPush(postHogBody())).toEqual({
      ok: true,
      push: { reportId: REPORT_ID, updatedAt: UPDATED_AT, eventUuid: EVENT_UUID },
    });
  });

  it('never returns the fields Talyn must not decide on', () => {
    const parsed = parsePostHogInboxPush(postHogBody({ properties: { priority: 'P0', actionability: 'x' } }));
    expect(parsed.ok && Object.keys(parsed.push).sort()).toEqual(['eventUuid', 'reportId', 'updatedAt']);
  });

  it.each<[string, unknown, { reportId: string; updatedAt: string | null; eventUuid: string | null }]>([
    ['a flat edited body', { report_id: REPORT_ID, updated_at: UPDATED_AT }, { reportId: REPORT_ID, updatedAt: UPDATED_AT, eventUuid: null }],
    [
      'a flat body with the event name and uuid',
      { event: POSTHOG_INBOX_READY_EVENT, uuid: EVENT_UUID, report_id: REPORT_ID },
      { reportId: REPORT_ID, updatedAt: null, eventUuid: EVENT_UUID },
    ],
    ['no updated_at', postHogBody({ properties: { updated_at: undefined } }), { reportId: REPORT_ID, updatedAt: null, eventUuid: EVENT_UUID }],
    ['a null updated_at', postHogBody({ properties: { updated_at: null } }), { reportId: REPORT_ID, updatedAt: null, eventUuid: EVENT_UUID }],
    ['a numeric updated_at', postHogBody({ properties: { updated_at: 1700000000 } }), { reportId: REPORT_ID, updatedAt: null, eventUuid: EVENT_UUID }],
    ['an updated_at that is too long', postHogBody({ properties: { updated_at: 'x'.repeat(65) } }), { reportId: REPORT_ID, updatedAt: null, eventUuid: EVENT_UUID }],
    ['no event uuid', postHogBody({ event: { uuid: undefined } }), { reportId: REPORT_ID, updatedAt: UPDATED_AT, eventUuid: null }],
    ['an event uuid that is not an id', postHogBody({ event: { uuid: 'a b/c' } }), { reportId: REPORT_ID, updatedAt: UPDATED_AT, eventUuid: null }],
    ['an event uuid that is too long', postHogBody({ event: { uuid: 'a'.repeat(65) } }), { reportId: REPORT_ID, updatedAt: UPDATED_AT, eventUuid: null }],
    ['no event name (an edited body)', postHogBody({ event: { event: undefined } }), { reportId: REPORT_ID, updatedAt: UPDATED_AT, eventUuid: EVENT_UUID }],
    ['spaces around the report id', postHogBody({ properties: { report_id: `  ${REPORT_ID} ` } }), { reportId: REPORT_ID, updatedAt: UPDATED_AT, eventUuid: EVENT_UUID }],
  ])('accepts %s', (_name, payload, push) => {
    expect(parsePostHogInboxPush(payload)).toEqual({ ok: true, push });
  });

  it.each<[string, unknown, RegExp]>([
    ['null', null, /not a JSON object/],
    ['a string body', 'report ready', /not a JSON object/],
    ['a number', 42, /not a JSON object/],
    ['an array', [postHogBody()], /not a JSON object/],
    ['an empty object', {}, /no report_id/],
    ['another event', postHogBody({ event: { event: '$pageview' } }), /\$pageview, not \$signals_report_ready/],
    ['another flat event', { event: 'report_deleted', report_id: REPORT_ID }, /report_deleted/],
    ['an event without properties', { event: { event: POSTHOG_INBOX_READY_EVENT } }, /no properties/],
    ['properties that are an array', { event: { event: POSTHOG_INBOX_READY_EVENT, properties: [REPORT_ID] } }, /no properties/],
    ['no report id', postHogBody({ properties: { report_id: undefined } }), /no report_id/],
    ['a null report id', postHogBody({ properties: { report_id: null } }), /no report_id/],
    ['an empty report id', postHogBody({ properties: { report_id: '' } }), /no report_id/],
    ['a numeric report id', postHogBody({ properties: { report_id: 12 } }), /not a PostHog report id/],
    ['an object report id', postHogBody({ properties: { report_id: { id: REPORT_ID } } }), /not a PostHog report id/],
    ['a path in the report id', postHogBody({ properties: { report_id: '../../users' } }), /not a PostHog report id/],
    ['a query in the report id', postHogBody({ properties: { report_id: 'abc?x=1' } }), /not a PostHog report id/],
    ['a report id that is too long', postHogBody({ properties: { report_id: 'a'.repeat(65) } }), /not a PostHog report id/],
  ])('refuses %s', (_name, payload, reason) => {
    const parsed = parsePostHogInboxPush(payload);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(reason);
  });

  it('cuts a long event name in the reason', () => {
    const parsed = parsePostHogInboxPush(postHogBody({ event: { event: 'e'.repeat(500) } }));
    expect(!parsed.ok && parsed.reason.length).toBeLessThan(200);
  });
});

describe('posthogInboxPushDeliveryId', () => {
  const now = Date.UTC(2026, 10, 16, 12);
  const raw = (body: unknown) => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));

  it.each<[string, unknown, string | RegExp]>([
    ['the event uuid', postHogBody(), EVENT_UUID],
    ['the report version without a uuid', postHogBody({ event: { uuid: undefined } }), `posthog_inbox:${REPORT_ID}:${UPDATED_AT}`],
    ['a body hash without a uuid or a version', postHogBody({ event: { uuid: undefined }, properties: { updated_at: undefined } }), /^body:[0-9a-f]{64}:\d+$/],
    ['a body hash for a malformed body', '{not json', /^body:[0-9a-f]{64}:\d+$/],
    ['a body hash for an empty body', '', /^body:[0-9a-f]{64}:\d+$/],
    ['a body hash for another event', postHogBody({ event: { event: '$pageview' } }), /^body:/],
  ])('uses %s', (_name, body, expected) => {
    const id = posthogInboxPushDeliveryId(raw(body), now);
    if (typeof expected === 'string') expect(id).toBe(expected);
    else expect(id).toMatch(expected);
  });

  it('gives a PostHog retry of one event the same id, and two events of one version different ids', () => {
    const first = posthogInboxPushDeliveryId(raw(postHogBody()), now);
    expect(posthogInboxPushDeliveryId(raw(postHogBody()), now + 60_000)).toBe(first);
    expect(posthogInboxPushDeliveryId(raw(postHogBody({ event: { uuid: 'other-uuid' } })), now)).not.toBe(first);
  });

  it('keeps one body hash inside a window and a new one in the next', () => {
    const body = raw({ report_id: REPORT_ID });
    const id = posthogInboxPushDeliveryId(body, now);
    expect(posthogInboxPushDeliveryId(body, now + 1)).toBe(id);
    expect(posthogInboxPushDeliveryId(body, now + BODY_DEDUPE_WINDOW_MS)).not.toBe(id);
  });

  it('names the event for the deliveries list', () => {
    expect(posthogInboxAdapter.eventType(postHogBody(), {})).toBe(POSTHOG_INBOX_READY_EVENT);
    expect(posthogInboxAdapter.eventType({ event: 'custom' }, {})).toBe('custom');
    expect(posthogInboxAdapter.eventType('text', {})).toBe('posthog_inbox');
    expect(posthogInboxAdapter.eventType({ event: { event: 'x'.repeat(300) } }, {}).length).toBe(200);
  });
});

describe('verifyPostHogInboxPush', () => {
  const TOKEN = 'tok_right';
  const SECRET = 'whsec_right';
  const connection = (over: { tokenHash?: string | null; signingSecret?: string | null; hasSecret?: boolean } = {}) => ({
    id: 'c1',
    workspaceId: 'ws1',
    kind: 'posthog_inbox' as const,
    ruleId: null,
    tokenHash: hashWebhookToken(TOKEN),
    signingSecret: SECRET,
    hasSecret: true,
    ...over,
  });
  const verify = (urlToken: string | null, headers: IncomingHttpHeaders, over = {}) =>
    verifyPostHogInboxPush({ rawBody: Buffer.from('{}'), headers, urlToken, connection: connection(over) });

  it.each<[string, string | null, IncomingHttpHeaders, Record<string, unknown>, string]>([
    ['no URL token', null, { 'x-talyn-secret': SECRET }, {}, 'missing'],
    ['a wrong URL token', 'tok_wrong', { 'x-talyn-secret': SECRET }, {}, 'invalid'],
    ['a URL token of another length', 'x', { 'x-talyn-secret': SECRET }, {}, 'invalid'],
    ['a connection without a token hash', TOKEN, { 'x-talyn-secret': SECRET }, { tokenHash: null }, 'invalid'],
    ['a stored hash that is not hex', TOKEN, { 'x-talyn-secret': SECRET }, { tokenHash: 'zz' }, 'invalid'],
    ['the right token and no secret header', TOKEN, {}, {}, 'missing'],
    ['the right token and an empty secret header', TOKEN, { 'x-talyn-secret': '  ' }, {}, 'missing'],
    ['the right token and a wrong secret', TOKEN, { 'x-talyn-secret': 'whsec_wrong' }, {}, 'invalid'],
    ['the right token and a secret of another length', TOKEN, { 'x-talyn-secret': 'w' }, {}, 'invalid'],
    ['the right token and the secret in another header', TOKEN, { authorization: `Bearer ${SECRET}` }, {}, 'missing'],
    ['the right token and secret', TOKEN, { 'x-talyn-secret': SECRET }, {}, 'valid'],
    ['the right secret with spaces around it', TOKEN, { 'x-talyn-secret': ` ${SECRET} ` }, {}, 'valid'],
    ['the right secret twice (an array header)', TOKEN, { 'x-talyn-secret': [SECRET, 'other'] }, {}, 'valid'],
    ['a stored secret that does not decrypt', TOKEN, { 'x-talyn-secret': SECRET }, { signingSecret: null }, 'invalid'],
    ['a URL without a secret and no header', TOKEN, {}, { signingSecret: null, hasSecret: false }, 'valid'],
    ['a URL without a secret and a stale header', TOKEN, { 'x-talyn-secret': 'old' }, { signingSecret: null, hasSecret: false }, 'valid'],
    ['a URL without a secret and a wrong token', 'tok_wrong', {}, { signingSecret: null, hasSecret: false }, 'invalid'],
  ])('%s', (_name, urlToken, headers, over, expected) => {
    expect(verify(urlToken, headers, over)).toBe(expected);
  });

  it('compares the token and the secret in constant time', () => {
    timingSafeEqual.calls = 0;
    expect(verify(TOKEN, { 'x-talyn-secret': 'whsec_wrong' })).toBe('invalid');
    // One comparison for the token hash, one for the secret hash.
    expect(timingSafeEqual.calls).toBe(2);
  });

  it.each([
    ['equal', SECRET, true],
    ['different', 'whsec_other', false],
    ['a prefix', SECRET.slice(0, 5), false],
    ['longer', `${SECRET}x`, false],
    ['empty', '', false],
  ])('posthogInboxSecretMatches: %s', (_name, presented, expected) => {
    timingSafeEqual.calls = 0;
    expect(posthogInboxSecretMatches(presented, SECRET)).toBe(expected);
    expect(timingSafeEqual.calls).toBe(1);
  });
});

describe('the reconcile switch', () => {
  const now = Date.UTC(2026, 10, 16, 12);
  const ago = (ms: number) => new Date(now - ms);

  it.each<[string, string | Date | null | undefined, boolean]>([
    ['no push', null, false],
    ['undefined', undefined, false],
    ['a push just now', ago(0), true],
    ['a push an hour ago', ago(60 * 60_000), true],
    ['a push a minute inside the window', ago(POSTHOG_INBOX_PUSH_WINDOW_MS - 60_000), true],
    ['a push exactly 24 hours ago', ago(POSTHOG_INBOX_PUSH_WINDOW_MS), false],
    ['a push two days ago', ago(2 * POSTHOG_INBOX_PUSH_WINDOW_MS), false],
    ['an ISO string inside the window', ago(1000).toISOString(), true],
    ['text that is not a time', 'yesterday', false],
  ])('posthogInboxPushActive: %s', (_name, at, expected) => {
    expect(posthogInboxPushActive(at, now)).toBe(expected);
  });

  it.each<[string, Parameters<typeof nextPollDelayMs>[0], boolean, number]>([
    ['a normal poll', { status: 'polled', more: false }, false, POSTHOG_INBOX_POLL_INTERVAL_MS],
    ['a normal poll while PostHog pushes', { status: 'polled', more: false }, true, POSTHOG_INBOX_RECONCILE_INTERVAL_MS],
    ['the first poll while PostHog pushes', { status: 'initialized', more: false }, true, POSTHOG_INBOX_RECONCILE_INTERVAL_MS],
    ['a gated poll while PostHog pushes', { status: 'gated', more: false }, true, POSTHOG_INBOX_RECONCILE_INTERVAL_MS],
    ['a backlog while PostHog pushes', { status: 'polled', more: true }, true, 30_000],
    ['a 403 while PostHog pushes', { status: 'error', more: false, errorStatus: 403 }, true, 30 * 60_000],
    ['a 500 while PostHog pushes', { status: 'error', more: false, errorStatus: 500 }, true, 10 * 60_000],
    ['a 429 while PostHog pushes', { status: 'error', more: false, errorStatus: 429, retryAfterMs: 5_000 }, true, POSTHOG_INBOX_POLL_INTERVAL_MS],
    ['no connection while PostHog pushes', { status: 'no_connection', more: false }, true, 30 * 60_000],
  ])('nextPollDelayMs: %s', (_name, result, pushActive, expected) => {
    expect(nextPollDelayMs(result, { pushActive })).toBe(expected);
  });

  it('defaults to the 3-minute poll', () => {
    expect(nextPollDelayMs({ status: 'polled', more: false })).toBe(POSTHOG_INBOX_POLL_INTERVAL_MS);
    expect(POSTHOG_INBOX_RECONCILE_INTERVAL_MS).toBe(30 * 60_000);
  });
});
