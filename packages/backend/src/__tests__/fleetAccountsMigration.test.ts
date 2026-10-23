import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { asc, eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  fleetAccounts,
  integrations as integrationsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';

/**
 * Migration 0079's backfill of `fleet_accounts` from `integrations.config`.
 *
 * The migration has already run by the time a test DB exists, on an empty
 * table. So this seeds rows in the OLD shape and re-runs the migration's own
 * INSERT, read out of the file, so the SQL under test is the SQL that ships.
 * A backfill runs once, in production, with no second chance.
 */

const MIGRATION = path.resolve(__dirname, '../db/migrations/0079_fleet_accounts.sql');

function backfillStatement(): string {
  const statements = fs
    .readFileSync(MIGRATION, 'utf-8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim());
  const insert = statements.find((s) => s.includes('INSERT INTO "fleet_accounts"'));
  if (!insert) throw new Error('0079 has no backfill INSERT');
  return insert;
}

const envelope = (tag: string) => ({ v: 1, iv: `iv-${tag}`, tag: `t-${tag}`, data: `d-${tag}` });
const HOLD = { at: '2026-10-21T09:00:00.000Z', detail: "You're out of extra usage." };
const REAUTH = '2026-10-20T08:00:00.000Z';

describe('migration 0079 — fleet_accounts backfill', () => {
  let db: Database;
  let pglite: PGlite;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, pglite, cleanup } = await createTestDb());
    await seedUser(db);
  });
  afterEach(async () => cleanup());

  async function workspace(id: string, config?: Record<string, unknown>, type = 'selfhosted') {
    await db.insert(workspacesTable).values({ id, ownerId: TEST_USER_ID, name: id });
    if (config) {
      await db.insert(integrationsTable).values({
        id: `int-${id}`,
        workspaceId: id,
        type,
        enabled: true,
        config,
      });
    }
  }

  async function accountsOf(workspaceId: string) {
    return db
      .select({
        id: fleetAccounts.id,
        agent: fleetAccounts.agent,
        kind: fleetAccounts.kind,
        label: fleetAccounts.label,
        priority: fleetAccounts.priority,
        credential: fleetAccounts.credential,
        reauthRequiredAt: fleetAccounts.reauthRequiredAt,
        quotaExhausted: fleetAccounts.quotaExhausted,
      })
      .from(fleetAccounts)
      .where(eq(fleetAccounts.workspaceId, workspaceId))
      .orderBy(asc(fleetAccounts.agent), asc(fleetAccounts.priority));
  }

  it('turns every old credential into an account, subscription first', async () => {
    await workspace('ws-full', {
      claudeOAuth: {
        accessTokenEnc: envelope('cat'),
        refreshTokenEnc: envelope('crt'),
        expiresAt: '2026-10-21T10:00:00.000Z',
        reauthRequiredAt: REAUTH,
      },
      anthropicKeyEnc: envelope('ak'),
      codexOAuth: {
        accessTokenEnc: envelope('xat'),
        refreshTokenEnc: envelope('xrt'),
        accountId: 'chatgpt-acct',
        expiresAt: '2026-10-21T10:00:00.000Z',
      },
      openaiKeyEnc: envelope('ok'),
      quotaExhausted: { claude: HOLD },
      claudePendingAuth: { state: 's', codeVerifierEnc: envelope('v'), expiresAt: REAUTH },
    });

    await pglite.exec(backfillStatement());
    const rows = await accountsOf('ws-full');

    expect(rows.map((r) => [r.agent, r.kind, r.priority, r.label])).toEqual([
      ['claude', 'claude_oauth', 1, 'Claude subscription'],
      ['claude', 'anthropic_key', 2, 'Anthropic API key'],
      ['codex', 'codex_oauth', 1, 'ChatGPT subscription'],
      ['codex', 'openai_key', 2, 'OpenAI API key'],
    ]);

    const [claudeOauth, anthropicKey, codexOauth, openaiKey] = rows;
    // The reauth flag moves to its column and leaves the credential.
    expect(claudeOauth!.reauthRequiredAt?.toISOString()).toBe(REAUTH);
    expect(claudeOauth!.credential).toEqual({
      accessTokenEnc: envelope('cat'),
      refreshTokenEnc: envelope('crt'),
      expiresAt: '2026-10-21T10:00:00.000Z',
    });
    expect(anthropicKey!.credential).toEqual({ keyEnc: envelope('ak') });
    expect(anthropicKey!.reauthRequiredAt).toBeNull();
    expect(codexOauth!.credential).toMatchObject({ accountId: 'chatgpt-acct' });
    expect(openaiKey!.credential).toEqual({ keyEnc: envelope('ok') });

    // The agent-wide hold lands on EVERY account of that agent, so the agent
    // stays held exactly as it was. Codex had none.
    expect(claudeOauth!.quotaExhausted).toEqual(HOLD);
    expect(anthropicKey!.quotaExhausted).toEqual(HOLD);
    expect(codexOauth!.quotaExhausted).toBeNull();
    expect(openaiKey!.quotaExhausted).toBeNull();

    // The legacy keys stay: an old instance in the deploy overlap still reads them.
    const [integration] = await db
      .select({ config: integrationsTable.config })
      .from(integrationsTable)
      .where(eq(integrationsTable.workspaceId, 'ws-full'));
    expect(integration!.config).toHaveProperty('claudeOAuth');
    expect(integration!.config).toHaveProperty('openaiKeyEnc');
  });

  it.each([
    ['a pasted Claude key alone', { anthropicKeyEnc: envelope('ak') }, [['claude', 'anthropic_key', 1]]],
    ['a pasted OpenAI key alone', { openaiKeyEnc: envelope('ok') }, [['codex', 'openai_key', 1]]],
    [
      'a Codex sign-in alone',
      {
        codexOAuth: {
          accessTokenEnc: envelope('x'),
          refreshTokenEnc: envelope('y'),
          accountId: 'a',
          expiresAt: REAUTH,
        },
      },
      [['codex', 'codex_oauth', 1]],
    ],
    ['only the dead fleet bearer and endpoint', { fleetTokenEnc: envelope('f'), fleetEndpoint: 'http://x' }, []],
    ['an empty config', {}, []],
    ['a null credential key', { anthropicKeyEnc: null }, []],
  ])('%s', async (_name, config, expected) => {
    await workspace('ws-one', config as Record<string, unknown>);
    await pglite.exec(backfillStatement());
    const rows = await accountsOf('ws-one');
    expect(rows.map((r) => [r.agent, r.kind, r.priority])).toEqual(expected);
  });

  it('gives a workspace with no selfhosted row nothing', async () => {
    await workspace('ws-none');
    await workspace('ws-other', { anthropicKeyEnc: envelope('ak') }, 'posthog_code');
    await pglite.exec(backfillStatement());
    expect(await accountsOf('ws-none')).toEqual([]);
    expect(await accountsOf('ws-other')).toEqual([]);
  });

  it('is idempotent, and leaves an agent that already has accounts alone', async () => {
    await workspace('ws-again', { anthropicKeyEnc: envelope('ak'), openaiKeyEnc: envelope('ok') });
    await pglite.exec(backfillStatement());
    await pglite.exec(backfillStatement());
    expect(await accountsOf('ws-again')).toHaveLength(2);

    // An agent with accounts already is never backfilled again, even when the
    // config grows a key it did not have.
    await db
      .update(integrationsTable)
      .set({
        config: {
          anthropicKeyEnc: envelope('ak'),
          openaiKeyEnc: envelope('ok'),
          claudeOAuth: { accessTokenEnc: envelope('c'), refreshTokenEnc: envelope('r'), expiresAt: REAUTH },
        },
      })
      .where(eq(integrationsTable.workspaceId, 'ws-again'));
    await pglite.exec(backfillStatement());
    expect((await accountsOf('ws-again')).map((r) => r.kind)).toEqual([
      'anthropic_key',
      'openai_key',
    ]);
  });

  /**
   * The backend runs the same insert at read time, for a key an old instance
   * wrote during the deploy overlap. Both must produce the same rows, ids
   * included, or the two could insert one credential twice.
   */
  it('matches what the backend adopts at read time', async () => {
    const config = {
      claudeOAuth: {
        accessTokenEnc: envelope('cat'),
        refreshTokenEnc: envelope('crt'),
        expiresAt: '2026-10-21T10:00:00.000Z',
        reauthRequiredAt: REAUTH,
      },
      anthropicKeyEnc: envelope('ak'),
      openaiKeyEnc: envelope('ok'),
      quotaExhausted: { codex: HOLD },
    };
    await workspace('ws-migrated', config);
    await workspace('ws-adopted', config);

    // Only the first workspace sees the migration's statement.
    await pglite.exec(backfillStatement().replace(
      'WHERE NOT EXISTS (',
      `WHERE s.workspace_id = 'ws-migrated' AND NOT EXISTS (`,
    ));
    const { listFleetAccounts, legacyAccountId } = await import(
      '../services/selfHosted/accounts.js'
    );
    await listFleetAccounts('ws-adopted');

    const strip = (rows: Awaited<ReturnType<typeof accountsOf>>) =>
      rows.map(({ id: _id, ...rest }) => rest);
    const migrated = await accountsOf('ws-migrated');
    const adopted = await accountsOf('ws-adopted');
    expect(strip(adopted)).toEqual(strip(migrated));
    expect(adopted.map((r) => r.id)).toEqual(
      adopted.map((r) => legacyAccountId('ws-adopted', r.kind as never)),
    );
    expect(migrated.map((r) => r.id)).toEqual(
      migrated.map((r) => legacyAccountId('ws-migrated', r.kind as never)),
    );
  });
});
