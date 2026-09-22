// Proving an exhaustion before acting on it.
//
// 2026-09-21: Anthropic refused every fleet run for a day with "You're out of
// extra usage. Add more at claude.ai/settings/usage", and the same stored
// credential answered HTTP 200 to a one-token request at the same minute —
// from a laptop, from the fleet host, and through the fleet harness's own
// request builder. Talyn believed the sentence, parked Claude, moved a day of
// work onto Codex and told the user to go and buy usage they already had.
//
// So the vendor gets asked. These tests are about what each answer does, and
// the asymmetry that matters: a confirmed refusal parks the agent, an
// unconfirmed one moves the work WITHOUT parking it, and "we could not tell"
// behaves exactly as it did before any of this existed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  integrations as integrationsTable,
} from '../db/schema.js';

const { noteExhaustedAgent } = await import('../services/selfHosted/exhaustedQuota.js');
const { verifyAgentQuota } = await import('../services/selfHosted/quotaProbe.js');

/** The 400 the fleet's runs actually died with, as Anthropic sends it. */
const EXHAUSTED_BODY = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
  },
});

/** What the vendor answers the probe. */
function vendorAnswers(res: Response | Error): ReturnType<typeof vi.spyOn> {
  const spy = vi.spyOn(globalThis, 'fetch');
  if (res instanceof Error) spy.mockRejectedValue(res);
  else spy.mockResolvedValue(res);
  return spy as ReturnType<typeof vi.spyOn>;
}

describe('verifying an exhaustion with the vendor', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let priorTokenKey: string | undefined;

  beforeEach(async () => {
    priorTokenKey = process.env.TALYN_TOKEN_KEY;
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    ({ db, cleanup } = await createTestDb());
    const { encryptString } = await import('../services/tokenCrypto.js');
    await seedUser(db, { id: TEST_USER_ID });
    await db
      .insert(workspacesTable)
      .values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    await db.insert(integrationsTable).values({
      id: 'int1',
      workspaceId: 'ws1',
      type: 'selfhosted',
      enabled: true,
      config: { anthropicKeyEnc: encryptString('sk-ant-api-test') },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
    if (priorTokenKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = priorTokenKey;
  });

  async function storedHold(): Promise<unknown> {
    const [row] = await db
      .select({ config: integrationsTable.config })
      .from(integrationsTable)
      .where(eq(integrationsTable.workspaceId, 'ws1'))
      .limit(1);
    return (row!.config as { quotaExhausted?: Record<string, unknown> }).quotaExhausted ?? null;
  }

  it('asks the vendor with a request it will actually serve', async () => {
    // Anthropic's OAuth path serves its own client: a request without Claude
    // Code's identity is refused on an account with quota to spare, which
    // would make every probe read as a refusal.
    const spy = vendorAnswers(new Response('{}', { status: 200 }));
    await verifyAgentQuota('ws1', 'claude');

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20');
    expect(headers['anthropic-beta']).toContain('claude-code-20250219');
    expect(String(init.body)).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
    // One token in, one out — the cheapest question that settles it.
    expect(JSON.parse(String(init.body)).max_tokens).toBe(1);
  });

  it.each([
    ['the vendor serves the probe', new Response('{}', { status: 200 }), 'available'],
    ['the vendor repeats the refusal', new Response(EXHAUSTED_BODY, { status: 400 }), 'spent'],
    ['the credential is rejected', new Response('{}', { status: 401 }), 'unknown'],
    ['the vendor rate-limits the probe', new Response('{}', { status: 429 }), 'unknown'],
    ['the vendor is unreachable', new Error('ECONNRESET'), 'unknown'],
  ])('%s → %s', async (_label, answer, verdict) => {
    vendorAnswers(answer);
    expect(await verifyAgentQuota('ws1', 'claude')).toBe(verdict);
  });

  it('answers unknown for Codex rather than guessing', async () => {
    // Codex on the fleet runs through OpenAI's Codex backend, which wants an
    // account id parsed out of the token and a request shape we would have to
    // keep in step with OpenAI's own client. Until that exists, Codex behaves
    // exactly as it did before.
    const spy = vendorAnswers(new Response('{}', { status: 200 }));
    expect(await verifyAgentQuota('ws1', 'codex')).toBe('unknown');
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers unknown when there is no credential to probe with', async () => {
    await db.delete(integrationsTable).where(eq(integrationsTable.workspaceId, 'ws1'));
    expect(await verifyAgentQuota('ws1', 'claude')).toBe('unknown');
  });

  describe('what the hold does with each answer', () => {
    it('writes the hold when the vendor stands behind the refusal', async () => {
      vendorAnswers(new Response(EXHAUSTED_BODY, { status: 400 }));
      expect(await noteExhaustedAgent('ws1', 'claude', "You're out of extra usage.")).toBe(true);
      expect(await storedHold()).toMatchObject({ claude: { at: expect.any(String) } });
    });

    it('writes NOTHING when the vendor serves the same credential', async () => {
      // The 2026-09-21 case. A hold here parks the agent for every later task,
      // moves the work to a vendor the user did not choose, and sends them to a
      // billing page over a subscription that is fine.
      vendorAnswers(new Response('{}', { status: 200 }));
      expect(await noteExhaustedAgent('ws1', 'claude', "You're out of extra usage.")).toBe(false);
      expect(await storedHold()).toBeNull();
    });

    it.each([
      ['unreachable', new Error('ECONNRESET')],
      ['unreadable', new Response('{}', { status: 500 })],
    ])('still writes the hold when the vendor is %s', async (_label, answer) => {
      // Being unsure must not be more decisive than being told — in either
      // direction. An unknown answer leaves the old behaviour exactly as it was.
      vendorAnswers(answer);
      expect(await noteExhaustedAgent('ws1', 'claude', "You're out of extra usage.")).toBe(true);
      expect(await storedHold()).toMatchObject({ claude: {} });
    });

    it('still writes the hold for an agent it cannot probe', async () => {
      vendorAnswers(new Response('{}', { status: 200 }));
      expect(await noteExhaustedAgent('ws1', 'codex', 'insufficient_quota')).toBe(true);
      expect(await storedHold()).toMatchObject({ codex: {} });
    });
  });
});
