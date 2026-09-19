import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { validateMcpServer } from '@talyn/shared';
import { createTestDb } from './helpers/testDb.js';
import { mcpServers, users, workspaces } from '../db/schema.js';
import {
  createMcpServer,
  getMcpServer,
  listMcpServers,
  mcpOAuthStore,
  updateMcpServer,
} from '../services/mcpServers/store.js';
import { encryptString } from '../services/tokenCrypto.js';
import type { Database } from '../db/client.js';

let db: Database;
let cleanup: () => Promise<void>;
let id: string;
const input = {
  name: 'test',
  url: 'https://mcp.example.com/mcp',
  authKind: 'bearer',
  enabled: true,
};
beforeEach(async () => {
  process.env.TALYN_TOKEN_KEY = Buffer.alloc(32, 8).toString('base64');
  ({ db, cleanup } = await createTestDb());
  await db.insert(users).values({ id: 'owner-1', email: 'owner@example.com' });
  await db.insert(workspaces).values({ id: 'ws-1', name: 'Workspace', ownerId: 'owner-1' });
  id = (await createMcpServer('ws-1', validateMcpServer({ ...input, secret: 'api-key' }))).id;
  await mcpOAuthStore.write(id, {
    status: 'connected',
    clientId: 'public-client-id',
    accessTokenEnc: encryptString('access-token'),
    refreshTokenEnc: encryptString('refresh-token'),
    clientSecretEnc: encryptString('client-secret'),
    flow: { id: 'flow', stateHash: 'hash', verifier: 'private-verifier', expiresAt: 'later' },
  });
});
afterEach(async () => {
  await cleanup();
});

describe('stored MCP authentication', () => {
  it('keeps private OAuth material out of read responses', async () => {
    const single = await getMcpServer(id);
    const list = await listMcpServers('ws-1');
    expect(single?.hasSecret).toBe(true);
    for (const result of [single, list]) {
      const json = JSON.stringify(result);
      for (const field of [
        'accessTokenEnc',
        'refreshTokenEnc',
        'clientSecretEnc',
        'stateHash',
        'verifier',
        'private-verifier',
        'secretEnc',
      ])
        expect(json).not.toContain(field);
    }
    expect(single?.oauth).toEqual({ status: 'connected', clientId: 'public-client-id' });
  });

  it('preserves credentials when only the name changes', async () => {
    await updateMcpServer(id, validateMcpServer({ ...input, name: 'renamed' }));
    expect((await getMcpServer(id))?.hasSecret).toBe(true);
    expect((await mcpOAuthStore.read(id))?.accessTokenEnc).toBeTruthy();
  });

  it.each([
    { url: 'https://other.example.com/mcp' },
    { authKind: 'none' },
    { inject: { extra: { 'X-Workspace': 'another' } } },
  ])('clears old credentials when the destination changes: %j', async (patch) => {
    await updateMcpServer(id, validateMcpServer({ ...input, ...patch }));
    expect((await getMcpServer(id))?.hasSecret).toBe(false);
    expect(await mcpOAuthStore.read(id)).toBeNull();
  });

  it.each(['replacement', ''])('clears OAuth when a manual key is supplied: %s', async (secret) => {
    await updateMcpServer(id, validateMcpServer({ ...input, secret }));
    expect(await mcpOAuthStore.read(id)).toBeNull();
    expect((await getMcpServer(id))?.hasSecret).toBe(secret !== '');
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
    expect(JSON.stringify(row.secretEnc)).not.toContain('replacement');
  });
});
