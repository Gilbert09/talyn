import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isTodiexConfigured, notifyTodiex, postTodiexEvent } from '../services/todiex.js';
import { describeSubscriptionEvent } from '../services/billing/webhook.js';

/**
 * The inbox client is env-gated and best-effort: neither var → no HTTP at
 * all; with both, one POST per event with the right shape; any failure is
 * swallowed, because a webhook, a login and the dispatch loop all call this
 * and none of them may fail because an inbox is down.
 */

const fetchMock = vi.fn();

async function flushMicrotasks(): Promise<void> {
  // notifyTodiex is fire-and-forget — a couple of macrotask turns lets the
  // POST settle before the assertion reads the mock.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
}

describe('todiex inbox client', () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: async () => '{"ok":true}',
    } as unknown as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    delete process.env.TODIEX_URL;
    delete process.env.TODIEX_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.TODIEX_URL;
    delete process.env.TODIEX_TOKEN;
  });

  describe('env gating', () => {
    it('is not configured when neither var is set', () => {
      expect(isTodiexConfigured()).toBe(false);
    });

    it.each([
      ['only a url', { TODIEX_URL: 'https://todiex.test' }],
      ['only a token', { TODIEX_TOKEN: 'tdx_abc' }],
    ])('is not configured with %s', (_label, env) => {
      Object.assign(process.env, env);
      expect(isTodiexConfigured()).toBe(false);
    });

    it('is configured when both are set', () => {
      process.env.TODIEX_URL = 'https://todiex.test';
      process.env.TODIEX_TOKEN = 'tdx_abc';
      expect(isTodiexConfigured()).toBe(true);
    });

    it('makes no HTTP call at all when unconfigured', async () => {
      notifyTodiex({ kind: 'user.signed_up', title: 'x' });
      await flushMicrotasks();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('the request', () => {
    beforeEach(() => {
      process.env.TODIEX_URL = 'https://todiex.test';
      process.env.TODIEX_TOKEN = 'tdx_abc';
    });

    it('posts to the ingest route with a bearer token', async () => {
      await postTodiexEvent({ kind: 'user.signed_up', title: 'New signup' });
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://todiex.test/api/ingest/events');
      const init = fetchMock.mock.calls[0]?.[1];
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tdx_abc');
    });

    it('trims a trailing slash rather than posting to a doubled path', async () => {
      process.env.TODIEX_URL = 'https://todiex.test/';
      await postTodiexEvent({ kind: 'x', title: 'y' });
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://todiex.test/api/ingest/events');
    });

    it('stamps the source so a call site cannot file Talyn news elsewhere', async () => {
      await postTodiexEvent({ kind: 'x', title: 'y' });
      expect(sentBody().source).toBe('talyn');
    });

    it('sends every optional field with a default rather than undefined', async () => {
      await postTodiexEvent({ kind: 'user.signed_up', title: 'New signup' });
      expect(sentBody()).toEqual({
        source: 'talyn',
        kind: 'user.signed_up',
        title: 'New signup',
        message: '',
        level: 'info',
        url: null,
        metadata: {},
        dedupeKey: null,
        occurredAt: null,
      });
    });

    it('carries a full payload through unchanged', async () => {
      await postTodiexEvent({
        kind: 'subscription.created',
        title: 'New Talyn subscription',
        message: 'Status active.',
        level: 'success',
        url: 'https://polar.sh/subscriptions/sub_1',
        metadata: { user_id: 'u1', status: 'active' },
        dedupeKey: 'polar:evt_1',
        occurredAt: '2026-09-16T10:22:31.000Z',
      });
      expect(sentBody()).toMatchObject({
        kind: 'subscription.created',
        level: 'success',
        dedupeKey: 'polar:evt_1',
        occurredAt: '2026-09-16T10:22:31.000Z',
        metadata: { user_id: 'u1', status: 'active' },
      });
    });
  });

  describe('failure is never the caller’s problem', () => {
    beforeEach(() => {
      process.env.TODIEX_URL = 'https://todiex.test';
      process.env.TODIEX_TOKEN = 'tdx_abc';
    });

    it.each([401, 429, 500])('swallows an HTTP %i', async (status) => {
      fetchMock.mockResolvedValue({
        ok: false,
        status,
        statusText: 'nope',
        headers: new Headers(),
        text: async () => '',
      } as unknown as Response);
      await expect(postTodiexEvent({ kind: 'x', title: 'y' })).resolves.toBeUndefined();
    });

    it('swallows a network failure', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(postTodiexEvent({ kind: 'x', title: 'y' })).resolves.toBeUndefined();
    });

    it('never rejects out of the fire-and-forget wrapper', async () => {
      // The webhook handler and the JWT middleware both call this. An
      // unhandled rejection reaching the process from here would be a crash
      // caused by a notification.
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const onUnhandled = vi.fn();
      process.on('unhandledRejection', onUnhandled);
      expect(() => notifyTodiex({ kind: 'x', title: 'y' })).not.toThrow();
      await flushMicrotasks();
      process.off('unhandledRejection', onUnhandled);
      expect(onUnhandled).not.toHaveBeenCalled();
    });
  });
});

describe('which subscription transitions are worth a notification', () => {
  it.each([
    ['subscription.revoked', 'active', 'subscription.cancelled', 'warn'],
    ['subscription.updated', 'canceled', 'subscription.cancelled', 'warn'],
    ['subscription.updated', 'past_due', 'payment.failed', 'error'],
    ['subscription.created', 'active', 'subscription.created', 'success'],
    ['subscription.created', 'trialing', 'subscription.created', 'success'],
    ['subscription.active', 'active', 'subscription.active', 'success'],
  ])('%s + %s → %s', (eventType, status, kind, level) => {
    const d = describeSubscriptionEvent(eventType, status);
    expect(d?.kind).toBe(kind);
    expect(d?.level).toBe(level);
  });

  it('revocation wins over a status that still looks healthy', () => {
    // Polar sends `revoked` with the subscription's last status attached;
    // reading the status first would announce a cancellation as a new sale.
    expect(describeSubscriptionEvent('subscription.revoked', 'active')?.kind).toBe(
      'subscription.cancelled'
    );
  });

  it('treats past_due as the payment failure, not the later revoke', () => {
    // Polar keeps granting access through dunning, so this is the moment the
    // subscription can still be saved.
    expect(describeSubscriptionEvent('subscription.created', 'past_due')?.kind).toBe(
      'payment.failed'
    );
  });

  it.each([
    ['a routine update with no state change', 'subscription.updated', 'active'],
    ['an unrelated event type', 'subscription.uncanceled', 'active'],
    ['a created event that grants nothing', 'subscription.created', 'incomplete'],
  ])('stays quiet for %s', (_label, eventType, status) => {
    expect(describeSubscriptionEvent(eventType, status)).toBeNull();
  });
});
