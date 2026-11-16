import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  POSTHOG_INBOX_DESTINATION_NAME,
  POSTHOG_INBOX_PUSH_FAILED_CODE,
  POSTHOG_INBOX_PUSH_FORBIDDEN_CODE,
  POSTHOG_INBOX_PUSH_SCOPES_MISSING_CODE,
  posthogDestinationUrl,
} from '@talyn/shared';
import { workflowRoutes } from '../../routes/workflows.js';
import { posthogInboxRoutes } from '../../routes/posthogInbox.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { internalProxyHeaders, requireAuth } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { inboundConnections, integrations, workspaces as workspacesTable } from '../../db/schema.js';
import { _resetWorkflowStore } from '../../services/workflows/store.js';
import { resetFeatureFlagsForTests } from '../../services/featureFlags.js';
import { decryptString, encryptString } from '../../services/tokenCrypto.js';
import { hashWebhookToken } from '../../services/inbound/adapters/webhook.js';
import { PostHogCodeApiError } from '../../services/posthogCode/client.js';
import { PostHogReauthRequiredError } from '../../services/posthogOAuth/core.js';
import { missingPushSetupScopes } from '../../services/posthogInbox/connection.js';
import {
  classifyDestinationError,
  DESTINATION_FILTERS,
  destinationPayload,
  WEBHOOK_TEMPLATE_ID,
} from '../../services/posthogInbox/destination.js';

/**
 * "Set up push in PostHog": Talyn creates and keeps in step the PostHog
 * webhook destination for the Inbox push, through a fake of PostHog's hog
 * functions API. Covers the first setup, idempotent re-runs, a destination
 * deleted in PostHog, rotate, remove, disconnect, missing scopes, PostHog
 * errors, the exact request body, and that the secret never leaks.
 */

const HOST = 'https://us.posthog.com';
const API_ORIGIN = 'https://api.talyn.test';
const PROJECT = '42';
const WS = 'ws-mine';
const CLIENT_ID = 'https://www.talyn.dev/oauth-client';
const FULL_SCOPE = 'openid inbox:read inbox:write task:write hog_function:read hog_function:write';
const RULES_SCOPE = 'openid inbox:read inbox:write task:write';
const realFetch = globalThis.fetch;
const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };

interface FakeFunction {
  id: string;
  deleted: boolean;
  type: string;
  template_id: string;
  body: Record<string, unknown>;
}

interface PostHogCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  auth: string | null;
}

/**
 * PostHog's hog functions API for one project, with the checks that matter
 * here: `DELETE` answers 405 (soft delete only), a deleted function answers
 * 404, another project's function answers 404, and a destination on
 * `$signals_report_ready` with a truthy `debug` input answers 400.
 */
class FakeHogFunctions {
  functions = new Map<string, FakeFunction>();
  calls: PostHogCall[] = [];
  /** The next request (of this method, or any) answers this status, or throws when 0. */
  failures: Array<{ method?: string; status: number }> = [];
  private seq = 0;

  constructor(private readonly projectId: string) {}

  failNext(status: number, method?: string): void {
    this.failures.push({ method, status });
  }

  live(): FakeFunction[] {
    return [...this.functions.values()].filter((f) => !f.deleted);
  }

  async handle(url: URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const auth = new Headers(init?.headers).get('authorization');
    this.calls.push({ method, path: url.pathname, body, auth });
    const failure = this.failures.findIndex((f) => !f.method || f.method === method);
    if (failure >= 0) {
      const [{ status }] = this.failures.splice(failure, 1);
      if (status === 0) throw new TypeError('fetch failed');
      return json({ detail: 'nope', echo: body }, status);
    }
    const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/hog_functions\/(?:([^/]+)\/)?$/);
    if (!match) return json({ detail: 'Not found.' }, 404);
    const [, projectId, id] = match;
    if (projectId !== this.projectId) return json({ detail: 'Not found.' }, 404);
    if (!id) {
      if (method !== 'POST') return json({ detail: 'Method not allowed' }, 405);
      const invalid = this.validate(body ?? {});
      if (invalid) return json({ inputs: invalid }, 400);
      const fn: FakeFunction = {
        id: `0199-hog-${++this.seq}`,
        deleted: false,
        type: String(body?.type),
        template_id: String(body?.template_id),
        body: body ?? {},
      };
      this.functions.set(fn.id, fn);
      return json(this.view(fn), 201);
    }
    const fn = this.functions.get(id);
    if (method === 'DELETE') return json(null, 405);
    if (!fn || fn.deleted) return json({ detail: 'Not found.' }, 404);
    if (method === 'GET') return json(this.view(fn));
    if (method !== 'PATCH') return json({ detail: 'Method not allowed' }, 405);
    if (body?.type && body.type !== fn.type) return json({ type: ['Cannot modify the type of an existing function'] }, 400);
    if (body?.deleted === true) {
      fn.deleted = true;
      return json(this.view(fn));
    }
    const invalid = this.validate({ ...fn.body, ...body });
    if (invalid) return json({ inputs: invalid }, 400);
    fn.body = { ...fn.body, ...body };
    return json(this.view(fn));
  }

  private validate(body: Record<string, unknown>): string | null {
    const filters = body.filters as { events?: Array<{ id?: string }> } | undefined;
    const guarded = (filters?.events ?? []).some((e) => e.id === '$signals_report_ready');
    const debug = (body.inputs as Record<string, { value?: unknown }> | undefined)?.debug?.value;
    if (guarded && debug !== undefined && debug !== null && debug !== false && debug !== '' && debug !== 0) {
      return "Destinations on $signals_report_ready can't log debug output. Turn off the debug input.";
    }
    return null;
  }

  /** What PostHog answers: secret inputs masked. */
  private view(fn: FakeFunction) {
    const inputs = { ...((fn.body.inputs as Record<string, unknown>) ?? {}) };
    if (inputs.secret_headers) inputs.secret_headers = { secret: true };
    return { id: fn.id, type: fn.type, name: fn.body.name, enabled: fn.body.enabled, inputs };
  }

  /** The secret and URL PostHog holds for a function. */
  held(id: string): { url: string; secret: string | undefined } {
    const inputs = this.functions.get(id)!.body.inputs as Record<string, { value: unknown }>;
    return {
      url: String(inputs.url.value),
      secret: (inputs.secret_headers.value as Record<string, string>)['X-Talyn-Secret'],
    };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PostHog Inbox push setup', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let base: string;
  let server: Server;
  let posthog: FakeHogFunctions;
  let logs: string[];

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('POSTHOG_INBOX_RULES_ENABLED', 'true');
    vi.stubEnv('TALYN_PUBLIC_API_URL', API_ORIGIN);
    resetFeatureFlagsForTests();
    _resetWorkflowStore();
    posthog = new FakeHogFunctions(PROJECT);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.origin === HOST) return posthog.handle(url, init);
      return realFetch(input, init);
    });
    logs = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }

    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await db.insert(workspacesTable).values({ id: WS, ownerId: TEST_USER_ID, name: 'mine', settings: {} });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/workflows', requireAuth, wrapAsyncRoutes(workflowRoutes()));
    app.use('/api/v1/posthog-inbox', requireAuth, wrapAsyncRoutes(posthogInboxRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
    _resetWorkflowStore();
    await cleanup();
  });

  /** The Inbox's own row: an OAuth grant with `scope`, or a personal API key. */
  async function connect(auth: { scope: string | undefined } | 'key' = { scope: FULL_SCOPE }, projectId = PROJECT) {
    await db.delete(integrations).where(eq(integrations.workspaceId, WS));
    const config =
      auth === 'key'
        ? { apiKeyEnc: encryptString('phx_key'), projectId, host: HOST, authMethod: 'personal_api_key' }
        : {
            projectId,
            host: HOST,
            authMethod: 'oauth',
            oauth: {
              accessTokenEnc: encryptString('pha_token'),
              refreshTokenEnc: encryptString('phr_token'),
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              scope: auth.scope,
              clientId: CLIENT_ID,
            },
          };
    await db.insert(integrations).values({ id: `int-${WS}`, workspaceId: WS, type: 'posthog_inbox', enabled: true, config });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the answers have many shapes
  type Json = { success: boolean; data: any; error?: string; code?: string; missingScopes?: string[] };
  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: JSON.parse(text) as Json, text };
  }
  const setup = () => call('POST', '/workflows/posthog-inbox/webhook/setup', { workspaceId: WS });
  const rotate = (requireSecret?: boolean) =>
    call('POST', '/workflows/posthog-inbox/webhook/rotate', { workspaceId: WS, ...(requireSecret === undefined ? {} : { requireSecret }) });
  const getWebhook = () => call('GET', `/workflows/posthog-inbox/webhook?workspaceId=${WS}`);
  const status = () => call('GET', `/workflows/posthog-inbox/status?workspaceId=${WS}`);
  const remove = () => call('DELETE', `/workflows/posthog-inbox/webhook?workspaceId=${WS}`);
  const disconnect = () => call('DELETE', `/posthog-inbox/config?workspaceId=${WS}`);

  async function urlRows() {
    return db.select().from(inboundConnections).where(eq(inboundConnections.workspaceId, WS));
  }

  /** The URL token and secret PostHog holds must be the ones Talyn checks. */
  async function expectPostHogHoldsTalynsCredentials(destinationId: string) {
    const [row] = await urlRows();
    const held = posthog.held(destinationId);
    const token = held.url.split('/').pop()!;
    expect(held.url).toBe(`${API_ORIGIN}/api/v1/webhooks/in/${row.id}/${token}`);
    expect(row.tokenHash).toBe(hashWebhookToken(token));
    expect(held.secret).toMatch(/^whsec_/);
    expect(decryptString(row.secretEnc!)).toBe(held.secret);
    return { token, secret: held.secret! };
  }

  /** Every URL token and secret PostHog ever received. */
  function credentialsSent(): string[] {
    const out: string[] = [];
    for (const c of posthog.calls) {
      const inputs = (c.body?.inputs ?? {}) as Record<string, { value: unknown }>;
      if (inputs.url) out.push(String(inputs.url.value).split('/').pop()!);
      const secret = (inputs.secret_headers?.value as Record<string, string> | undefined)?.['X-Talyn-Secret'];
      if (secret) out.push(secret);
    }
    return out;
  }

  describe('first setup', () => {
    it('creates the destination in PostHog and stores its id, without showing the URL token or the secret', async () => {
      await connect();
      const res = await setup();
      expect(res.status).toBe(200);
      expect(posthog.calls).toHaveLength(1);
      const [create] = posthog.calls;
      expect(create).toMatchObject({ method: 'POST', path: `/api/projects/${PROJECT}/hog_functions/`, auth: 'Bearer pha_token' });

      const [fn] = posthog.live();
      expect(res.json.data).toEqual({
        connectionId: (await urlRows())[0].id,
        created: true,
        destination: {
          id: fn.id,
          url: `${HOST}/project/${PROJECT}/functions/${fn.id}`,
          syncedAt: expect.any(String),
          error: null,
        },
      });
      const { token, secret } = await expectPostHogHoldsTalynsCredentials(fn.id);
      expect(res.text).not.toContain(token);
      expect(res.text).not.toContain(secret);

      const [row] = await urlRows();
      expect(row).toMatchObject({ kind: 'posthog_inbox', externalAccountId: PROJECT, posthogDestinationId: fn.id, posthogDestinationError: null });
      expect(row.posthogDestinationSyncedAt).toBeInstanceOf(Date);
    });

    it('sends the body the Inbox sub-template sends: internal destination, webhook template, the ready event, POST, JSON, secret header, no debug', async () => {
      await connect();
      await setup();
      const body = posthog.calls[0].body!;
      const [row] = await urlRows();
      const held = posthog.held(posthog.live()[0].id);
      expect(body).toEqual({
        type: 'internal_destination',
        template_id: 'template-webhook',
        name: POSTHOG_INBOX_DESTINATION_NAME,
        description: expect.stringContaining('Talyn'),
        enabled: true,
        filters: { source: 'internal-events', events: [{ id: '$signals_report_ready', type: 'events' }] },
        inputs: {
          url: { value: `${API_ORIGIN}/api/v1/webhooks/in/${row.id}/${held.url.split('/').pop()}` },
          method: { value: 'POST' },
          body: { value: { event: '{event}', person: '{person}' }, templating: 'hog' },
          headers: { value: { 'Content-Type': 'application/json' }, templating: 'hog' },
          secret_headers: { value: { 'X-Talyn-Secret': held.secret } },
          debug: { value: false },
        },
      });
      // The secret is only ever in the encrypted secret headers, never a plain header.
      expect(JSON.stringify((body.inputs as Record<string, unknown>).headers)).not.toContain('whsec_');
    });

    it('works with a personal API key too, whose scopes Talyn cannot read', async () => {
      await connect('key');
      const res = await setup();
      expect(res.status).toBe(200);
      expect(posthog.calls[0].auth).toBe('Bearer phx_key');
      expect(posthog.live()).toHaveLength(1);
    });

    it('turns an existing hand-made URL into a managed one: same row, new token and secret', async () => {
      await connect();
      const manual = await rotate();
      const before = (await urlRows())[0];
      const res = await setup();
      expect(res.status).toBe(200);
      const after = await urlRows();
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(manual.json.data.connectionId);
      expect(after[0].tokenHash).not.toBe(before.tokenHash);
      expect(after[0].posthogDestinationId).toBe(posthog.live()[0].id);
      // The URL from the one-time reveal stops working.
      expect(after[0].tokenHash).not.toBe(hashWebhookToken(String(manual.json.data.url).split('/').pop()!));
      await expectPostHogHoldsTalynsCredentials(posthog.live()[0].id);
    });
  });

  describe('re-running setup', () => {
    it('updates the same destination instead of making a second one', async () => {
      await connect();
      const first = await setup();
      const second = await setup();
      expect(second.status).toBe(200);
      expect(second.json.data.created).toBe(false);
      expect(second.json.data.destination.id).toBe(first.json.data.destination.id);
      expect(second.json.data.connectionId).toBe(first.json.data.connectionId);
      expect(posthog.functions.size).toBe(1);
      const patch = posthog.calls[1];
      expect(patch).toMatchObject({ method: 'PATCH', path: `/api/projects/${PROJECT}/hog_functions/${first.json.data.destination.id}/` });
      // An update never sends the type (PostHog refuses a type change) or the template.
      expect(patch.body).not.toHaveProperty('type');
      expect(patch.body).not.toHaveProperty('template_id');
      expect(patch.body).toMatchObject({ enabled: true, filters: DESTINATION_FILTERS, inputs: { debug: { value: false } } });
      await expectPostHogHoldsTalynsCredentials(first.json.data.destination.id);
    });

    it.each([
      ['deleted in PostHog', (p: FakeHogFunctions, id: string) => void (p.functions.get(id)!.deleted = true)],
      ['gone from PostHog', (p: FakeHogFunctions, id: string) => void p.functions.delete(id)],
    ])('makes a new destination when the old one was %s', async (_label, lose) => {
      await connect();
      const first = await setup();
      lose(posthog, first.json.data.destination.id);
      const second = await setup();
      expect(second.status).toBe(200);
      expect(second.json.data.created).toBe(true);
      expect(second.json.data.destination.id).not.toBe(first.json.data.destination.id);
      expect(posthog.calls.map((c) => c.method)).toEqual(['POST', 'PATCH', 'POST']);
      expect((await urlRows())[0].posthogDestinationId).toBe(second.json.data.destination.id);
      await expectPostHogHoldsTalynsCredentials(second.json.data.destination.id);
    });

    it('turns a destination back on and restores its trigger when somebody changed them in PostHog', async () => {
      await connect();
      const first = await setup();
      const fn = posthog.functions.get(first.json.data.destination.id)!;
      fn.body = { ...fn.body, enabled: false, filters: { source: 'internal-events', events: [{ id: '$other', type: 'events' }] } };
      await setup();
      expect(fn.body).toMatchObject({ enabled: true, filters: DESTINATION_FILTERS });
    });

    it('two setups at once still make one destination', async () => {
      await connect();
      const [a, b] = await Promise.all([setup(), setup()]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(posthog.live()).toHaveLength(1);
      expect(await urlRows()).toHaveLength(1);
      await expectPostHogHoldsTalynsCredentials(posthog.live()[0].id);
    });

    it.each([
      ['rotate then setup', true],
      ['setup then rotate', false],
    ])('a rotate and a setup at the same time (%s) leave PostHog with the credentials Talyn checks', async (_label, rotateFirst) => {
      await connect();
      const first = await setup();
      const calls = rotateFirst ? [rotate(), setup()] : [setup(), rotate()];
      const answers = await Promise.all(calls);
      expect(answers.map((a) => a.status)).toEqual([200, 200]);
      expect(posthog.live()).toHaveLength(1);
      await expectPostHogHoldsTalynsCredentials(first.json.data.destination.id);
    });

    it('a URL for an earlier project is replaced, and the new project gets its own destination', async () => {
      await connect({ scope: FULL_SCOPE }, '7');
      const other = new FakeHogFunctions('7');
      const current = posthog;
      posthog = other;
      await setup();
      posthog = current;
      await connect({ scope: FULL_SCOPE }, PROJECT);
      const res = await setup();
      expect(res.status).toBe(200);
      const rows = await urlRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ externalAccountId: PROJECT, posthogDestinationId: posthog.live()[0].id });
    });
  });

  describe('missing scopes', () => {
    it.each([
      ['a grant from before push setup', RULES_SCOPE, ['hog_function:read', 'hog_function:write']],
      ['read only', `${RULES_SCOPE} hog_function:read`, ['hog_function:write']],
      ['write only', `${RULES_SCOPE} hog_function:write`, ['hog_function:read']],
      ['a near miss', `${RULES_SCOPE} hog_function:readx hog_functions:write`, ['hog_function:read', 'hog_function:write']],
      ['no scope at all', undefined, ['hog_function:read', 'hog_function:write']],
    ])('refuses %s with the reconnect message, calls nobody and rotates nothing', async (_label, scope, missing) => {
      await connect();
      await setup();
      const before = await urlRows();
      const calls = posthog.calls.length;
      await connect({ scope });
      const res = await setup();
      if (scope?.includes('inbox:read')) {
        expect(res.status).toBe(409);
        expect(res.json.code).toBe(POSTHOG_INBOX_PUSH_SCOPES_MISSING_CODE);
        expect(res.json.error).toContain('Reconnect PostHog to let Talyn set up push.');
        expect(res.json.error).toContain('Talyn did not change the webhook URL');
        expect(res.json.missingScopes).toEqual(missing);
      } else {
        // Without inbox:read the connection cannot read the Inbox at all: the general refusal.
        expect(res.status).toBe(409);
        expect(res.json.code).toBe('posthog_inbox_unavailable');
      }
      expect(posthog.calls).toHaveLength(calls);
      expect(await urlRows()).toEqual(before);
    });

    it.each([
      ['the full grant', FULL_SCOPE, [], 'ok'],
      ['a grant from before push setup', RULES_SCOPE, ['hog_function:read', 'hog_function:write'], 'ok'],
      ['read only', `${RULES_SCOPE} hog_function:read`, ['hog_function:write'], 'ok'],
    ])('the status lists the push scopes apart, so %s still reads as connected', async (_label, scope, missing, access) => {
      await connect({ scope });
      const res = await status();
      expect(res.json.data).toMatchObject({ access, missingScopes: [], pushSetupMissingScopes: missing, pushManaged: false });
    });

    it('a personal API key lists no push scopes', async () => {
      await connect('key');
      expect((await status()).json.data).toMatchObject({ pushSetupMissingScopes: [], missingScopes: [] });
    });
  });

  describe('PostHog refuses or fails', () => {
    it.each([
      [403, 'POST', 409, POSTHOG_INBOX_PUSH_FORBIDDEN_CODE, 'hog_function:write and inbox:read'],
      [401, 'POST', 409, POSTHOG_INBOX_PUSH_FORBIDDEN_CODE, 'Reconnect PostHog'],
      [400, 'POST', 502, POSTHOG_INBOX_PUSH_FAILED_CODE, 'did not accept the destination (400)'],
      [404, 'POST', 502, POSTHOG_INBOX_PUSH_FAILED_CODE, 'did not accept the destination (404)'],
      [408, 'POST', 502, POSTHOG_INBOX_PUSH_FAILED_CODE, 'Try again later'],
      [429, 'POST', 502, POSTHOG_INBOX_PUSH_FAILED_CODE, 'Try again later'],
      [500, 'POST', 502, POSTHOG_INBOX_PUSH_FAILED_CODE, 'Try again later'],
      [503, 'POST', 502, POSTHOG_INBOX_PUSH_FAILED_CODE, 'Try again later'],
      [0, 'POST', 502, POSTHOG_INBOX_PUSH_FAILED_CODE, 'could not reach PostHog'],
    ])('a %i on the %s answers %i and changes nothing in Talyn', async (posthogStatus, method, expected, code, text) => {
      await connect('key');
      await rotate();
      const before = await urlRows();
      posthog.failNext(posthogStatus, method);
      // A 401 is retried once after a token refresh.
      if (posthogStatus === 401) posthog.failNext(posthogStatus, method);
      const res = await setup();
      expect(res.status).toBe(expected);
      expect(res.json.code).toBe(code);
      expect(res.json.error).toContain(text);
      expect(res.json.error).toContain('Talyn did not change the webhook URL');
      expect(await urlRows()).toEqual(before);
      expect(posthog.live()).toHaveLength(0);
    });

    it.each([[403], [500], [0]])('a %i on the update of an existing destination keeps the old URL working', async (posthogStatus) => {
      await connect('key');
      const first = await setup();
      const before = await urlRows();
      const held = posthog.held(first.json.data.destination.id);
      posthog.failNext(posthogStatus, 'PATCH');
      const res = await setup();
      expect(res.status).toBe(posthogStatus === 403 ? 409 : 502);
      expect(await urlRows()).toEqual(before);
      // PostHog still holds the credentials Talyn still checks.
      expect(posthog.held(first.json.data.destination.id)).toEqual(held);
      await expectPostHogHoldsTalynsCredentials(first.json.data.destination.id);
      expect(posthog.functions.size).toBe(1);
    });

    it('a debug input PostHog refuses never reaches PostHog: Talyn always sends debug off', async () => {
      await connect();
      const res = await setup();
      expect(res.status).toBe(200);
      expect((posthog.calls[0].body!.inputs as Record<string, unknown>).debug).toEqual({ value: false });
    });
  });

  describe('rotate', () => {
    it('gives the managed destination the new URL and secret', async () => {
      await connect();
      const first = await setup();
      const res = await rotate();
      expect(res.status).toBe(200);
      const id = first.json.data.destination.id;
      expect(res.json.data.destination).toEqual({ state: 'updated', error: null, url: `${HOST}/project/${PROJECT}/functions/${id}` });
      const held = posthog.held(id);
      expect(held.url).toBe(res.json.data.url);
      expect(held.secret).toBe(res.json.data.secret);
      await expectPostHogHoldsTalynsCredentials(id);
      expect(posthog.calls.at(-1)).toMatchObject({ method: 'PATCH' });
      expect(posthog.functions.size).toBe(1);
    });

    it('a rotate without a secret clears the secret header in PostHog', async () => {
      await connect();
      const first = await setup();
      const res = await rotate(false);
      expect(res.json.data.secret).toBeNull();
      expect(res.json.data.destination.state).toBe('updated');
      const inputs = posthog.calls.at(-1)!.body!.inputs as Record<string, { value: unknown }>;
      expect(inputs.secret_headers).toEqual({ value: {} });
      expect(posthog.held(first.json.data.destination.id).url).toBe(res.json.data.url);
    });

    it('a URL the person set up by hand calls nobody in PostHog', async () => {
      await connect();
      await rotate();
      const res = await rotate();
      expect(res.status).toBe(200);
      expect(res.json.data.destination).toBeNull();
      expect(posthog.calls).toHaveLength(0);
    });

    it.each([
      [403, 'hog_function:write and inbox:read'],
      [500, 'Try again later'],
      [0, 'could not reach PostHog'],
    ])('a %i from PostHog still rotates, and says the destination is out of date until setup runs again', async (posthogStatus, text) => {
      await connect();
      const first = await setup();
      const id = first.json.data.destination.id;
      const old = posthog.held(id);
      posthog.failNext(posthogStatus, 'PATCH');
      const res = await rotate();
      expect(res.status).toBe(200);
      expect(res.json.data.url).not.toBe(old.url);
      expect(res.json.data.destination.state).toBe('failed');
      expect(res.json.data.destination.error).toContain('The destination still sends to the old URL');
      expect(res.json.data.destination.error).toContain(text);

      const shown = await getWebhook();
      expect(shown.json.data.destination).toMatchObject({ id, error: expect.stringContaining('still sends to the old URL') });
      expect(shown.json.data.destination.error).toContain('Set up push in PostHog');

      const fixed = await setup();
      expect(fixed.status).toBe(200);
      expect(fixed.json.data.destination).toMatchObject({ id, error: null });
      expect((await getWebhook()).json.data.destination.error).toBeNull();
      await expectPostHogHoldsTalynsCredentials(id);
    });

    it('a grant that lost the push scopes still rotates, and says the destination is out of date', async () => {
      await connect();
      await setup();
      const calls = posthog.calls.length;
      await connect({ scope: RULES_SCOPE });
      const res = await rotate();
      expect(res.status).toBe(200);
      expect(res.json.data.destination.state).toBe('failed');
      expect(res.json.data.destination.error).toContain('Reconnect PostHog to let Talyn set up push.');
      expect(posthog.calls).toHaveLength(calls);
    });

    it('a destination somebody deleted in PostHog is not made again; Talyn forgets it', async () => {
      await connect();
      const first = await setup();
      posthog.functions.get(first.json.data.destination.id)!.deleted = true;
      const res = await rotate();
      expect(res.json.data.destination).toEqual({ state: 'not_found', error: null, url: null });
      expect(posthog.live()).toHaveLength(0);
      expect((await urlRows())[0].posthogDestinationId).toBeNull();
      expect((await getWebhook()).json.data.destination).toBeNull();
      expect((await status()).json.data.pushManaged).toBe(false);
    });
  });

  describe('remove', () => {
    it('deletes the destination with PostHog soft delete (PATCH deleted), never DELETE', async () => {
      await connect();
      const first = await setup();
      const res = await remove();
      expect(res.status).toBe(200);
      expect(res.json.data).toEqual({
        removed: 1,
        destination: { state: 'deleted', error: null, url: `${HOST}/project/${PROJECT}/functions/${first.json.data.destination.id}` },
      });
      expect(posthog.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { deleted: true } });
      expect(posthog.calls.some((c) => c.method === 'DELETE')).toBe(false);
      expect(posthog.live()).toHaveLength(0);
      expect(await urlRows()).toHaveLength(0);
    });

    it('a URL without a Talyn destination calls nobody', async () => {
      await connect();
      await rotate();
      const res = await remove();
      expect(res.json.data).toEqual({ removed: 1, destination: null });
      expect(posthog.calls).toHaveLength(0);
    });

    it('a destination already gone in PostHog is fine', async () => {
      await connect();
      const first = await setup();
      posthog.functions.delete(first.json.data.destination.id);
      const res = await remove();
      expect(res.json.data.destination.state).toBe('not_found');
      expect(await urlRows()).toHaveLength(0);
    });

    it.each([[403], [500], [0]])('a %i from PostHog still removes the URL, and says to delete the destination in PostHog', async (posthogStatus) => {
      await connect();
      const first = await setup();
      posthog.failNext(posthogStatus, 'PATCH');
      const res = await remove();
      expect(res.status).toBe(200);
      expect(res.json.data.removed).toBe(1);
      expect(res.json.data.destination).toMatchObject({
        state: 'failed',
        error: expect.stringContaining('Delete the destination in PostHog'),
        url: posthogDestinationUrl(HOST, PROJECT, first.json.data.destination.id),
      });
      expect(await urlRows()).toHaveLength(0);
    });

    it('with no PostHog connection left, still removes the URL and says to delete the destination in PostHog', async () => {
      await connect();
      await setup();
      await db.delete(integrations).where(eq(integrations.workspaceId, WS));
      const calls = posthog.calls.length;
      const res = await remove();
      expect(res.status).toBe(200);
      expect(res.json.data.destination).toMatchObject({ state: 'failed', error: expect.stringContaining('Delete it in PostHog') });
      expect(posthog.calls).toHaveLength(calls);
      expect(await urlRows()).toHaveLength(0);
    });
  });

  describe('disconnect', () => {
    it('deletes the destination, then the connection', async () => {
      await connect();
      await setup();
      const res = await disconnect();
      expect(res.status).toBe(200);
      expect(posthog.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { deleted: true } });
      expect(posthog.live()).toHaveLength(0);
      expect(await db.select().from(integrations).where(eq(integrations.workspaceId, WS))).toHaveLength(0);
      const [row] = await urlRows();
      expect(row).toMatchObject({ posthogDestinationId: null, posthogDestinationError: null });
    });

    it.each([[403], [500], [0]])('a %i from PostHog never blocks the disconnect; Talyn keeps the id to update later', async (posthogStatus) => {
      await connect();
      const first = await setup();
      posthog.failNext(posthogStatus, 'PATCH');
      const res = await disconnect();
      expect(res.status).toBe(200);
      expect(await db.select().from(integrations).where(eq(integrations.workspaceId, WS))).toHaveLength(0);
      const [row] = await urlRows();
      expect(row.posthogDestinationId).toBe(first.json.data.destination.id);
      expect(row.posthogDestinationError).toContain('Delete it in PostHog');
    });

    it('a workspace without a Talyn destination calls nobody', async () => {
      await connect();
      await rotate();
      expect((await disconnect()).status).toBe(200);
      expect(posthog.calls).toHaveLength(0);
    });

    it('after a disconnect and a reconnect, setup updates the destination PostHog could not delete', async () => {
      await connect();
      const first = await setup();
      posthog.failNext(500, 'PATCH');
      await disconnect();
      await connect();
      const again = await setup();
      expect(again.json.data).toMatchObject({ created: false, destination: { id: first.json.data.destination.id, error: null } });
      expect(posthog.live()).toHaveLength(1);
    });
  });

  describe('status and webhook', () => {
    it('shows whether Talyn manages the destination, with its PostHog link', async () => {
      await connect();
      expect((await status()).json.data).toMatchObject({ pushConfigured: false, pushManaged: false });
      await rotate();
      expect((await status()).json.data).toMatchObject({ pushConfigured: true, pushManaged: false });
      expect((await getWebhook()).json.data.destination).toBeNull();
      const made = await setup();
      expect((await status()).json.data).toMatchObject({ pushConfigured: true, pushManaged: true });
      const shown = await getWebhook();
      expect(shown.json.data.destination).toEqual({
        id: made.json.data.destination.id,
        url: `${HOST}/project/${PROJECT}/functions/${made.json.data.destination.id}`,
        syncedAt: expect.any(String),
        error: null,
      });
    });
  });

  describe('gates', () => {
    it('the flag off refuses setup and calls nobody', async () => {
      await connect();
      vi.stubEnv('POSTHOG_INBOX_RULES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      const res = await setup();
      expect(res.status).toBe(404);
      expect(posthog.calls).toHaveLength(0);
      expect(await urlRows()).toHaveLength(0);
    });

    it('another workspace is refused', async () => {
      await seedUser(db, { id: 'user-other', email: 'other@example.test' });
      await db.insert(workspacesTable).values({ id: 'ws-theirs', ownerId: 'user-other', name: 'theirs', settings: {} });
      const res = await call('POST', '/workflows/posthog-inbox/webhook/setup', { workspaceId: 'ws-theirs' });
      expect([403, 404]).toContain(res.status);
      expect(posthog.calls).toHaveLength(0);
    });

    it('no PostHog connection is refused with the existing message', async () => {
      const res = await setup();
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('posthog_inbox_unavailable');
    });
  });

  it('never logs or answers the URL token or the secret, through setup, failures, rotate, remove and disconnect', async () => {
    await connect();
    const answers: string[] = [];
    answers.push((await setup()).text);
    answers.push((await setup()).text);
    posthog.failNext(500, 'PATCH');
    answers.push((await setup()).text);
    posthog.failNext(403, 'PATCH');
    const failedRotate = await rotate();
    answers.push((await getWebhook()).text, (await status()).text);
    answers.push((await setup()).text);
    answers.push((await getWebhook()).text);
    posthog.failNext(500, 'PATCH');
    answers.push((await disconnect()).text);
    await connect();
    answers.push((await remove()).text);

    const secrets = credentialsSent();
    expect(secrets.length).toBeGreaterThan(4);
    // The rotate's one-time reveal is the only answer allowed to hold them (#257).
    const revealed = [String(failedRotate.json.data.url).split('/').pop()!, failedRotate.json.data.secret as string];
    for (const secret of secrets) {
      for (const text of answers) expect(text).not.toContain(secret);
      for (const line of logs) expect(line).not.toContain(secret);
    }
    for (const secret of revealed) for (const line of logs) expect(line).not.toContain(secret);
    expect(logs.join('\n')).not.toContain('whsec_');
    // The failures were logged, by status.
    expect(logs.some((l) => l.includes('[posthog-inbox] destination'))).toBe(true);
  });
});

describe('PostHog destination pure helpers', () => {
  it.each([
    ['create', { url: 'https://api.talyn.test/x/tok', secret: 'whsec_a' }],
    ['update', { url: 'https://api.talyn.test/x/tok', secret: 'whsec_a' }],
    ['create', { url: 'https://api.talyn.test/x/tok', secret: null }],
    ['update', { url: 'https://api.talyn.test/x/tok', secret: null }],
  ] as const)('destinationPayload %s with %j', (mode, input) => {
    const body = destinationPayload(input, mode);
    if (mode === 'create') expect(body).toMatchObject({ type: 'internal_destination', template_id: WEBHOOK_TEMPLATE_ID });
    else {
      expect(body).not.toHaveProperty('type');
      expect(body).not.toHaveProperty('template_id');
    }
    expect(body.enabled).toBe(true);
    expect(body.filters).toEqual(DESTINATION_FILTERS);
    expect(body.inputs!.debug).toEqual({ value: false });
    expect(body.inputs!.url).toEqual({ value: input.url });
    expect(body.inputs!.secret_headers).toEqual({ value: input.secret ? { 'X-Talyn-Secret': input.secret } : {} });
    expect(JSON.stringify(body.inputs!.headers)).not.toContain('whsec_');
    // Each call gets its own filters, so a caller cannot change the shared constant.
    (body.filters!.events as Array<{ id: string }>)[0].id = 'changed';
    expect(DESTINATION_FILTERS.events[0].id).toBe('$signals_report_ready');
  });

  it.each([
    [new PostHogCodeApiError(403, null, 'x'), 'forbidden', 403],
    [new PostHogCodeApiError(401, null, 'x'), 'unauthorized', 401],
    [new PostHogCodeApiError(400, null, 'x'), 'invalid', 400],
    [new PostHogCodeApiError(404, null, 'x'), 'invalid', 404],
    [new PostHogCodeApiError(409, null, 'x'), 'invalid', 409],
    [new PostHogCodeApiError(408, null, 'x'), 'unavailable', 408],
    [new PostHogCodeApiError(429, 1000, 'x'), 'unavailable', 429],
    [new PostHogCodeApiError(500, null, 'x'), 'unavailable', 500],
    [new PostHogCodeApiError(502, null, 'x'), 'unavailable', 502],
    [new TypeError('fetch failed'), 'unavailable', null],
    [new Error('PostHog Code request timed out after 30000ms: https://us.posthog.com/api/projects/42/hog_functions/'), 'unavailable', null],
    ['a string', 'unavailable', null],
    [new PostHogReauthRequiredError('revoked'), 'unauthorized', 401],
  ])('classifies %s as %s', (err, kind, statusCode) => {
    const failure = classifyDestinationError(err);
    expect(failure).toMatchObject({ kind, status: statusCode });
    expect(failure.message).not.toContain('https://');
  });

  it.each([
    ['openid inbox:read inbox:write task:write hog_function:read hog_function:write', []],
    ['openid inbox:read inbox:write task:write', ['hog_function:read', 'hog_function:write']],
    ['hog_function:write', ['hog_function:read']],
    ['hog_function:read', ['hog_function:write']],
    ['HOG_FUNCTION:READ hog_function:write', ['hog_function:read']],
    ['  hog_function:read   hog_function:write  ', []],
    ['', ['hog_function:read', 'hog_function:write']],
    [null, ['hog_function:read', 'hog_function:write']],
    [undefined, ['hog_function:read', 'hog_function:write']],
  ])('missingPushSetupScopes(%j) is %j', (scope, missing) => {
    expect(missingPushSetupScopes(scope)).toEqual(missing);
  });

  it.each([
    ['https://us.posthog.com', '42', 'abc', 'https://us.posthog.com/project/42/functions/abc'],
    ['https://eu.posthog.com/', '7', 'f-1', 'https://eu.posthog.com/project/7/functions/f-1'],
    ['https://posthog.example.com//', '1', 'a b', 'https://posthog.example.com/project/1/functions/a%20b'],
    [null, '42', 'abc', null],
    ['https://us.posthog.com', null, 'abc', null],
    ['https://us.posthog.com', '42', null, null],
    ['', '42', 'abc', null],
  ])('posthogDestinationUrl(%j, %j, %j)', (host, projectId, id, expected) => {
    expect(posthogDestinationUrl(host, projectId, id)).toBe(expected);
  });
});
