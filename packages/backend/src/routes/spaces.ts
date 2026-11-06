import { Router, type Request, type Response } from 'express';
import { asc, eq } from 'drizzle-orm';
import type {
  ApiResponse,
  CreateSpaceSessionResponse,
  Space,
  SpaceItemsResponse,
  SpaceRepository,
  SpacesTeam,
  SpaceSessionRow,
  SpaceTaskRow,
  Task,
  TeamMember,
  Workbench,
} from '@talyn/shared';
import { assertUser } from '../middleware/auth.js';
import { getPoolDbClient } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';
import { isFeatureEnabled } from '../services/featureFlags.js';
import { githubService } from '../services/github.js';
import { GitHubRateLimitError } from '../services/githubRateGate.js';
import { RepoNotReadableError } from '../services/prMonitor.js';
import { TeamError, type ResolveGithubAccount } from '../services/billing/teams.js';
import {
  assertTeamMember,
  changeMemberRole,
  createSpacesTeam,
  inviteMember,
  listMembers,
  listMyTeams,
  removeMember,
  renameSpacesTeam,
  setHomeWorkspace,
} from '../services/teams/membership.js';
import {
  addSpaceRepository,
  archiveSpace,
  createSessionInSpace,
  createSpace,
  listSpaceRepositories,
  listSpaceSessions,
  listSpaceTasks,
  moveTaskToSpace,
  moveWorkbenchToSpace,
  removeSpaceRepository,
  updateSpace,
} from '../services/teams/spaces.js';
import { userMayUseWorkbenches, workbenchesRefusalReason } from '../services/workbenches/access.js';
import { fleetErrorAsRefusal } from '../services/workbenches/errors.js';

/**
 * Teams and Spaces, under `/api/v1`: `/teams/...`, `/spaces/...`, and the two
 * move routes `/workbenches/:id/space` and `/tasks/:id/space`.
 *
 * Mounted BEFORE `ownerScope`: `team_members`, `spaces` and
 * `space_repositories` are backend-pool-only, and a space lists rows from
 * several owners' workspaces. Authorization is explicit instead: the `spaces`
 * flag for the caller on every handler, then `services/teams/access.ts` and
 * the membership checks. The billing team routes stay at `/billing/team`.
 */
export function spaceRoutes(): Router {
  const router = Router();

  const ok = <T>(res: Response, data: T, status = 200) =>
    res.status(status).json({ success: true, data } as ApiResponse<T>);

  /** The flag, for the caller. False means the request is answered. */
  async function gate(req: Request, res: Response): Promise<boolean> {
    const user = assertUser(req);
    if (!(await isFeatureEnabled('spaces', { distinctId: user.id, email: user.email }))) {
      res.status(403).json({ success: false, error: 'Spaces are not available.', code: 'spaces_unavailable' });
      return false;
    }
    return true;
  }

  /** Known refusals become their status and code. Anything else is a real fault. */
  function fail(res: Response, err: unknown): void {
    if (err instanceof TeamError) {
      res.status(err.status).json({ success: false, error: err.message, ...(err.code ? { code: err.code } : {}) });
      return;
    }
    if (err instanceof RepoNotReadableError) {
      res.status(404).json({ success: false, error: err.message, code: 'repo_not_accessible' });
      return;
    }
    if (err instanceof GitHubRateLimitError) {
      res.status(503).json({
        success: false,
        error: 'GitHub is rate-limiting Talyn right now. Try again in a moment.',
        code: 'rate_limited',
      });
      return;
    }
    const refusal = fleetErrorAsRefusal(err);
    if (refusal) {
      res.status(refusal.status).json({
        success: false,
        error: refusal.message,
        ...(refusal.code ? { code: refusal.code } : {}),
      });
      return;
    }
    throw err;
  }

  /** Run a handler behind the gate, with refusals answered. */
  function handle(fn: (req: Request, res: Response) => Promise<void>) {
    return async (req: Request, res: Response) => {
      if (!(await gate(req, res))) return;
      try {
        await fn(req, res);
      } catch (err) {
        fail(res, err);
      }
    };
  }

  /**
   * Resolve a GitHub login through the caller's own connected GitHub account.
   * The anonymous API allows 60 requests an hour per IP, which every tenant
   * on this host shares.
   */
  async function resolverFor(userId: string): Promise<ResolveGithubAccount> {
    const owned = await getPoolDbClient()
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(eq(workspacesTable.ownerId, userId))
      .orderBy(asc(workspacesTable.createdAt));
    const connected = owned.find((w) => githubService.isConnected(w.id));
    if (!connected) {
      throw new TeamError(409, 'Connect GitHub to one of your workspaces to invite people by username.');
    }
    return (login) => githubService.getAccountByLogin(connected.id, login);
  }

  // ---- Teams ----

  router.get(
    '/teams',
    handle(async (req, res) => {
      ok(res, await listMyTeams(assertUser(req).id) satisfies SpacesTeam[]);
    })
  );

  router.post(
    '/teams',
    handle(async (req, res) => {
      const name = String((req.body as { name?: unknown } | undefined)?.name ?? '');
      ok(res, (await createSpacesTeam(assertUser(req).id, name)) satisfies SpacesTeam, 201);
    })
  );

  router.patch(
    '/teams/:id',
    handle(async (req, res) => {
      const userId = assertUser(req).id;
      const name = String((req.body as { name?: unknown } | undefined)?.name ?? '');
      await renameSpacesTeam(req.params.id!, userId, name);
      const team = (await listMyTeams(userId)).find((t) => t.id === req.params.id);
      ok(res, team satisfies SpacesTeam | undefined);
    })
  );

  router.get(
    '/teams/:id/members',
    handle(async (req, res) => {
      ok(res, (await listMembers(req.params.id!, assertUser(req).id)) satisfies TeamMember[]);
    })
  );

  router.post(
    '/teams/:id/members',
    handle(async (req, res) => {
      const userId = assertUser(req).id;
      // Membership first, so a stranger gets the 404 before any GitHub lookup.
      await assertTeamMember(req.params.id!, userId);
      const login = String((req.body as { githubLogin?: unknown } | undefined)?.githubLogin ?? '');
      const member = await inviteMember(req.params.id!, userId, login, await resolverFor(userId));
      ok(res, member satisfies TeamMember, 201);
    })
  );

  router.patch(
    '/teams/:id/members/:memberId',
    handle(async (req, res) => {
      const role = (req.body as { role?: unknown } | undefined)?.role;
      const member = await changeMemberRole(req.params.id!, assertUser(req).id, req.params.memberId!, role);
      ok(res, member satisfies TeamMember);
    })
  );

  router.delete(
    '/teams/:id/members/:memberId',
    handle(async (req, res) => {
      await removeMember(req.params.id!, assertUser(req).id, req.params.memberId!);
      ok(res, null);
    })
  );

  router.put(
    '/teams/:id/home-workspace',
    handle(async (req, res) => {
      const workspaceId = (req.body as { workspaceId?: unknown } | undefined)?.workspaceId;
      if (typeof workspaceId !== 'string' || !workspaceId) {
        throw new TeamError(400, 'workspaceId is required.');
      }
      ok(res, { homeWorkspaceId: await setHomeWorkspace(req.params.id!, assertUser(req).id, workspaceId) });
    })
  );

  // ---- Spaces ----

  router.post(
    '/teams/:id/spaces',
    handle(async (req, res) => {
      const space = await createSpace(req.params.id!, assertUser(req).id, (req.body ?? {}) as Record<string, unknown>);
      ok(res, space satisfies Space, 201);
    })
  );

  router.patch(
    '/spaces/:id',
    handle(async (req, res) => {
      const space = await updateSpace(req.params.id!, assertUser(req).id, (req.body ?? {}) as Record<string, unknown>);
      ok(res, space satisfies Space);
    })
  );

  router.delete(
    '/spaces/:id',
    handle(async (req, res) => {
      await archiveSpace(req.params.id!, assertUser(req).id);
      ok(res, null);
    })
  );

  router.get(
    '/spaces/:id/repositories',
    handle(async (req, res) => {
      ok(res, (await listSpaceRepositories(req.params.id!, assertUser(req).id)) satisfies SpaceRepository[]);
    })
  );

  router.post(
    '/spaces/:id/repositories',
    handle(async (req, res) => {
      const repoFullName = (req.body as { repoFullName?: unknown } | undefined)?.repoFullName;
      const repo = await addSpaceRepository(req.params.id!, assertUser(req).id, repoFullName);
      ok(res, repo satisfies SpaceRepository, 201);
    })
  );

  router.delete(
    '/spaces/:id/repositories/:owner/:repo',
    handle(async (req, res) => {
      await removeSpaceRepository(req.params.id!, assertUser(req).id, `${req.params.owner}/${req.params.repo}`);
      ok(res, null);
    })
  );

  router.get(
    '/spaces/:id/sessions',
    handle(async (req, res) => {
      const data = await listSpaceSessions(req.params.id!, assertUser(req).id);
      ok(res, data satisfies SpaceItemsResponse<SpaceSessionRow>);
    })
  );

  router.get(
    '/spaces/:id/tasks',
    handle(async (req, res) => {
      const data = await listSpaceTasks(req.params.id!, assertUser(req).id);
      ok(res, data satisfies SpaceItemsResponse<SpaceTaskRow>);
    })
  );

  router.post(
    '/spaces/:id/sessions',
    handle(async (req, res) => {
      const sentAt = new Date().toISOString();
      const user = assertUser(req);
      if (!(await userMayUseWorkbenches({ distinctId: user.id, email: user.email }))) {
        res.status(403).json({
          success: false,
          error: `Sessions are not available: ${workbenchesRefusalReason()}.`,
          code: 'workbenches_unavailable',
        });
        return;
      }
      const data = await createSessionInSpace(req.params.id!, { id: user.id, email: user.email }, req.body ?? {}, sentAt);
      ok(res, data satisfies CreateSpaceSessionResponse);
    })
  );

  // ---- Move to a space, or back to Personal ----

  router.put(
    '/workbenches/:id/space',
    handle(async (req, res) => {
      const spaceId = (req.body as { spaceId?: unknown } | undefined)?.spaceId;
      ok(res, (await moveWorkbenchToSpace(assertUser(req).id, req.params.id!, spaceId)) satisfies Workbench);
    })
  );

  router.put(
    '/tasks/:id/space',
    handle(async (req, res) => {
      const spaceId = (req.body as { spaceId?: unknown } | undefined)?.spaceId;
      ok(res, (await moveTaskToSpace(assertUser(req).id, req.params.id!, spaceId)) satisfies Task);
    })
  );

  return router;
}
