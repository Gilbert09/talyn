import { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import type {
  ApiResponse,
  AssignTeamSeatsRequest,
  AssignTeamSeatsResponse,
  BillingOrder,
  CheckoutSessionResponse,
  CreateTeamRequest,
  GitHubAccountSuggestion,
  TeamCheckoutRequest,
  TeamDetail,
  TeamPricing,
} from '@talyn/shared';
import { assertUser } from '../middleware/auth.js';
import { getPoolDbClient } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';
import { isFeatureEnabled } from '../services/featureFlags.js';
import { githubService } from '../services/github.js';
import {
  createTeamCheckoutUrl,
  createTeamPortalUrl,
  getInvoiceUrlForTeam,
  getTeamPricing,
  listOrdersForTeam,
  OrderNotFoundError,
  teamBillingConfigured,
  updateTeamSubscriptionSeats,
} from '../services/billing/polar.js';
import {
  addTeamAdmin,
  assertTeamAdmin,
  assertTeamCanCheckout,
  assignNamedSeats,
  assignSelfSeat,
  createTeam,
  getTeamDetail,
  leaveTeam,
  normaliseGithubLogin,
  prepareSeatCountChange,
  removeSeat,
  removeTeamAdmin,
  renameTeam,
  TeamError,
  type ResolveGithubAccount,
} from '../services/billing/teams.js';

/**
 * The team plan, under `/billing/team`. Mounted with the rest of billing,
 * BEFORE `ownerScope`: most of these block on Polar or GitHub, and the team
 * tables are backend-only. Authorization is explicit — the `teams` flag on
 * every handler, and team-admin membership on every admin action.
 *
 * The flag decides who may BUY and MANAGE. It never decides whether a paid
 * seat works: the entitlement reads the team row directly.
 */
export function teamRoutes(): Router {
  const router = Router();

  /** Flag + billing config. Answers the request itself when it refuses. */
  async function gate(req: Request, res: Response): Promise<boolean> {
    const user = assertUser(req);
    if (!(await isFeatureEnabled('teams', { distinctId: user.id, email: user.email }))) {
      res.status(403).json({ success: false, error: 'The team plan is not available.' });
      return false;
    }
    if (!teamBillingConfigured()) {
      res
        .status(400)
        .json({ success: false, error: 'The team plan is not configured on this backend.' });
      return false;
    }
    return true;
  }

  /** Gate, then require the caller to administer `:id`. */
  async function adminGate(req: Request, res: Response): Promise<boolean> {
    if (!(await gate(req, res))) return false;
    try {
      await assertTeamAdmin(req.params.id!, assertUser(req).id);
      return true;
    } catch (err) {
      sendError(res, err);
      return false;
    }
  }

  function sendError(res: Response, err: unknown): void {
    if (err instanceof TeamError) {
      res.status(err.status).json({
        success: false,
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
      return;
    }
    throw err;
  }

  /**
   * Resolve GitHub logins through one of the admin's own connected GitHub
   * accounts. A token is needed at all because GitHub's anonymous API allows
   * 60 requests an hour per IP, which every tenant on this host shares.
   */
  async function connectedWorkspaceFor(userId: string): Promise<string> {
    const owned = await getPoolDbClient()
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(eq(workspacesTable.ownerId, userId));
    const connected = owned.find((w) => githubService.isConnected(w.id));
    if (!connected) {
      throw new TeamError(409, 'Connect GitHub to one of your workspaces to add people by username.');
    }
    return connected.id;
  }

  async function resolverFor(userId: string): Promise<ResolveGithubAccount> {
    const workspaceId = await connectedWorkspaceFor(userId);
    return (login) => githubService.getAccountByLogin(workspaceId, login);
  }

  // GitHub accounts matching what the admin is typing, for the seat picker.
  router.get('/:id/github-users', async (req, res) => {
    if (!(await adminGate(req, res))) return;
    const q = normaliseGithubLogin(String(req.query.q ?? ''));
    // Only characters a login can hold: this goes into GitHub's search syntax,
    // and a qualifier smuggled in ("x type:org") must not change the search.
    if (!q || q.length > 39 || !/^[A-Za-z0-9-]+$/.test(q)) {
      return res.json({ success: true, data: [] } as ApiResponse<GitHubAccountSuggestion[]>);
    }
    try {
      const workspaceId = await connectedWorkspaceFor(assertUser(req).id);
      const users = await githubService.searchUsers(workspaceId, q);
      res.json({ success: true, data: users } as ApiResponse<GitHubAccountSuggestion[]>);
    } catch (err) {
      if (err instanceof TeamError) return sendError(res, err);
      // A search failure (rate limit, GitHub outage) only empties the list.
      console.warn('[teams] GitHub user search failed:', err);
      res.json({ success: true, data: [] } as ApiResponse<GitHubAccountSuggestion[]>);
    }
  });

  // Live seat tiers for the purchase picker.
  router.get('/pricing', async (req, res) => {
    if (!(await gate(req, res))) return;
    const pricing = await getTeamPricing();
    res.json({ success: true, data: pricing } as ApiResponse<TeamPricing>);
  });

  router.post('/', async (req, res) => {
    if (!(await gate(req, res))) return;
    try {
      const body = req.body as CreateTeamRequest;
      const team = await createTeam(assertUser(req).id, String(body?.name ?? ''));
      res.status(201).json({ success: true, data: await getTeamDetail(team.id) } as ApiResponse<TeamDetail>);
    } catch (err) {
      sendError(res, err);
    }
  });

  // A member giving up their own seat. Registered before `/:id` routes.
  router.post('/leave', async (req, res) => {
    if (!(await gate(req, res))) return;
    try {
      await leaveTeam(assertUser(req).id);
      res.json({ success: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/:id', async (req, res) => {
    if (!(await adminGate(req, res))) return;
    res.json({ success: true, data: await getTeamDetail(req.params.id!) } as ApiResponse<TeamDetail>);
  });

  router.patch('/:id', async (req, res) => {
    if (!(await adminGate(req, res))) return;
    try {
      await renameTeam(req.params.id!, String((req.body as { name?: unknown })?.name ?? ''));
      res.json({ success: true, data: await getTeamDetail(req.params.id!) } as ApiResponse<TeamDetail>);
    } catch (err) {
      sendError(res, err);
    }
  });

  // Hosted checkout for a team with no subscription yet. Completion arrives
  // through the webhook, like a personal checkout.
  router.post('/:id/checkout', async (req, res) => {
    if (!(await adminGate(req, res))) return;
    try {
      const body = req.body as TeamCheckoutRequest;
      const period = body?.period === 'annual' ? 'annual' : 'monthly';
      const seats = Number(body?.seats);
      await assertTeamCanCheckout(req.params.id!, seats);
      const url = await createTeamCheckoutUrl(req.params.id!, period, seats);
      res.json({ success: true, data: { url } } as ApiResponse<CheckoutSessionResponse>);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/seats', async (req, res) => {
    if (!(await adminGate(req, res))) return;
    try {
      const user = assertUser(req);
      const body = req.body as AssignTeamSeatsRequest;
      const logins = Array.isArray(body?.logins) ? body.logins.map(String) : [];
      const result = await assignNamedSeats(
        req.params.id!,
        user.id,
        logins,
        await resolverFor(user.id)
      );
      res.json({ success: true, data: result } as ApiResponse<AssignTeamSeatsResponse>);
    } catch (err) {
      sendError(res, err);
    }
  });

  // The admin taking a seat for themselves. Registered before
  // `/:id/seats/:seatId` so "me" is never read as a seat id.
  router.post('/:id/seats/me', async (req, res) => {
    if (!(await adminGate(req, res))) return;
    try {
      const result = await assignSelfSeat(req.params.id!, assertUser(req).id);
      res.json({ success: true, data: result } as ApiResponse<AssignTeamSeatsResponse>);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/:id/seats/:seatId', async (req, res) => {
    if (!(await adminGate(req, res))) return;
    try {
      await removeSeat(req.params.id!, req.params.seatId!);
      res.json({ success: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Change the seat count on a live subscription. Polar prorates; the new
  // count lands through the webhook, the only writer of seats_purchased.
  router.post('/:id/seat-count', async (req, res) => {
    if (!(await adminGate(req, res))) return;
    try {
      const seats = Number((req.body as { seats?: unknown })?.seats);
      const subscriptionId = await prepareSeatCountChange(req.params.id!, seats);
      await updateTeamSubscriptionSeats(subscriptionId, seats);
      res.json({ success: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/admins', async (req, res) => {
    if (!(await adminGate(req, res))) return;
    try {
      await addTeamAdmin(req.params.id!, String((req.body as { login?: unknown })?.login ?? ''));
      res.json({ success: true, data: await getTeamDetail(req.params.id!) } as ApiResponse<TeamDetail>);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/:id/admins/:userId', async (req, res) => {
    if (!(await adminGate(req, res))) return;
    try {
      await removeTeamAdmin(req.params.id!, req.params.userId!);
      res.json({ success: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/portal', async (req, res) => {
    if (!(await adminGate(req, res))) return;
    try {
      const url = await createTeamPortalUrl(req.params.id!);
      res.json({ success: true, data: { url } } as ApiResponse<CheckoutSessionResponse>);
    } catch {
      res.status(400).json({
        success: false,
        error: 'No billing profile yet — buy seats first to manage billing here.',
      });
    }
  });

  router.get('/:id/orders', async (req, res) => {
    if (!(await adminGate(req, res))) return;
    const orders = await listOrdersForTeam(req.params.id!);
    res.json({ success: true, data: orders } as ApiResponse<BillingOrder[]>);
  });

  router.post('/:id/orders/:orderId/invoice', async (req, res) => {
    if (!(await adminGate(req, res))) return;
    try {
      const url = await getInvoiceUrlForTeam(req.params.id!, req.params.orderId!);
      res.json({ success: true, data: { url } } as ApiResponse<CheckoutSessionResponse>);
    } catch (err) {
      if (err instanceof OrderNotFoundError) {
        return res.status(404).json({ success: false, error: 'Order not found' });
      }
      throw err;
    }
  });

  return router;
}
