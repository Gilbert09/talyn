import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  fleetAccounts,
  integrations as integrationsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';

/**
 * Two agents behind one provider. Since migration 0079 each credential is a
 * `fleet_accounts` row; the old single-credential save still works on top of
 * them (it writes the agent's first account).
 *
 * The write used to be WHOLE — the config was rebuilt from the patch and
 * everything else dropped — and that was deliberate: a workspace configured
 * before the fleet bearer and endpoint left the settings card still carries
 * `fleetTokenEnc`/`fleetEndpoint`, and carrying those forward would keep a dead
 * per-workspace endpoint alive as a silent routing override.
 *
 * A whole write cannot survive two independently connectable agents, though:
 * saving Codex would wipe Claude. So it merges by ENUMERATING the credential
 * fields rather than by spreading the stored object — the legacy keys are still
 * dropped, because nothing copies them, and each vendor survives a save of the
 * other. Both halves of that are load-bearing and both are pinned here.
 */
describe('fleet credential storage', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let priorKey: string | undefined;

  beforeAll(() => {
    priorKey = process.env.TALYN_TOKEN_KEY;
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
  });
  afterAll(() => {
    if (priorKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = priorKey;
  });

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID });
    await db
      .insert(workspacesTable)
      .values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
  });
  afterEach(async () => cleanup());

  /** `agent:kind` of every stored account, in priority order. */
  async function accounts(): Promise<string[]> {
    const rows = await db
      .select({ agent: fleetAccounts.agent, kind: fleetAccounts.kind })
      .from(fleetAccounts)
      .where(eq(fleetAccounts.workspaceId, 'ws1'))
      .orderBy(fleetAccounts.agent, fleetAccounts.priority);
    return rows.map((r) => `${r.agent}:${r.kind}`);
  }

  async function config(): Promise<Record<string, unknown>> {
    const rows = await db
      .select({ config: integrationsTable.config })
      .from(integrationsTable)
      .where(
        and(eq(integrationsTable.workspaceId, 'ws1'), eq(integrationsTable.type, 'selfhosted')),
      )
      .limit(1);
    return (rows[0]?.config as Record<string, unknown> | null) ?? {};
  }

  function codexFixture() {
    return {
      accessTokenEnc: { v: 1 } as never,
      refreshTokenEnc: { v: 1 } as never,
      accountId: 'acct-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  }

  it('saving Codex keeps the Claude credential, and the reverse', async () => {
    const { storeSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');

    await storeSelfHostedCredentials('ws1', { claudeToken: 'sk-ant-oat01-mine' });
    expect(await accounts()).toEqual(['claude:anthropic_key']);

    await storeSelfHostedCredentials('ws1', { codex: codexFixture() });
    expect(await accounts()).toEqual(['claude:anthropic_key', 'codex:codex_oauth']);

    // A second save REPLACES the account of that kind rather than adding one.
    await storeSelfHostedCredentials('ws1', { claudeToken: 'sk-ant-oat01-rotated' });
    expect(await accounts()).toEqual(['claude:anthropic_key', 'codex:codex_oauth']);
  });

  // Before 0079 a pasted key sat BESIDE a sign-in and the sign-in won. The
  // compat save keeps both, sign-in first, whichever order they arrive in.
  it.each([
    ['sign-in first', true],
    ['key first', false],
  ])('a Claude key and a Claude sign-in are both kept (%s)', async (_name, signInFirst) => {
    const { storeSelfHostedCredentials, patchSelfHostedConfig, getSelfHostedCredentials } =
      await import('../services/selfHosted/credentials.js');
    const { encryptString } = await import('../services/tokenCrypto.js');
    const signIn = () =>
      patchSelfHostedConfig('ws1', {
        claudeOAuth: {
          accessTokenEnc: encryptString('sk-ant-oat01-signed-in'),
          refreshTokenEnc: encryptString('rt'),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
    const paste = () => storeSelfHostedCredentials('ws1', { claudeToken: 'sk-ant-api-pasted' });
    if (signInFirst) {
      await signIn();
      await paste();
    } else {
      await paste();
      await signIn();
    }
    expect(await accounts()).toEqual(['claude:claude_oauth', 'claude:anthropic_key']);
    expect((await getSelfHostedCredentials('ws1'))?.claudeToken).toBe('sk-ant-oat01-signed-in');
  });

  // The provider sends `openaiKey: null` beside a new Codex sign-in: that is
  // how the old config replaced a key with a subscription, and it still does.
  it('a Codex sign-in sent with openaiKey: null replaces the key', async () => {
    const { storeSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
    await storeSelfHostedCredentials('ws1', { openaiKey: 'sk-openai' });
    await storeSelfHostedCredentials('ws1', { codex: codexFixture(), openaiKey: null });
    expect(await accounts()).toEqual(['codex:codex_oauth']);
    await storeSelfHostedCredentials('ws1', { openaiKey: 'sk-openai-2' });
    expect(await accounts()).toEqual(['codex:codex_oauth', 'codex:openai_key']);
  });

  it('clearing one vendor leaves the other alone', async () => {
    const { storeSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
    await storeSelfHostedCredentials('ws1', {
      claudeToken: 'sk-ant-oat01-mine',
      codex: codexFixture(),
    });

    await storeSelfHostedCredentials('ws1', { codex: null, openaiKey: null });
    expect(await accounts()).toEqual(['claude:anthropic_key']);

    await storeSelfHostedCredentials('ws1', { claudeToken: null });
    expect(await accounts()).toEqual([]);
  });

  it('a clear removes EVERY account of that agent, not only the first', async () => {
    const { storeSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
    const { addFleetAccount } = await import('../services/selfHosted/accounts.js');
    const { encryptString } = await import('../services/tokenCrypto.js');
    await storeSelfHostedCredentials('ws1', { claudeToken: 'sk-ant-api-one' });
    await addFleetAccount('ws1', {
      kind: 'anthropic_key',
      credential: { keyEnc: encryptString('sk-ant-api-two') },
    });

    await storeSelfHostedCredentials('ws1', { claudeToken: null });
    expect(await accounts()).toEqual([]);
  });

  // The legacy keys stay on old rows, and a removed account must not come back
  // from them on the next read.
  it('a cleared agent is not adopted back from its legacy config keys', async () => {
    const { storeSelfHostedCredentials, getSelfHostedCredentials } = await import(
      '../services/selfHosted/credentials.js'
    );
    const { encryptString } = await import('../services/tokenCrypto.js');
    await db.insert(integrationsTable).values({
      id: 'int-legacy',
      workspaceId: 'ws1',
      type: 'selfhosted',
      enabled: true,
      config: { anthropicKeyEnc: encryptString('sk-ant-api-legacy') },
    });
    expect((await getSelfHostedCredentials('ws1'))?.claudeToken).toBe('sk-ant-api-legacy');

    await storeSelfHostedCredentials('ws1', { claudeToken: null });
    expect(await getSelfHostedCredentials('ws1')).toBeNull();
    expect(await config()).not.toHaveProperty('anthropicKeyEnc');
  });

  // The reason the merge enumerates instead of spreading.
  it('still drops the legacy per-workspace bearer and endpoint', async () => {
    const { storeSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
    await db.insert(integrationsTable).values({
      id: 'int-legacy',
      workspaceId: 'ws1',
      type: 'selfhosted',
      enabled: true,
      config: { fleetTokenEnc: { v: 1 }, fleetEndpoint: 'http://an-old-box:8080' },
    });

    await storeSelfHostedCredentials('ws1', { claudeToken: 'sk-ant-oat01-mine' });
    const after = await config();
    expect(after).not.toHaveProperty('fleetTokenEnc');
    expect(after).not.toHaveProperty('fleetEndpoint');
    expect(await accounts()).toEqual(['claude:anthropic_key']);
  });

  /**
   * The gate that moved. It used to be the Claude token specifically, because
   * every fleet model was Anthropic's — so a Codex-only workspace read as "the
   * fleet is not configured" and was sent back to a form it had already filled
   * in.
   */
  it('counts a Codex-only workspace as configured', async () => {
    const { storeSelfHostedCredentials, getSelfHostedCredentials } = await import(
      '../services/selfHosted/credentials.js'
    );
    const { codexCredentialFrom } = await import('../services/selfHosted/codexOauth.js');

    // A real (unsigned) JWT carrying the one claim the Codex backend needs.
    const claims = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' } }),
    ).toString('base64url');
    const jwt = `h.${claims}.s`;

    await storeSelfHostedCredentials('ws1', {
      codex: codexCredentialFrom({ accessToken: jwt, refreshToken: 'rt', expiresIn: 3600 }),
    });

    const creds = await getSelfHostedCredentials('ws1');
    expect(creds).not.toBeNull();
    expect(creds?.openaiKey).toBe(jwt);
    expect(creds?.claudeToken).toBeUndefined();
  });

  it('is null only when the workspace holds neither vendor', async () => {
    const { getSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
    expect(await getSelfHostedCredentials('ws1')).toBeNull();
  });

  // The account id is a claim inside the token, and the Codex backend wants it
  // as a SECOND header. A token without one is a 401 from chatgpt.com naming
  // nothing, so it is refused at connect time instead.
  it('refuses a Codex token carrying no ChatGPT account id', async () => {
    const { codexCredentialFrom } = await import('../services/selfHosted/codexOauth.js');
    expect(() =>
      codexCredentialFrom({ accessToken: 'not-a-jwt', refreshToken: 'rt' }),
    ).toThrow(/account id/i);
  });
});
