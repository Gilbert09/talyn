import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable, integrations as integrationsTable } from '../db/schema.js';

/**
 * What happens when a fleet subscription's grant DIES — revoked at the vendor,
 * or a refresh token that will never be renewed again.
 *
 * `reauthRequiredAt` existed on both agents, was consumed by `fleetAgentStatus`
 * to drive the "Reconnect needed" badge, and had tests. The tests called the
 * writer DIRECTLY, which is why nothing noticed that no production path ever
 * did. The flag was read in four places and written in none, so:
 *
 *  - Settings kept saying "Connected" for a revoked subscription; the badge was
 *    unreachable.
 *  - The `if (reauthRequiredAt) stop` short-circuit was unreachable, so every
 *    dispatch re-attempted the same dead refresh token against the vendor. For
 *    a Loop that is once per firing, until the circuit breaker disabled it as
 *    `too_many_failures` — a message that names the symptom and hides the cause.
 *  - `hasCredentials` threw, and it is what `GET /cloud-providers` calls for
 *    every provider, so the whole listing 500'd. That listing draws the
 *    Settings cards, the default-agent menu and the per-task agent picker: a
 *    dead grant blanked the one screen with the fix on it.
 *
 * So these assert the CHAIN — vendor rejects, flag lands, status reports it,
 * listing survives — rather than any one function in isolation.
 */

const fetchWithTimeout = vi.hoisted(() => vi.fn());
vi.mock('../services/httpTimeout.js', () => ({ fetchWithTimeout }));

const REJECTED = {
  ok: false,
  status: 400,
  bodyText: JSON.stringify({ error: 'invalid_grant', error_description: 'revoked' }),
};
const TRANSIENT = { ok: false, status: 503, bodyText: 'upstream is having a moment' };

describe('a revoked fleet subscription records itself', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const savedKey = process.env.TALYN_TOKEN_KEY;

  // A workspace id unique to each test. Both oauth modules keep a module-level
  // in-flight promise map keyed by workspace, and module state outlives the
  // per-test database — a shared 'ws1' let one test's refresh satisfy the next
  // one's, which showed up as "no vendor call was made".
  let ws = 'ws';
  let n = 0;

  async function seed(agent: 'claude' | 'codex') {
    const { encryptString } = await import('../services/tokenCrypto.js');
    const credential = {
      accessTokenEnc: encryptString('at'),
      refreshTokenEnc: encryptString('rt'),
      // Already past expiry, so any use is forced through a refresh.
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      ...(agent === 'codex' ? { accountId: 'acct_1' } : {}),
    };
    await db.insert(integrationsTable).values({
      id: `int-${agent}`,
      workspaceId: ws,
      type: 'selfhosted',
      enabled: true,
      config: {
        fleetTokenEnc: encryptString('fleet-token'),
        fleetEndpoint: 'https://fleet.example',
        [agent === 'claude' ? 'claudeOAuth' : 'codexOAuth']: credential,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function storedFlag(agent: 'claude' | 'codex'): Promise<string | undefined> {
    const rows = await db
      .select({ config: integrationsTable.config })
      .from(integrationsTable)
      .where(
        and(eq(integrationsTable.workspaceId, ws), eq(integrationsTable.type, 'selfhosted')),
      );
    const cfg = rows[0]?.config as Record<string, { reauthRequiredAt?: string } | undefined>;
    return cfg?.[agent === 'claude' ? 'claudeOAuth' : 'codexOAuth']?.reauthRequiredAt;
  }

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = Buffer.alloc(32, 3).toString('base64');
    fetchWithTimeout.mockReset();
    ws = `ws-${++n}`;
    ({ db, cleanup } = await createTestDb());
    await seedUser(db);
    await db.insert(workspacesTable).values({
      id: ws,
      ownerId: TEST_USER_ID,
      name: 'ws1',
      settings: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(async () => {
    await cleanup();
    if (savedKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = savedKey;
  });

  it.each(['claude', 'codex'] as const)(
    '%s: a rejected grant lands on the row and shows up as needing reauth',
    async (agent) => {
      await seed(agent);
      fetchWithTimeout.mockResolvedValue(REJECTED);

      const { selfHostedProvider } = await import(
        '../services/cloudProviders/selfhosted/provider.js'
      );
      // The listing must SURVIVE. Before, this threw and took `/cloud-providers`
      // down with it — the screen carrying the reconnect button.
      await expect(selfHostedProvider.hasCredentials(ws)).resolves.toBe(true);

      expect(await storedFlag(agent)).toBeDefined();

      const { fleetAgentStatus } = await import('../services/selfHosted/credentials.js');
      const status = await fleetAgentStatus(ws);
      // Connected AND needing reauth — two different states. Dropping it from
      // `connectedAgents` would tell the user they never set it up.
      expect(status.connectedAgents).toContain(agent);
      expect(status.reauthAgents).toContain(agent);
    },
  );

  it.each(['claude', 'codex'] as const)(
    '%s: stops retrying the dead grant once it is recorded',
    async (agent) => {
      await seed(agent);
      fetchWithTimeout.mockResolvedValue(REJECTED);
      const { selfHostedProvider } = await import(
        '../services/cloudProviders/selfhosted/provider.js'
      );

      await selfHostedProvider.hasCredentials(ws);
      const afterFirst = fetchWithTimeout.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);

      await selfHostedProvider.hasCredentials(ws);
      await selfHostedProvider.hasCredentials(ws);
      // The whole point of recording it: the vendor is not asked again. A Loop
      // firing hourly against a revoked subscription used to re-attempt on
      // every single firing.
      expect(fetchWithTimeout.mock.calls.length).toBe(afterFirst);
    },
  );

  it.each(['claude', 'codex'] as const)(
    '%s: a TRANSIENT failure does not demand a sign-in nobody needs',
    async (agent) => {
      await seed(agent);
      fetchWithTimeout.mockResolvedValue(TRANSIENT);
      const { selfHostedProvider } = await import(
        '../services/cloudProviders/selfhosted/provider.js'
      );

      await selfHostedProvider.hasCredentials(ws).catch(() => undefined);
      // Marking a live subscription as revoked because the vendor had a bad
      // minute would stop every run and demand a reconnection that fixes
      // nothing. Only an explicit rejection counts.
      expect(await storedFlag(agent)).toBeUndefined();
    },
  );
});
