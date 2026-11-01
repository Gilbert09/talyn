import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workbenches, workspaces } from '../db/schema.js';

const { addFleetAccount } = await import('../services/selfHosted/accounts.js');
const { encryptString } = await import('../services/tokenCrypto.js');
const { setSessionAccount } = await import('../services/workbenches/sandboxRuntime.js');
const { getWorkbench } = await import('../services/workbenches/store.js');
const { WorkbenchError } = await import('../services/workbenches/errors.js');

describe('setSessionAccount', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner' });
    for (const id of ['ws', 'ws2']) {
      await testDb.db.insert(workspaces).values({ id, ownerId: 'owner', name: id });
    }
    await testDb.db.insert(repositories).values({
      id: 'repo', workspaceId: 'ws', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main',
    });
    await testDb.db.insert(workbenches).values({
      id: 'wb', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'acme/app', name: 'wb',
      branch: 'tom/test', baseBranch: 'main', runtime: 'sandbox', agent: 'claude',
      sandboxId: 'talyn-wb-test', sandboxState: 'running', status: 'ready', settings: { autoCreatePr: false },
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await testDb.cleanup();
  });

  const add = (workspaceId: string, agent: 'claude' | 'codex', label: string) =>
    addFleetAccount(workspaceId, {
      kind: agent === 'claude' ? 'anthropic_key' : 'openai_key',
      label,
      credential: { keyEnc: encryptString(`token-${label}`) },
    });

  it('records the account and keeps the other settings', async () => {
    const account = await add('ws', 'claude', 'Teams');
    await setSessionAccount((await getWorkbench('wb'))!, account.id);
    expect((await getWorkbench('wb'))?.settings).toMatchObject({ autoCreatePr: false, fleetAccountId: account.id });
  });

  it.each([
    ['an account of the other agent', 'ws', 'codex', 'account_wrong_agent'],
    ['an account of another workspace', 'ws2', 'claude', 'account_not_found'],
  ] as const)('refuses %s', async (_name, workspaceId, agent, code) => {
    const account = await add(workspaceId, agent, 'Other');
    await expect(setSessionAccount((await getWorkbench('wb'))!, account.id)).rejects.toMatchObject({ code });
    expect((await getWorkbench('wb'))?.settings).not.toHaveProperty('fleetAccountId');
  });

  it('refuses an account that does not exist', async () => {
    await expect(setSessionAccount((await getWorkbench('wb'))!, 'nope')).rejects.toBeInstanceOf(WorkbenchError);
  });

  it('refuses a local session', async () => {
    const account = await add('ws', 'claude', 'Teams');
    const row = { ...(await getWorkbench('wb'))!, runtime: 'local' as const };
    await expect(setSessionAccount(row, account.id)).rejects.toMatchObject({ code: 'local_runtime' });
  });
});
