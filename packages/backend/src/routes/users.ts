import { Router } from 'express';
import { eq } from 'drizzle-orm';
import type { ApiResponse } from '@fastowl/shared';
import { getDbClient } from '../db/client.js';
import { users as usersTable, workspaces as workspacesTable } from '../db/schema.js';
import { githubService } from '../services/github.js';
import { getSupabaseServiceClient, isSupabaseConfigured } from '../services/supabase.js';

/**
 * Account-level routes for the calling user. Mounted BEFORE the owner-scope
 * middleware: the wipe below deletes the caller's own `users` row, which RLS
 * doesn't permit from the `authenticated` role — and every query here is
 * already hard-scoped to `req.user.id`.
 */
export function userRoutes(): Router {
  const router = Router();

  // DELETE /users/me — wipe the calling account end-to-end so the next
  // sign-in starts from a blank slate (fresh auth user → onboarding wizard).
  // Deletes every owned workspace via the users-row cascade (integrations,
  // repositories, pull requests, tasks, environments), purges in-memory
  // GitHub state for those workspaces, and removes the Supabase auth user.
  // Surfaced as a developer tool in Settings → Developer.
  router.delete('/me', async (req, res) => {
    const userId = req.user!.id;
    const db = getDbClient();

    const owned = await db
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(eq(workspacesTable.ownerId, userId));

    await db.delete(usersTable).where(eq(usersTable.id, userId));

    // The DB rows are already gone (cascade); removeToken's own delete is a
    // no-op, but it clears the token/viewer caches and emits 'disconnected'
    // so the PR monitor stops polling the dead workspaces.
    for (const ws of owned) {
      await githubService.removeToken(ws.id, 'account deletion cleanup');
    }

    // Best-effort: without this the auth user survives and the next sign-in
    // reuses it — fine functionally, but not the blank slate the caller asked
    // for. The app session is unusable either way once the row is gone.
    if (isSupabaseConfigured()) {
      try {
        await getSupabaseServiceClient().auth.admin.deleteUser(userId);
      } catch (err) {
        console.error('Account wipe: failed to delete auth user:', err);
      }
    }

    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}
