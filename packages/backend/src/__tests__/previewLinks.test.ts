import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'http';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { WebSocket, type RawData } from 'ws';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  repositories,
  workbenchPreviewHosts,
  workbenchPreviewSessions,
  workbenchPreviewTickets,
  workspaces,
} from '../db/schema.js';
import { insertWorkbench, updateWorkbench } from '../services/workbenches/store.js';
import { setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import type { FleetClient } from '../services/selfHosted/client.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { wrapAsyncRoutes } from '../middleware/asyncHandler.js';
import { workbenchRoutes } from '../routes/workbenches.js';
import { createOriginPolicy } from '../services/originPolicy.js';
import { isSafePreviewPath } from '../services/preview/portsHttp.js';
import { matchPreviewHost, previewBaseDomain, previewLinksConfigured, previewOrigin } from '../services/preview/previewHost.js';
import {
  appSetCookie,
  handlePreviewHostUpgrade,
  localLocation,
  previewHostRouter,
  splitCookies,
} from '../services/preview/previewHostRouter.js';
import { hashPreviewToken, PREVIEW_COOKIE, resetPreviewAccessCacheForTests } from '../services/preview/previewLinks.js';

const DOMAIN = 'preview.test';
const ID = '0123456789abcdef0123456789abcdef';

class Upstream extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Array<{ data: RawData; binary: boolean }> = [];
  closed: { code: number; reason: string } | undefined;
  send(data: RawData, opts: { binary: boolean }) { this.sent.push({ data, binary: opts.binary }); }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }
  terminate() { this.close(1006, ''); }
}

describe('preview host names', () => {
  it.each([
    [`${ID}-3000.${DOMAIN}`, { id: ID, port: 3000, host: `${ID}-3000.${DOMAIN}` }],
    [`${ID.toUpperCase()}-5173.PREVIEW.TEST`, { id: ID, port: 5173, host: `${ID}-5173.${DOMAIN}` }],
    [`${ID}-65535.${DOMAIN}`, { id: ID, port: 65535, host: `${ID}-65535.${DOMAIN}` }],
  ])('matches %s', (host, expected) => {
    expect(matchPreviewHost(host, DOMAIN)).toEqual(expected);
  });

  it.each([
    ['a lookalike suffix', `${ID}-3000.${DOMAIN}.evil.com`],
    ['a lookalike parent', `${ID}-3000.evil${DOMAIN}`],
    ['a domain that only ends the same', `evil${DOMAIN}`],
    ['the API host', 'api.talyn.dev'],
    ['no host header', undefined],
  ])('leaves %s to the API', (_name, host) => {
    expect(matchPreviewHost(host, DOMAIN)).toBeNull();
  });

  it.each([
    ['the bare domain', DOMAIN],
    ['a word label', `foo.${DOMAIN}`],
    ['a short id', `${ID.slice(1)}-3000.${DOMAIN}`],
    ['a non-hex id', `${'g'.repeat(32)}-3000.${DOMAIN}`],
    ['a low port', `${ID}-80.${DOMAIN}`],
    ['port 1023', `${ID}-1023.${DOMAIN}`],
    ['port 65536', `${ID}-65536.${DOMAIN}`],
    ['a nested label', `a.${ID}-3000.${DOMAIN}`],
    ['a stray port', `${ID}-3000.${DOMAIN}:8443`],
    ['a trailing dot', `${ID}-3000.${DOMAIN}.`],
    ['the bare domain with a port', `${DOMAIN}:443`],
  ])('refuses %s under the preview domain', (_name, host) => {
    expect(matchPreviewHost(host, DOMAIN)).toBe('invalid');
  });

  it('is off without a domain', () => {
    expect(matchPreviewHost(`${ID}-3000.${DOMAIN}`, null)).toBeNull();
  });

  it('matches a domain with a port exactly', () => {
    expect(matchPreviewHost(`${ID}-3000.preview.localhost:4747`, 'preview.localhost:4747')).toMatchObject({ port: 3000 });
    expect(matchPreviewHost(`${ID}-3000.preview.localhost`, 'preview.localhost:4747')).toBeNull();
  });

  it.each([
    [undefined, null],
    ['', null],
    ['  Preview.Talyn.dev ', 'preview.talyn.dev'],
    ['preview.localhost:4747', 'preview.localhost:4747'],
    ['https://preview.talyn.dev', null],
    ['preview.talyn.dev/x', null],
    ['localhost', null],
    ['*.preview.talyn.dev', null],
  ])('reads PREVIEW_BASE_DOMAIN %j as %j', (raw, expected) => {
    expect(previewBaseDomain({ PREVIEW_BASE_DOMAIN: raw })).toBe(expected);
    expect(previewLinksConfigured({ PREVIEW_BASE_DOMAIN: raw })).toBe(expected !== null);
  });

  it.each([
    [`${ID}-3000.preview.talyn.dev`, `https://${ID}-3000.preview.talyn.dev`],
    [`${ID}-3000.preview.localhost:4747`, `http://${ID}-3000.preview.localhost:4747`],
  ])('gives %s the origin %s', (host, origin) => {
    expect(previewOrigin(host)).toBe(origin);
  });

  it('never lets a preview host into the API origin allow-list', () => {
    const policy = createOriginPolicy({
      PREVIEW_BASE_DOMAIN: DOMAIN,
      ALLOWED_ORIGINS: `https://app.talyn.dev,https://${ID}-3000.${DOMAIN},https://${DOMAIN}`,
    });
    expect(policy.isAllowed('https://app.talyn.dev')).toBe(true);
    expect(policy.isAllowed(`https://${ID}-3000.${DOMAIN}`)).toBe(false);
    expect(policy.isAllowed(`https://${DOMAIN}`)).toBe(false);
  });
});

describe('preview header rules', () => {
  it.each([
    ['', true], ['src/main.ts', true], ['@vite/client', true], ['a%20b', true], ['%252e%252e/x', true],
    ['..', false], ['../exec', false], ['a/../../exec', false], ['%2e%2e/exec', false], ['%2E%2E/exec', false],
    ['./x', false], ['a\\b', false], ['a%5cb', false], ['a%00b', false], ['%ZZ', false],
  ])('path %j is safe: %s', (path, safe) => {
    expect(isSafePreviewPath(path)).toBe(safe);
  });

  it.each([
    [undefined, [], ''],
    [`${PREVIEW_COOKIE}=abc`, ['abc'], ''],
    [`app=1; ${PREVIEW_COOKIE}=abc; other=2`, ['abc'], 'app=1; other=2'],
    [`${PREVIEW_COOKIE}=a; ${PREVIEW_COOKIE}=b`, ['a', 'b'], ''],
    ['__Host-talyn-other=x; __Secure-talyn=y; app=1', [], 'app=1'],
    ['flag; app=1', [], 'flag; app=1'],
  ])('splits cookie header %j', (header, ours, rest) => {
    expect(splitCookies(header)).toEqual({ ours, rest });
  });

  it.each([
    ['sid=1; Path=/; HttpOnly', 'sid=1; Path=/; HttpOnly'],
    ['sid=1; Domain=preview.test; Path=/', 'sid=1; Path=/'],
    ['sid=1; domain=.talyn.dev; Secure', 'sid=1; Secure'],
    [`${PREVIEW_COOKIE}=evil; Path=/; Secure`, null],
    ['__host-TALYN-preview=evil; Path=/; Secure', null],
    ['__Secure-talyn-x=evil; Secure', null],
    ['=nameless', null],
  ])('passes the app cookie %j as %j', (value, expected) => {
    expect(appSetCookie(value)).toBe(expected);
  });

  it.each([
    ['http://localhost:5173/login?next=%2F#top', 5173, '/login?next=%2F#top'],
    ['http://127.0.0.1:5173/', 5173, '/'],
    ['http://localhost:3000/x', 5173, 'http://localhost:3000/x'],
    ['https://github.com/login', 5173, 'https://github.com/login'],
    ['/relative', 5173, '/relative'],
  ])('rewrites Location %s', (location, port, expected) => {
    expect(localLocation(location, port)).toBe(expected);
  });
});

describe('hosted preview links', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let port: number;
  let upstream: Upstream;
  let routes: Router;
  const proxyPort = vi.fn();
  const openPortWebSocket = vi.fn();

  function send(host: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', agent: false, headers: { host, ...opts.headers } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  async function mint(workbenchId = 'ready', previewPort = 5173, user = 'owner') {
    const res = await send('api.test', `/api/v1/workbenches/${workbenchId}/ports/${previewPort}/ticket`, {
      method: 'POST', headers: { 'x-user': user },
    });
    return { status: res.status, body: JSON.parse(res.body) as { success: boolean; data?: { url: string; origin: string; port: number; expiresAt: string }; code?: string } };
  }

  async function signIn(workbenchId = 'ready', previewPort = 5173) {
    const url = new URL((await mint(workbenchId, previewPort)).body.data!.url);
    const res = await send(url.host, `${url.pathname}${url.search}`);
    const cookie = (res.headers['set-cookie'] ?? [])[0]?.split(';')[0] ?? '';
    return { host: url.host, cookie, res };
  }

  beforeAll(async () => {
    testDb = await createTestDb();
    for (const id of ['owner', 'other', 'spammer']) await seedUser(testDb.db, { id });
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'owner', name: 'Mine' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
    for (const [id, runtime, status] of [
      ['ready', 'sandbox', 'ready'], ['ready2', 'sandbox', 'ready'], ['local', 'local', 'ready'],
      ['new', 'sandbox', 'provisioning'], ['archived', 'sandbox', 'archived'],
    ] as const) {
      await insertWorkbench({
        id, workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', baseBranch: 'main', branch: id, name: id,
        runtime, status, sandboxId: `sb-${id}`, agent: 'claude',
      });
    }

    const app = express();
    app.use(previewHostRouter());
    app.use(express.json());
    app.use((req, _res, next) => {
      const id = req.headers['x-user'];
      if (typeof id === 'string') req.user = { id, email: `${id}@example.test`, isAdmin: false };
      next();
    });
    app.get('/api/v1/marker', (_req, res) => { res.json({ api: true }); });
    // A new router per test, so each test starts with an empty mint limiter.
    app.use('/api/v1/workbenches', (req, res, next) => routes(req, res, next));
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status(500).json({ error: String(err) }); });
    server = createServer(app);
    server.on('upgrade', (req, socket, head) => {
      const match = matchPreviewHost(req.headers.host, previewBaseDomain());
      if (match) handlePreviewHostUpgrade(req, socket, head, match);
      else socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  beforeEach(() => {
    routes = wrapAsyncRoutes(workbenchRoutes());
    vi.stubEnv('PREVIEW_BASE_DOMAIN', DOMAIN);
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    resetFeatureFlagsForTests();
    resetPreviewAccessCacheForTests();
    proxyPort.mockReset();
    proxyPort.mockImplementation(async () => new Response('from the app', {
      status: 200,
      headers: [
        ['content-type', 'text/plain'],
        ['set-cookie', 'sid=1; Domain=preview.test; Path=/'],
        ['set-cookie', `${PREVIEW_COOKIE}=evil; Path=/; Secure`],
        ['access-control-allow-origin', '*'],
        ['x-fleet-host', 'hetzner-64'],
      ],
    }));
    upstream = new Upstream();
    openPortWebSocket.mockReset();
    openPortWebSocket.mockImplementation(() => {
      queueMicrotask(() => upstream.emit('open'));
      return upstream as unknown as WebSocket;
    });
    setWorkbenchFleetClientForTests(async () => ({ proxyPort, openPortWebSocket } as unknown as FleetClient));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    setWorkbenchFleetClientForTests(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await testDb.cleanup();
    resetFeatureFlagsForTests();
  });

  describe('minting a ticket', () => {
    it('is off when PREVIEW_BASE_DOMAIN is unset', async () => {
      vi.stubEnv('PREVIEW_BASE_DOMAIN', '');
      expect(await mint()).toMatchObject({ status: 404, body: { code: 'preview_links_unavailable' } });
    });

    it.each([
      ['another user', 'ready', 5173, 'other', 404],
      ['a missing session', 'missing', 5173, 'owner', 404],
      ['a local session', 'local', 5173, 'owner', 400],
      ['an archived session', 'archived', 5173, 'owner', 409],
      ['a low port', 'ready', 80, 'owner', 400],
      ['a port above 65535', 'ready', 70000, 'owner', 400],
    ])('refuses %s', async (_name, id, previewPort, user, status) => {
      expect((await mint(id, previewPort, user)).status).toBe(status);
    });

    it('checks the workbenches flag', async () => {
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      expect(await mint()).toMatchObject({ status: 403, body: { code: 'workbenches_unavailable' } });
    });

    it('returns a one-time link on a stable host and stores only hashes', async () => {
      const first = (await mint()).body.data!;
      const second = (await mint()).body.data!;
      expect(first.origin).toMatch(new RegExp(`^https://[0-9a-f]{32}-5173\\.${DOMAIN.replace('.', '\\.')}$`));
      expect(second.origin).toBe(first.origin);
      expect(first.port).toBe(5173);
      const ticket = new URL(first.url).searchParams.get('ticket')!;
      expect(first.url).toBe(`${first.origin}/__talyn/auth?ticket=${ticket}`);
      expect(new URL(second.url).searchParams.get('ticket')).not.toBe(ticket);
      expect(Date.parse(first.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
      const rows = await testDb.db.select().from(workbenchPreviewTickets);
      expect(rows.map((r) => r.tokenHash)).toContain(hashPreviewToken(ticket));
      expect(JSON.stringify(rows)).not.toContain(ticket);
      const hosts = await testDb.db.select().from(workbenchPreviewHosts).where(eq(workbenchPreviewHosts.workbenchId, 'ready'));
      expect(hosts.filter((h) => h.port === 5173)).toHaveLength(1);
    });

    it('gives each port its own host', async () => {
      expect((await mint('ready', 3000)).body.data!.origin).not.toBe((await mint('ready', 5173)).body.data!.origin);
    });

    it('limits minting per user', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) statuses.push((await mint('ready', 5173, 'spammer')).status);
      expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
      expect(statuses[30]).toBe(429);
    });
  });

  describe('redeeming a ticket', () => {
    it('sets a host-only cookie and redirects home', async () => {
      const { cookie, res } = await signIn();
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
      expect(res.headers['cache-control']).toBe('no-store');
      const setCookie = res.headers['set-cookie']![0];
      expect(setCookie).toMatch(new RegExp(`^${PREVIEW_COOKIE}=[A-Za-z0-9_-]{43}; `));
      expect(setCookie).toContain('; Path=/;');
      expect(setCookie).toContain('; HttpOnly');
      expect(setCookie).toContain('; Secure');
      expect(setCookie).toContain('; SameSite=Lax');
      expect(setCookie.toLowerCase()).not.toContain('domain=');
      const stored = await testDb.db.select().from(workbenchPreviewSessions);
      expect(stored.map((s) => s.tokenHash)).toContain(hashPreviewToken(cookie.split('=')[1]));
      expect(JSON.stringify(stored)).not.toContain(cookie.split('=')[1]);
    });

    it('works once', async () => {
      const url = new URL((await mint()).body.data!.url);
      expect((await send(url.host, `${url.pathname}${url.search}`)).status).toBe(302);
      const again = await send(url.host, `${url.pathname}${url.search}`);
      expect(again.status).toBe(401);
      expect(again.headers['set-cookie']).toBeUndefined();
      expect(again.body).toContain('Open the preview from Talyn again.');
    });

    it('does nothing on another host and stays usable on its own', async () => {
      const url = new URL((await mint('ready', 5173)).body.data!.url);
      const otherHost = new URL((await mint('ready2', 5173)).body.data!.url).host;
      expect((await send(otherHost, `${url.pathname}${url.search}`)).status).toBe(401);
      expect((await send(url.host, `${url.pathname}${url.search}`)).status).toBe(302);
    });

    it('refuses an expired ticket', async () => {
      const url = new URL((await mint()).body.data!.url);
      const ticket = url.searchParams.get('ticket')!;
      await testDb.db.update(workbenchPreviewTickets).set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(workbenchPreviewTickets.tokenHash, hashPreviewToken(ticket)));
      expect((await send(url.host, `${url.pathname}${url.search}`)).status).toBe(401);
    });

    it.each(['', '?ticket=', '?ticket=short', `?ticket=${'a'.repeat(42)}!`])('refuses the ticket %j', async (search) => {
      const host = new URL((await mint()).body.data!.url).host;
      expect((await send(host, `/__talyn/auth${search}`)).status).toBe(401);
    });

    it('answers only GET', async () => {
      const url = new URL((await mint()).body.data!.url);
      expect((await send(url.host, `${url.pathname}${url.search}`, { method: 'POST' })).status).toBe(405);
      expect((await send(url.host, `${url.pathname}${url.search}`)).status).toBe(302);
    });
  });

  describe('a signed-in preview host', () => {
    it('forwards to the port with no Talyn credentials and the app cookies only', async () => {
      const { host, cookie } = await signIn();
      const res = await send(host, '/api/v1/marker?q=1', {
        headers: { cookie: `app=1; ${cookie}`, authorization: 'Bearer talyn-jwt', accept: 'text/html', 'x-user': 'owner' },
      });
      expect(res.status).toBe(200);
      expect(res.body).toBe('from the app');
      expect(proxyPort).toHaveBeenCalledTimes(1);
      const [sandboxId, previewPort, pathAndQuery, init] = proxyPort.mock.calls[0];
      expect([sandboxId, previewPort, pathAndQuery]).toEqual(['sb-ready', 5173, 'api/v1/marker?q=1']);
      expect(init.method).toBe('GET');
      expect(init.headers).toEqual({ accept: 'text/html', cookie: 'app=1' });
    });

    it('passes the app cookies back host-only and drops what must not reach the browser', async () => {
      const { host, cookie } = await signIn();
      const res = await send(host, '/', { headers: { cookie } });
      expect(res.headers['set-cookie']).toEqual(['sid=1; Path=/']);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['x-fleet-host']).toBeUndefined();
    });

    it('rewrites a redirect to the app on localhost', async () => {
      proxyPort.mockImplementation(async () => new Response(null, { status: 302, headers: { location: 'http://localhost:5173/login' } }));
      const { host, cookie } = await signIn();
      const res = await send(host, '/private', { headers: { cookie } });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    });

    it('forwards a request body', async () => {
      const { host, cookie } = await signIn();
      await send(host, '/form', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=2' });
      const init = proxyPort.mock.calls[0][3];
      expect(init.method).toBe('POST');
      expect(Buffer.from(init.body).toString()).toBe('a=1&b=2');
    });

    it.each([
      ['no cookie', () => ''],
      ['a made-up cookie', () => `${PREVIEW_COOKIE}=${'a'.repeat(43)}`],
      ['a malformed cookie', () => `${PREVIEW_COOKIE}=nope`],
    ])('refuses %s', async (_name, cookie) => {
      const { host } = await signIn();
      const res = await send(host, '/', { headers: cookie() ? { cookie: cookie() } : {} });
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Open the preview from Talyn again.');
      expect(proxyPort).not.toHaveBeenCalled();
    });

    it("refuses another host's cookie", async () => {
      const a = await signIn('ready', 5173);
      const b = await signIn('ready', 3000);
      expect((await send(b.host, '/', { headers: { cookie: a.cookie } })).status).toBe(401);
      expect((await send(b.host, '/', { headers: { cookie: `${a.cookie}; ${b.cookie}` } })).status).toBe(200);
    });

    it('refuses an expired cookie', async () => {
      const { host, cookie } = await signIn();
      await testDb.db.update(workbenchPreviewSessions).set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(workbenchPreviewSessions.tokenHash, hashPreviewToken(cookie.split('=')[1])));
      expect((await send(host, '/', { headers: { cookie } })).status).toBe(401);
    });

    it('stops within the cache window when the owner loses access', async () => {
      const { host, cookie } = await signIn();
      expect((await send(host, '/', { headers: { cookie } })).status).toBe(200);
      await testDb.db.update(workspaces).set({ ownerId: 'other' }).where(eq(workspaces.id, 'ws'));
      try {
        expect((await send(host, '/', { headers: { cookie } })).status).toBe(200);
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 21_000);
        expect((await send(host, '/', { headers: { cookie } })).status).toBe(401);
      } finally {
        await testDb.db.update(workspaces).set({ ownerId: 'owner' }).where(eq(workspaces.id, 'ws'));
      }
    });

    it('refuses an archived session', async () => {
      const { host, cookie } = await signIn('ready2');
      await updateWorkbench('ready2', { status: 'archived', archivedAt: new Date() });
      try {
        const res = await send(host, '/', { headers: { cookie } });
        expect(res.status).toBe(410);
        expect(proxyPort).not.toHaveBeenCalled();
      } finally {
        await updateWorkbench('ready2', { status: 'ready', archivedAt: null });
      }
    });

    it('says when the session is not ready, and does not keep that answer', async () => {
      const { host, cookie } = await signIn('ready2');
      await updateWorkbench('ready2', { status: 'moving' });
      try {
        expect((await send(host, '/', { headers: { cookie } })).status).toBe(503);
      } finally {
        await updateWorkbench('ready2', { status: 'ready' });
      }
      expect((await send(host, '/', { headers: { cookie } })).status).toBe(200);
    });

    it('checks the workbenches flag on each request', async () => {
      const { host, cookie } = await signIn();
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      resetPreviewAccessCacheForTests();
      expect((await send(host, '/', { headers: { cookie } })).status).toBe(403);
    });

    it.each(['/%2e%2e/exec', '/a/%2E%2E/%2e%2e/exec', '/a%5cb'])('refuses the path %s', async (path) => {
      const { host, cookie } = await signIn();
      expect((await send(host, path, { headers: { cookie } })).status).toBe(400);
      expect(proxyPort).not.toHaveBeenCalled();
    });

    it.each([
      ['a fetch from another preview', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, 'GET', 403],
      ['a form post from another site', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, 'POST', 403],
      ['a frame from another site', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }, 'GET', 403],
      ['a link from another site', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, 'GET', 200],
      ['a fetch from the page itself', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, 'POST', 200],
      ['a typed address', { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, 'GET', 200],
    ])('answers %s with %s', async (_name, headers, method, status) => {
      const { host, cookie } = await signIn();
      expect((await send(host, '/', { method, headers: { ...headers, cookie } })).status).toBe(status);
    });

    it('serves a 404 page for an unknown name under the preview domain', async () => {
      const res = await send(`foo.${DOMAIN}`, '/api/v1/marker');
      expect(res.status).toBe(404);
      expect(res.body).not.toContain('"api"');
    });

    it('leaves other hosts to the API', async () => {
      const res = await send('api.test', '/api/v1/marker');
      expect(JSON.parse(res.body)).toEqual({ api: true });
      expect((await send('api.test', '/__talyn/auth?ticket=x')).status).toBe(404);
      expect((await send(`${ID}-3000.${DOMAIN}.evil.com`, '/api/v1/marker')).body).toBe('{"api":true}');
      expect(proxyPort).not.toHaveBeenCalled();
    });

    it('serves nothing when PREVIEW_BASE_DOMAIN is unset', async () => {
      const { host } = await signIn();
      vi.stubEnv('PREVIEW_BASE_DOMAIN', '');
      expect(JSON.parse((await send(host, '/api/v1/marker')).body)).toEqual({ api: true });
    });
  });

  describe('a preview host socket', () => {
    function connect(host: string, headers: Record<string, string>) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/hmr?token=app`, 'vite-hmr', { headers: { host, ...headers } });
      return new Promise<{ ws: WebSocket } | { status: number }>((resolve) => {
        ws.once('open', () => resolve({ ws }));
        ws.once('unexpected-response', (_req, res) => { resolve({ status: res.statusCode ?? 0 }); res.resume(); });
        ws.once('error', () => resolve({ status: 0 }));
      });
    }

    it('relays frames with the cookie and the page origin', async () => {
      const { host, cookie } = await signIn();
      const result = await connect(host, { origin: `https://${host}`, cookie: `app=1; ${cookie}` });
      if (!('ws' in result)) throw new Error(`refused with ${result.status}`);
      expect(openPortWebSocket).toHaveBeenCalledWith('sb-ready', 5173, 'hmr?token=app', 'vite-hmr', { cookie: 'app=1' });
      result.ws.send('ping');
      await vi.waitFor(() => expect(upstream.sent.map((f) => f.data.toString())).toEqual(['ping']));
      const reply = new Promise<string>((resolve) => result.ws.once('message', (data) => resolve(data.toString())));
      upstream.emit('message', Buffer.from('pong'), false);
      expect(await reply).toBe('pong');
      result.ws.close();
    });

    it.each([
      ['another origin', { origin: 'https://evil.test' }],
      ['another preview origin', { origin: `https://${ID}-3000.${DOMAIN}` }],
      ['the plain http origin', { origin: 'http://HOST' }],
      ['no origin', {}],
    ])('refuses %s', async (_name, headers: Record<string, string>) => {
      const { host, cookie } = await signIn();
      const origin = headers.origin?.replace('HOST', host);
      expect(await connect(host, { ...(origin ? { origin } : {}), cookie })).toEqual({ status: 403 });
      expect(openPortWebSocket).not.toHaveBeenCalled();
    });

    it('refuses a socket with no cookie', async () => {
      const { host } = await signIn();
      expect(await connect(host, { origin: `https://${host}` })).toEqual({ status: 401 });
      expect(openPortWebSocket).not.toHaveBeenCalled();
    });

    it('refuses a socket for an archived session', async () => {
      const { host, cookie } = await signIn('ready2');
      await updateWorkbench('ready2', { status: 'archived', archivedAt: new Date() });
      try {
        expect(await connect(host, { origin: `https://${host}`, cookie })).toEqual({ status: 410 });
      } finally {
        await updateWorkbench('ready2', { status: 'ready', archivedAt: null });
      }
    });
  });
});
