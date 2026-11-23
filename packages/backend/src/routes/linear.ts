import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import {
  ISSUE_RULES_UNAVAILABLE_CODE,
  LINEAR_NOT_CONFIGURED_CODE,
  type ApiResponse,
  type LinearAuthorizeResponse,
  type LinearEditorOptions,
  type LinearStatus,
} from '@talyn/shared';
import { getPoolDbClient } from '../db/client.js';
import { users as usersTable } from '../db/schema.js';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { renderCallbackPage } from '../services/callbackPage.js';
import { getLinearAppConfig } from '../services/linear/config.js';
import { linearEditorOptions } from '../services/linear/issues.js';
import { completeLinearConnect, consumeLinearState, LinearOAuthError, startLinearAuthorization } from '../services/linear/oauth.js';
import { deleteLinearConnection, getLinearConnection, listLinearConnections } from '../services/linear/store.js';
import {
  invalidReturnToBody,
  mobileLinearReturnUrl,
  parseReturnTo,
  validMobileReturn,
} from '../services/mobileReturn.js';
import { getWebAppUrl, webAppUrl } from '../services/webApp.js';
import { userMayUseIssueRules } from '../services/workflowsAccess.js';

/**
 * Linear, the issue tracker integration, behind the `issueRules` flag.
 *
 *   GET    /linear?workspaceId                        connections + configured
 *   POST   /linear/connect { workspaceId, returnTo? } → { authorizeUrl }
 *   DELETE /linear/connections/:id?workspaceId
 *   GET    /linear/connections/:id/options?workspaceId  teams, labels, states, projects
 *   GET    /linear/oauth/callback                     public; Linear's browser redirect
 *
 * Mounted BEFORE ownerScope: `inbound_connections` is backend-pool only, so
 * every handler checks workspace access itself. A 404 when the flag is off
 * for the caller, like the webhook rule routes.
 */

function originClient(req: Request): 'web' | 'desktop' {
  const webApp = getWebAppUrl();
  return webApp && req.headers.origin === webApp ? 'web' : 'desktop';
}

async function refuseUnlessEnabled(req: Request, res: Response): Promise<boolean> {
  const user = assertUser(req);
  if (await userMayUseIssueRules({ distinctId: user.id, email: user.email })) return false;
  res.status(404).json({
    success: false,
    error: 'Issue automations are not available for this account.',
    code: ISSUE_RULES_UNAVAILABLE_CODE,
  });
  return true;
}

async function workspaceFrom(req: Request, res: Response, raw: unknown): Promise<string | null> {
  if (typeof raw !== 'string' || !raw) {
    res.status(400).json({ success: false, error: 'workspaceId is required' });
    return null;
  }
  try {
    await requireWorkspaceAccess(req, raw);
  } catch (err) {
    handleAccessError(err, res);
    return null;
  }
  return raw;
}

/** The public callback. No auth header: the single-use state row is the security model. */
export function linearPublicRoutes(): Router {
  const router = Router();
  // Tighter than the global limiter: each hit can spend an authorization code.
  const oauthRateLimit = rateLimit({ windowMs: 10 * 60_000, max: 20, message: 'Too many OAuth requests — slow down.' });

  router.get('/oauth/callback', oauthRateLimit, async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    let mobileReturn: string | null = null;

    const finish = (client: 'web' | 'desktop', opts: { ok: boolean; message: string; status?: number }) => {
      if (mobileReturn) {
        return res.redirect(
          302,
          mobileLinearReturnUrl(mobileReturn, opts.ok ? { ok: true } : { ok: false, message: opts.message })
        );
      }
      if (client === 'web') {
        const target = webAppUrl('/integrations/linear', {
          linear: opts.ok ? 'connected' : 'error',
          ...(opts.ok ? {} : { message: opts.message }),
        });
        if (target) return res.redirect(302, target);
      }
      return res
        .status(opts.status ?? 200)
        .type('html')
        .send(renderCallbackPage({ ok: opts.ok, product: 'Linear', message: opts.message }));
    };

    // Consumed even on an error, so a cancelled flow cannot be finished later.
    const pending = state ? await consumeLinearState(state) : null;
    mobileReturn = validMobileReturn(pending?.mobileReturn);
    const client = pending?.client ?? originClient(req);
    if (error) {
      const message = error === 'access_denied' ? 'The Linear sign-in was cancelled.' : `Linear returned an error: ${error}.`;
      return finish(client, { ok: false, status: 400, message });
    }
    if (!code || !state) return finish(client, { ok: false, status: 400, message: 'Missing code or state.' });
    if (!pending) {
      return finish(client, {
        ok: false,
        status: 400,
        message: 'That Linear connection attempt has expired or was already used. Start again from Talyn.',
      });
    }

    // The flag may have changed in the ten minutes since the flow started.
    const userRows = await getPoolDbClient()
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, pending.userId))
      .limit(1);
    if (!(await userMayUseIssueRules({ distinctId: pending.userId, email: userRows[0]?.email }))) {
      return finish(pending.client, { ok: false, status: 403, message: 'Issue automations are not available for this account.' });
    }

    try {
      const result = await completeLinearConnect({ code, pending });
      return finish(pending.client, {
        ok: true,
        message: `Talyn is connected to ${result.organizationName ?? 'your Linear workspace'}.`,
      });
    } catch (err) {
      const message = err instanceof LinearOAuthError ? err.message : 'Could not finish connecting Linear. Try again.';
      if (!(err instanceof LinearOAuthError)) {
        console.error('[linear:oauth] callback failed:', err instanceof Error ? err.message : err);
      }
      return finish(pending.client, { ok: false, status: 400, message });
    }
  });

  return router;
}

export function linearRoutes(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    if (await refuseUnlessEnabled(req, res)) return;
    const workspaceId = await workspaceFrom(req, res, req.query.workspaceId);
    if (!workspaceId) return;
    const data: LinearStatus = {
      configured: getLinearAppConfig() !== null,
      connections: await listLinearConnections(workspaceId),
    };
    res.json({ success: true, data } as ApiResponse<LinearStatus>);
  });

  // An optional `returnTo` (the mobile app's allowlisted URL base) makes the
  // callback finish with a 302 to `${returnTo}linear/callback?...`.
  router.post('/connect', async (req, res) => {
    if (await refuseUnlessEnabled(req, res)) return;
    const body = (req.body ?? {}) as { workspaceId?: unknown; returnTo?: unknown };
    const returnTo = parseReturnTo(body.returnTo);
    if (!returnTo.ok) return res.status(400).json(invalidReturnToBody());
    if (!getLinearAppConfig()) {
      return res.status(503).json({
        success: false,
        error: 'Linear is not configured on this deployment. An administrator must set the Linear app client id, secret and redirect URI.',
        code: LINEAR_NOT_CONFIGURED_CODE,
      });
    }
    const workspaceId = await workspaceFrom(req, res, body.workspaceId);
    if (!workspaceId) return;
    const { authorizeUrl } = await startLinearAuthorization({
      userId: assertUser(req).id,
      workspaceId,
      client: originClient(req),
      mobileReturn: returnTo.returnTo,
    });
    res.json({ success: true, data: { authorizeUrl } } as ApiResponse<LinearAuthorizeResponse>);
  });

  /** The connection, if it belongs to the asked workspace. Answers 404 otherwise. */
  async function ownConnection(req: Request, res: Response): Promise<{ workspaceId: string; id: string } | null> {
    const workspaceId = await workspaceFrom(req, res, req.query.workspaceId);
    if (!workspaceId) return null;
    const connection = await getLinearConnection(req.params.id);
    if (!connection || connection.workspaceId !== workspaceId) {
      res.status(404).json({ success: false, error: 'Linear connection not found' });
      return null;
    }
    return { workspaceId, id: connection.id };
  }

  router.delete('/connections/:id', async (req, res) => {
    if (await refuseUnlessEnabled(req, res)) return;
    const own = await ownConnection(req, res);
    if (!own) return;
    await deleteLinearConnection(own.workspaceId, own.id);
    res.json({ success: true, data: null } as ApiResponse<null>);
  });

  router.get('/connections/:id/options', async (req, res) => {
    if (await refuseUnlessEnabled(req, res)) return;
    const own = await ownConnection(req, res);
    if (!own) return;
    const data = await linearEditorOptions(own.id);
    res.json({ success: true, data } as ApiResponse<LinearEditorOptions>);
  });

  return router;
}
