import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { environments as environmentsTable } from '../db/schema.js';
import { assertUser } from '../middleware/auth.js';
import type {
  Environment,
  EnvironmentConfig,
  EnvironmentRenderer,
  EnvironmentStatus,
  ApiResponse,
} from '@fastowl/shared';

/**
 * Cloud-only environments are secret-free markers, one per connected
 * provider, auto-provisioned on integration connect (see
 * services/cloudProviders/environment.ts). The desktop only needs to list
 * them (to target a task) and disconnect one — there's no daemon to pair,
 * test, or update, so those routes are gone.
 */
export function environmentRoutes(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const rows = await db
      .select()
      .from(environmentsTable)
      .where(eq(environmentsTable.ownerId, user.id))
      .orderBy(environmentsTable.name);
    res.json({ success: true, data: rows.map(rowToEnvironment) } as ApiResponse<Environment[]>);
  });

  router.get('/:id', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const rows = await db
      .select()
      .from(environmentsTable)
      .where(and(eq(environmentsTable.id, req.params.id), eq(environmentsTable.ownerId, user.id)))
      .limit(1);
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }
    res.json({ success: true, data: rowToEnvironment(rows[0]) } as ApiResponse<Environment>);
  });

  router.delete('/:id', async (req, res) => {
    const user = assertUser(req);
    const db = getDbClient();
    const result = await db
      .delete(environmentsTable)
      .where(and(eq(environmentsTable.id, req.params.id), eq(environmentsTable.ownerId, user.id)))
      .returning({ id: environmentsTable.id });
    if (result.length === 0) {
      return res.status(404).json({ success: false, error: 'Environment not found' });
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}

export function rowToEnvironment(row: typeof environmentsTable.$inferSelect): Environment {
  // Cloud env markers carry no daemon state. The daemon-era fields on the
  // Environment type are synthesised with inert defaults for back-compat
  // with any UI that still reads them.
  return {
    id: row.id,
    name: row.name,
    type: row.type as Environment['type'],
    status: row.status as EnvironmentStatus,
    config: row.config as EnvironmentConfig,
    lastConnected: row.lastConnected ? row.lastConnected.toISOString() : undefined,
    error: row.error ?? undefined,
    autonomousBypassPermissions: false,
    renderer: 'structured' as EnvironmentRenderer,
    toolAllowlist: [],
    autoUpdateDaemon: false,
  };
}
