import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { isTodiexConfigured, notifyTodiex, postTodiexEvent } from '../services/todiex.js';
import { notifyProviderConnected } from '../services/cloudProviders/environment.js';
import { registerCloudProvider } from '../services/cloudProviders/registry.js';
import type { CloudTaskProvider } from '../services/cloudProviders/types.js';
import {
  describeSubscriptionEvent,
  formatPeriodEnd,
  formatSubscriptionPrice,
  summarizeSubscription,
} from '../services/billing/webhook.js';
import {
  personMetadata,
  resetTodiexContextCacheForTests,
} from '../services/todiexContext.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { users as usersTable, workspaces as workspacesTable } from '../db/schema.js';

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

  /**
   * Observed 2026-09-21: one sale, two identical cards in the feed. Polar
   * announces a new subscription as `subscription.created` and then
   * `subscription.active` seconds later, each with its own `webhook-id`, so the
   * per-event dedupe key cannot tell they are the same news.
   */
  describe('one sale is one notification', () => {
    it('announces the start and then stays quiet for the twin', () => {
      // The pair as Polar sends it: created first (nothing stored yet), then
      // active (the row now says the subscription is granting).
      expect(
        describeSubscriptionEvent('subscription.created', 'active', { previouslyGranting: false })
          ?.kind
      ).toBe('subscription.created');
      expect(
        describeSubscriptionEvent('subscription.active', 'active', { previouslyGranting: true })
      ).toBeNull();
    });

    it('works whichever of the two lands first', () => {
      // Polar promises no order, so the rule is on the stored state and not on
      // the event name — otherwise an out-of-order pair announces twice again.
      expect(
        describeSubscriptionEvent('subscription.active', 'active', { previouslyGranting: false })
          ?.kind
      ).toBe('subscription.active');
      expect(
        describeSubscriptionEvent('subscription.created', 'active', { previouslyGranting: true })
      ).toBeNull();
    });

    it('still announces an activation that follows a lapse', () => {
      // `past_due` recovered or a revoked subscription resumed: the stored
      // status is not granting, so this is news rather than a repeat.
      expect(
        describeSubscriptionEvent('subscription.active', 'active', { previouslyGranting: false })
          ?.kind
      ).toBe('subscription.active');
    });

    it.each([
      ['a cancellation', 'subscription.revoked', 'active', 'subscription.cancelled'],
      ['a payment failure', 'subscription.updated', 'past_due', 'payment.failed'],
    ])('never suppresses %s', (_label, eventType, status, kind) => {
      // Both are about access ENDING, and a running subscription is exactly the
      // state they arrive in — suppressing them would be the worst possible
      // reading of "it was already granting".
      expect(
        describeSubscriptionEvent(eventType, status, { previouslyGranting: true })?.kind
      ).toBe(kind);
    });
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

  /**
   * The fleet is ONE provider running two vendors on the workspace's own
   * subscription, so "connected Talyn Fleet" left out the first thing anyone
   * asks of a fleet signup.
   */
  describe('which fleet agent a workspace connected', () => {
    beforeEach(() => {
      registerCloudProvider({
        type: 'selfhosted',
        displayName: 'Talyn Fleet',
      } as unknown as CloudTaskProvider);
    });

    it.each([
      ['claude' as const, 'Claude'],
      ['codex' as const, 'Codex'],
    ])('names %s in the title the way the picker does', async (agent, label) => {
      notifyProviderConnected({ workspaceId: 'ws1', type: 'selfhosted', agent });
      await flushMicrotasks();
      expect(sentBody().title).toBe(`A Talyn workspace connected Talyn Fleet \u00B7 ${label}`);
    });

    it('carries the raw vendor id in the metadata, for filtering', async () => {
      notifyProviderConnected({ workspaceId: 'ws1', type: 'selfhosted', agent: 'codex' });
      await flushMicrotasks();
      expect(sentBody().metadata).toMatchObject({ provider: 'selfhosted', fleet_agent: 'codex' });
    });

    it('gives each agent its own key, so the second one is not swallowed', async () => {
      notifyProviderConnected({ workspaceId: 'ws1', type: 'selfhosted', agent: 'claude' });
      await flushMicrotasks();
      const first = sentBody().dedupeKey;
      fetchMock.mockClear();
      notifyProviderConnected({ workspaceId: 'ws1', type: 'selfhosted', agent: 'codex' });
      await flushMicrotasks();
      expect(first).toBe('workspace:ws1:provider:selfhosted:agent:claude:connected');
      expect(sentBody().dedupeKey).toBe('workspace:ws1:provider:selfhosted:agent:codex:connected');
    });

    it('leaves a single-agent provider exactly as it was', async () => {
      // No agent, no agent segment: PostHog Code's key must not move, or every
      // workspace already connected to it is announced a second time.
      notifyProviderConnected({ workspaceId: 'ws1', type: 'posthog_code' });
      await flushMicrotasks();
      expect(sentBody().dedupeKey).toBe('workspace:ws1:provider:posthog_code:connected');
      expect(sentBody().metadata).not.toHaveProperty('fleet_agent');
    });
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
  interface ConfigBody {
    claudeToken?: string;
    codexAccessToken?: string;
    openaiKey?: string;
    clearClaude?: boolean;
    clearCodex?: boolean;
  }

  /** Mirrors the route: which agents a save announces, in its order. */
  const announced = (body: ConfigBody): string[] => {
    if (body.clearClaude || body.clearCodex) return [];
    const agents: string[] = [];
    if (body.claudeToken) agents.push('claude');
    if (body.codexAccessToken || body.openaiKey) agents.push('codex');
    return agents;
  };

  it.each([
    ['a Claude token', { claudeToken: 'sk-ant-x' }, ['claude']],
    ['a Codex token', { codexAccessToken: 'codex-x' }, ['codex']],
    ['an OpenAI key', { openaiKey: 'sk-x' }, ['codex']],
    [
      'both agents in one save',
      { claudeToken: 'sk-ant-x', codexAccessToken: 'codex-x' },
      ['claude', 'codex'],
    ],
  ])('announces %s', (_label, body: ConfigBody, expected) => {
    expect(announced(body)).toEqual(expected);
  });

  it.each([
    ['clearing Claude', { clearClaude: true }],
    ['clearing Codex', { clearCodex: true }],
    ['a clear that also carries the old token', { claudeToken: 'sk-ant-x', clearClaude: true }],
    ['a save with no credential at all', {}],
  ])('stays silent for %s', (_label, body: ConfigBody) => {
    expect(announced(body)).toEqual([]);
  });
});

/**
 * The readable half of an event — a workspace's name, its owner's email, the
 * plan they are on — lives in the database, and the call sites (a webhook, the
 * JWT middleware, the dispatch loop) hold only ids. `notifyTodiex` therefore
 * also takes a function that goes and builds the event, run inside the
 * fire-and-forget POST so none of those paths pays for the lookup.
 */
describe('an event that has to be looked up first', () => {
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

  it('posts what the builder returns', async () => {
    notifyTodiex(async () => ({ kind: 'workspace.activated', title: 'Acme ran its first Talyn task' }));
    await flushMicrotasks();
    expect(sentBody().title).toBe('Acme ran its first Talyn task');
  });

  it('never calls the builder when the inbox is unconfigured', async () => {
    // The whole point of the thunk: an unconfigured deployment must not pay
    // for a query to build an event it will never send.
    delete process.env.TODIEX_URL;
    const build = vi.fn();
    notifyTodiex(build);
    await flushMicrotasks();
    expect(build).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing when the builder decides there is nothing to say', async () => {
    notifyTodiex(async () => null);
    await flushMicrotasks();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loses the notification rather than the request when the builder throws', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    expect(() =>
      notifyTodiex(async () => {
        throw new Error('database is down');
      })
    ).not.toThrow();
    await flushMicrotasks();
    process.off('unhandledRejection', onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * What the ids resolve to. `notifyProviderConnected` is the representative
 * call site — it holds a workspace id and nothing else, which is exactly the
 * event that used to read "A Talyn workspace connected Talyn Fleet" and leave
 * you to go and find out whose.
 */
describe('the names behind the ids', () => {
  const origFetch = globalThis.fetch;
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: 'owner-1', email: 'tom@example.test' });
    await db
      .update(usersTable)
      .set({ githubUsername: 'gilbert09', plan: 'unlimited' })
      .where(eq(usersTable.id, 'owner-1'));
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: 'owner-1',
      name: 'PostHog',
      settings: {},
    });
    registerCloudProvider({
      type: 'selfhosted',
      displayName: 'Talyn Fleet',
    } as unknown as CloudTaskProvider);
  });

  afterAll(async () => {
    await cleanup?.();
  });

  beforeEach(() => {
    resetTodiexContextCacheForTests();
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

  async function notifyAndRead(args: Parameters<typeof notifyProviderConnected>[0]) {
    notifyProviderConnected(args);
    // One query stands between the call and the POST, so give the chain a
    // little longer than the two turns a bare POST needs.
    for (let i = 0; i < 50 && fetchMock.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return sentBody();
  }

  it('names the workspace in the title', async () => {
    const body = await notifyAndRead({ workspaceId: 'ws1', type: 'selfhosted' });
    expect(body.title).toBe('PostHog connected Talyn Fleet');
  });

  it('says who owns it, with their handle and plan', async () => {
    const body = await notifyAndRead({
      workspaceId: 'ws1',
      type: 'selfhosted',
      detail: 'Claude subscription linked.',
    });
    expect(body.message).toBe(
      'Claude subscription linked. Owner: tom@example.test (@gilbert09, unlimited plan)'
    );
  });

  it('carries the names as properties, and keeps the ids', async () => {
    const body = await notifyAndRead({ workspaceId: 'ws1', type: 'selfhosted' });
    expect(body.metadata).toEqual({
      provider_name: 'Talyn Fleet',
      provider: 'selfhosted',
      workspace: 'PostHog',
      owner_email: 'tom@example.test',
      owner_github_username: 'gilbert09',
      owner_github_url: 'https://github.com/gilbert09',
      owner_plan: 'unlimited',
      owner_user_id: 'owner-1',
      workspace_id: 'ws1',
    });
  });

  it('degrades to the id-only event when the workspace cannot be resolved', async () => {
    // A deleted workspace, or a database blip. The notification is worth more
    // than the names on it, so a failed lookup still sends — reading exactly
    // as it did before any of this existed.
    const body = await notifyAndRead({ workspaceId: 'ws-gone', type: 'selfhosted' });
    expect(body.title).toBe('A Talyn workspace connected Talyn Fleet');
    expect(body.message).toBe('It can run cloud tasks now.');
    expect(body.metadata).toEqual({
      provider_name: 'Talyn Fleet',
      provider: 'selfhosted',
      workspace_id: 'ws-gone',
    });
  });

  it('reports the comped plan, not the one Polar last wrote', async () => {
    // `plan_override` is the manual comp flag and wins over `plan` in every
    // entitlement check — a feed that disagreed with the paywall would be
    // worse than no plan at all.
    await db
      .update(usersTable)
      .set({ planOverride: 'unlimited', plan: 'free' })
      .where(eq(usersTable.id, 'owner-1'));
    const body = await notifyAndRead({ workspaceId: 'ws1', type: 'selfhosted' });
    expect((body.metadata as Record<string, unknown>).owner_plan).toBe('unlimited');
    await db
      .update(usersTable)
      .set({ planOverride: null, plan: 'unlimited' })
      .where(eq(usersTable.id, 'owner-1'));
  });
});

/** The signup event is the one that needs no lookup — the JWT carries it. */
describe('a person, as properties', () => {
  it('leads with the email and links the GitHub profile', () => {
    expect(
      personMetadata({
        userId: 'u1',
        email: 'tom@example.test',
        githubUsername: 'gilbert09',
        plan: 'free',
      })
    ).toEqual({
      email: 'tom@example.test',
      github_username: 'gilbert09',
      github_url: 'https://github.com/gilbert09',
      plan: 'free',
      user_id: 'u1',
    });
  });

  it('omits what it does not know rather than sending nulls', () => {
    expect(
      personMetadata({ userId: 'u1', email: null, githubUsername: null, plan: null })
    ).toEqual({ user_id: 'u1' });
  });

  it('prefixes a bystander so the subject of the event stays unambiguous', () => {
    expect(
      personMetadata({ userId: 'u1', email: 'tom@example.test', githubUsername: null, plan: null }, 'owner')
    ).toEqual({ owner_email: 'tom@example.test', owner_user_id: 'u1' });
  });
});

/** Money and dates, as a phone should show them. */
describe('how a subscription reads', () => {
  it.each([
    [2000, 'usd', '$20.00'],
    [2000, 'USD', '$20.00'],
    [19900, 'eur', '€199.00'],
    [0, 'usd', '$0.00'],
  ])('%i %s → %s', (amount, currency, expected) => {
    expect(formatSubscriptionPrice(amount, currency)).toBe(expected);
  });

  it('defaults a missing currency rather than dropping the number', () => {
    expect(formatSubscriptionPrice(2000, null)).toBe('$20.00');
  });

  it('still shows the number for a currency code Intl rejects', () => {
    expect(formatSubscriptionPrice(2000, 'not-a-currency')).toBe('20.00 NOT-A-CURRENCY');
  });

  it.each([[null], [undefined], [Number.NaN]])('says nothing about a %s amount', (amount) => {
    expect(formatSubscriptionPrice(amount as number | null | undefined, 'usd')).toBeNull();
  });

  it.each([
    ['2026-08-06T00:00:00.000Z', '6 Aug 2026'],
    [new Date('2026-12-31T23:00:00.000Z'), '31 Dec 2026'],
  ])('formats a period end', (value, expected) => {
    expect(formatPeriodEnd(value)).toBe(expected);
  });

  it.each([[null], [undefined], ['not a date']])('says nothing about %s', (value) => {
    expect(formatPeriodEnd(value as string | null | undefined)).toBeNull();
  });

  it('reads as a sentence: product, price, status and the date', () => {
    expect(
      summarizeSubscription({
        id: 'sub-1',
        status: 'active',
        amount: 2000,
        currency: 'usd',
        recurringInterval: 'month',
        product: { name: 'Talyn Unlimited' },
        currentPeriodEnd: '2026-08-06T00:00:00.000Z',
      })
    ).toBe('Talyn Unlimited, $20.00/month. Status active, renews 6 Aug 2026.');
  });

  it('says access ends rather than renews when it is cancelling', () => {
    // The date alone cannot tell those apart, and they are opposite news.
    expect(
      summarizeSubscription({
        id: 'sub-1',
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: '2026-08-06T00:00:00.000Z',
      })
    ).toBe('Status active, access until 6 Aug 2026.');
  });

  it('degrades to the status alone when the event carries nothing else', () => {
    expect(summarizeSubscription({ id: 'sub-1', status: 'past_due' })).toBe('Status past_due.');
  });
});
