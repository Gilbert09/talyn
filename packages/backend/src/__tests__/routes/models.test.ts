import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import {
  BUNDLED_FLEET_MODELS,
  bundledFleetModelCatalog,
  parseFleetModelCatalog,
  type FleetModelCatalog,
} from '@talyn/shared';
import { modelRoutes } from '../../routes/models.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import { _resetWithdrawnModels, noteWithdrawnModel } from '../../services/selfHosted/withdrawnModels.js';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  // No ownerScope: the route is mounted before it in production too.
  app.use('/api/v1/models', requireAuth, modelRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('routes/models', () => {
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;

  const get = async (authed = true) =>
    fetch(`${serverUrl}/api/v1/models`, { headers: authed ? internalProxyHeaders(TEST_USER_ID) : {} });
  const catalog = async () => ((await (await get()).json()) as { data: FleetModelCatalog }).data;

  beforeEach(async () => {
    const testDb = await createTestDb();
    cleanup = testDb.cleanup;
    await seedUser(testDb.db, { id: TEST_USER_ID });
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
    _resetWithdrawnModels();
  });

  afterEach(async () => {
    await closeServer();
    await cleanup();
    _resetWithdrawnModels();
  });

  it('refuses an unauthenticated call', async () => {
    expect((await get(false)).status).toBe(401);
  });

  it('serves the bundled catalogue', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: FleetModelCatalog };
    expect(body.success).toBe(true);
    expect(body.data).toEqual(bundledFleetModelCatalog());
    expect(body.data.models.map((m) => m.id)).toEqual(BUNDLED_FLEET_MODELS.map((m) => m.id));
  });

  it('serves a catalogue that the apps accept unchanged', async () => {
    const data = await catalog();
    expect(parseFleetModelCatalog(data)).toEqual(data);
  });

  it('leaves out a model the vendor withdrew and maps it to the default', async () => {
    // A workspace id that does not exist: the settings migration finds no row.
    await noteWithdrawnModel('00000000-0000-0000-0000-000000000000', 'gpt-6-luna');
    const data = await catalog();
    expect(data.models.map((m) => m.id)).not.toContain('gpt-6-luna');
    expect(data.retired['gpt-6-luna']).toBe(data.defaults.codex);
    // An older id that pointed at the withdrawn model now skips past it.
    expect(data.retired['gpt-5.6-luna']).toBe(data.defaults.codex);
    expect(parseFleetModelCatalog(data)).toEqual(data);
  });

  it('keeps an agent default even when it was withdrawn', async () => {
    const { defaults } = bundledFleetModelCatalog();
    await noteWithdrawnModel('00000000-0000-0000-0000-000000000000', defaults.codex);
    const data = await catalog();
    expect(data.models.map((m) => m.id)).toContain(defaults.codex);
    expect(data.retired[defaults.codex]).toBeUndefined();
  });
});
