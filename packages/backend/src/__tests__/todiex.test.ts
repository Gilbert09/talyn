import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isTodiexConfigured, notifyTodiex, postTodiexEvent } from '../services/todiex.js';
import { notifyProviderConnected } from '../services/cloudProviders/environment.js';
import { registerCloudProvider } from '../services/cloudProviders/registry.js';
import type { CloudTaskProvider } from '../services/cloudProviders/types.js';
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

describe('the cloud-provider setup notification', () => {
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
    process.env.TODIEX_URL = 'https://todiex.test';
    process.env.TODIEX_TOKEN = 'tdx_abc';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.TODIEX_URL;
    delete process.env.TODIEX_TOKEN;
  });

  it('names the provider the way the product does', async () => {
    // Providers register themselves at boot, so the registry is empty in a
    // unit test — register the one under test rather than asserting a name
    // that only appears once index.ts has run.
    registerCloudProvider({
      type: 'selfhosted',
      displayName: 'Talyn Fleet',
    } as unknown as CloudTaskProvider);
    notifyProviderConnected({ workspaceId: 'ws1', type: 'selfhosted' });
    await flushMicrotasks();
    expect(sentBody().title).toBe('A Talyn workspace connected Talyn Fleet');
  });

  it('falls back to the raw type rather than saying "undefined"', async () => {
    // The same `?? type` fallback ensureCloudEnvironment uses for the env
    // name. A notification naming an unregistered provider is still useful;
    // one naming `undefined` is not.
    notifyProviderConnected({ workspaceId: 'ws1', type: 'not_registered' as never });
    await flushMicrotasks();
    expect(sentBody().title).toBe('A Talyn workspace connected not_registered');
  });

  it('keys on the workspace AND the provider', async () => {
    // Per workspace, not per user: the env marker ensureCloudEnvironment
    // writes is keyed (user, provider), so a user's second workspace would
    // never be reported if the key followed that instead.
    notifyProviderConnected({ workspaceId: 'ws1', type: 'posthog_code' });
    await flushMicrotasks();
    expect(sentBody().dedupeKey).toBe('workspace:ws1:provider:posthog_code:connected');
  });

  it.each([
    ['a second workspace', { workspaceId: 'ws2', type: 'selfhosted' as const }],
    ['a second provider', { workspaceId: 'ws1', type: 'posthog_code' as const }],
  ])('gives %s its own key', async (_label, args) => {
    notifyProviderConnected({ workspaceId: 'ws1', type: 'selfhosted' });
    await flushMicrotasks();
    const first = sentBody().dedupeKey;
    fetchMock.mockClear();
    notifyProviderConnected(args);
    await flushMicrotasks();
    expect(sentBody().dedupeKey).not.toBe(first);
  });

  it('carries the detail into both the message and the metadata', async () => {
    notifyProviderConnected({
      workspaceId: 'ws1',
      type: 'posthog_code',
      detail: 'PostHog project 42, via OAuth.',
    });
    await flushMicrotasks();
    expect(sentBody()).toMatchObject({
      message: 'PostHog project 42, via OAuth.',
      metadata: { workspace_id: 'ws1', provider: 'posthog_code', detail: 'PostHog project 42, via OAuth.' },
    });
  });

  it('says something useful when there is no detail', async () => {
    notifyProviderConnected({ workspaceId: 'ws1', type: 'selfhosted' });
    await flushMicrotasks();
    expect(sentBody().message).toBe('It can run cloud tasks now.');
    expect(sentBody().metadata).not.toHaveProperty('detail');
  });

  it('stays silent when the inbox is not configured', async () => {
    delete process.env.TODIEX_URL;
    notifyProviderConnected({ workspaceId: 'ws1', type: 'selfhosted' });
    await flushMicrotasks();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The guard at PUT /cloud-providers/:type/config. That route is the Settings
 * card's save button, so it is also how a credential is removed — a clear
 * validates, provisions the marker and returns connected:true exactly like a
 * connect does. Announcing a disconnect as a setup is the one wrong thing this
 * hook could do, so the condition is pinned here rather than only in the route.
 */
describe('a disconnect is not a setup', () => {
  const shouldNotify = (body: {
    claudeToken?: string;
    codexAccessToken?: string;
    openaiKey?: string;
    clearClaude?: boolean;
    clearCodex?: boolean;
  }): boolean =>
    Boolean(body.claudeToken || body.codexAccessToken || body.openaiKey) &&
    !body.clearClaude &&
    !body.clearCodex;

  it.each([
    ['a Claude token', { claudeToken: 'sk-ant-x' }],
    ['a Codex token', { codexAccessToken: 'codex-x' }],
    ['an OpenAI key', { openaiKey: 'sk-x' }],
  ])('notifies when %s arrives', (_label, body) => {
    expect(shouldNotify(body)).toBe(true);
  });

  it.each([
    ['clearing Claude', { clearClaude: true }],
    ['clearing Codex', { clearCodex: true }],
    ['a clear that also carries the old token', { claudeToken: 'sk-ant-x', clearClaude: true }],
    ['a save with no credential at all', {}],
  ])('stays silent for %s', (_label, body) => {
    expect(shouldNotify(body)).toBe(false);
  });
});
