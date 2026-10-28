import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import {
  SLACK_NOT_CONFIGURED_CODE,
  SLACK_UNAVAILABLE_CODE,
  validateSlackTriggerEmojis,
  type ApiResponse,
  type SlackAuthorizeResponse,
  type SlackForgetInstallationResponse,
  type SlackStatus,
  type UpdateSlackLinkInput,
} from '@talyn/shared';
import { getPoolDbClient } from '../db/client.js';
import { users as usersTable } from '../db/schema.js';
import { AccessError, assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { renderCallbackPage } from '../services/callbackPage.js';
import { getWebAppUrl, webAppUrl } from '../services/webApp.js';
import { slackRefusalReason, userMayUseSlack } from '../services/slack/access.js';
import { SlackApiError } from '../services/slack/api.js';
import { getSlackAppConfig } from '../services/slack/config.js';
import {
  completeSlackInstall,
  completeSlackLink,
  consumeSlackState,
  SlackOAuthError,
  startSlackAuthorization,
  type SlackFlow,
} from '../services/slack/oauth.js';
import {
  deleteOwnLink,
  firstWorkspaceOf,
  forgetInstallation,
  ownLink,
  slackStatusFor,
  updateOwnLink,
} from '../services/slack/store.js';

/**
 * Slack sessions, behind the `slack` flag.
 *
 *   GET    /slack                          installs I can see + my links
 *   POST   /slack/install   { workspaceId? }   → { authorizeUrl }
 *   POST   /slack/link      { workspaceId? }   → { authorizeUrl }
 *   PATCH  /slack/links/:id { triggerEmojis?, workspaceId? }
 *   DELETE /slack/links/:id
 *   DELETE /slack/installations/:teamId    installer only
 *   GET    /slack/oauth/callback           public; Slack's browser redirect
 *
 * Mounted BEFORE ownerScope: the Slack tables are backend-only, so every read
 * is on the pool and every handler authorises against `req.user.id` itself.
 */

/** Which front end started a flow; recorded on the state row, never read at the callback. */
function originClient(req: Request): 'web' | 'desktop' {
  const webApp = getWebAppUrl();
  return webApp && req.headers.origin === webApp ? 'web' : 'desktop';
}

async function refuseUnlessEnabled(req: Request, res: Response): Promise<boolean> {
  const user = assertUser(req);
  if (await userMayUseSlack({ distinctId: user.id, email: user.email })) return false;
  res.status(403).json({
    success: false,
    error: `Slack sessions are not available: ${slackRefusalReason()}.`,
    code: SLACK_UNAVAILABLE_CODE,
  });
  return true;
}

/**
 * Routes Slack's browser redirect lands on. No auth header: the single-use
 * state row is the whole security model, as with the GitHub and PostHog
 * callbacks.
 */
export function slackPublicRoutes(): Router {
  const router = Router();
  // Tighter than the global limiter: each hit can spend an authorization code.
  const oauthRateLimit = rateLimit({
    windowMs: 10 * 60_000,
    max: 20,
    message: 'Too many OAuth requests — slow down.',
  });

  router.get('/oauth/callback', oauthRateLimit, async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;

    const finish = (
      client: 'web' | 'desktop',
      opts: { ok: boolean; message: string; status?: number; flow?: SlackFlow }
    ) => {
      if (client === 'web') {
        const outcome = !opts.ok ? 'error' : opts.flow === 'install' ? 'installed' : 'linked';
        const target = webAppUrl('/settings', {
          slack: outcome,
          ...(opts.ok ? {} : { message: opts.message }),
        });
        if (target) return res.redirect(302, target);
      }
      return res
        .status(opts.status ?? 200)
        .type('html')
        .send(renderCallbackPage({ ok: opts.ok, product: 'Slack', message: opts.message }));
    };

    // Consumed even on an error, so a cancelled flow cannot be finished later.
    const pending = state ? await consumeSlackState(state) : null;
    const client = pending?.client ?? originClient(req);
    if (error) {
      const message = error === 'access_denied' ? 'The Slack sign-in was cancelled.' : `Slack returned an error: ${error}.`;
      return finish(client, { ok: false, status: 400, message });
    }
    if (!code || !state) {
      return finish(client, { ok: false, status: 400, message: 'Missing code or state.' });
    }
    if (!pending) {
      return finish(client, {
        ok: false,
        status: 400,
        message: 'That Slack connection attempt has expired or was already used. Start again from Talyn.',
      });
    }

    // The flag may have changed in the ten minutes since the flow started.
    const userRows = await getPoolDbClient()
      .select({ email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, pending.userId))
      .limit(1);
    if (!(await userMayUseSlack({ distinctId: pending.userId, email: userRows[0]?.email }))) {
      return finish(client, {
        ok: false,
        status: 403,
        message: `Slack sessions are not available: ${slackRefusalReason()}.`,
      });
    }

    try {
      if (pending.flow === 'install') {
        const result = await completeSlackInstall({ code, pending });
        return finish(pending.client, {
          ok: true,
          flow: 'install',
          message: `Talyn is installed in ${result.teamName ?? 'your Slack workspace'}, and your Slack account is linked.`,
        });
      }
      await completeSlackLink({ code, pending });
      return finish(pending.client, { ok: true, flow: 'link', message: 'Your Slack account is linked to Talyn.' });
    } catch (err) {
      const message =
        err instanceof SlackOAuthError
          ? err.message
          : err instanceof SlackApiError
            ? `Slack refused the sign-in (${err.code}). Try again.`
            : 'Could not finish connecting Slack. Try again.';
      if (!(err instanceof SlackOAuthError)) {
        console.error('[slack:oauth] callback failed:', err instanceof Error ? err.message : err);
      }
      return finish(pending.client, { ok: false, status: 400, message });
    }
  });

  return router;
}

/** Resolve the workspace a flow starts with: the asked one (if the caller's), else their first. */
async function startWorkspace(req: Request, res: Response): Promise<string | null | undefined> {
  const { workspaceId } = (req.body ?? {}) as { workspaceId?: unknown };
  if (workspaceId === undefined || workspaceId === null) {
    return firstWorkspaceOf(assertUser(req).id);
  }
  if (typeof workspaceId !== 'string' || !workspaceId) {
    res.status(400).json({ success: false, error: 'workspaceId must be a string' });
    return undefined;
  }
  try {
    await requireWorkspaceAccess(req, workspaceId);
  } catch (err) {
    handleAccessError(err, res);
    return undefined;
  }
  return workspaceId;
}

export function slackRoutes(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    if (await refuseUnlessEnabled(req, res)) return;
    const data = await slackStatusFor(assertUser(req).id);
    res.json({ success: true, data } as ApiResponse<SlackStatus>);
  });

  const start = (flow: SlackFlow) => async (req: Request, res: Response) => {
    if (await refuseUnlessEnabled(req, res)) return;
    if (!getSlackAppConfig()) {
      return res.status(503).json({
        success: false,
        error:
          'Slack is not configured on this deployment. An administrator must set the Slack app client id, secret and redirect URI.',
        code: SLACK_NOT_CONFIGURED_CODE,
      });
    }
    const workspaceId = await startWorkspace(req, res);
    if (workspaceId === undefined) return;
    const { authorizeUrl } = await startSlackAuthorization({
      flow,
      userId: assertUser(req).id,
      workspaceId,
      client: originClient(req),
    });
    res.json({ success: true, data: { authorizeUrl } } as ApiResponse<SlackAuthorizeResponse>);
  };
  router.post('/install', start('install'));
  router.post('/link', start('link'));

  router.patch('/links/:id', async (req, res) => {
    if (await refuseUnlessEnabled(req, res)) return;
    const userId = assertUser(req).id;
    const body = (req.body ?? {}) as UpdateSlackLinkInput;
    const patch: { triggerEmojis?: string[]; workspaceId?: string } = {};
    if (body.triggerEmojis !== undefined) {
      const checked = validateSlackTriggerEmojis(body.triggerEmojis);
      if (!checked.ok) return res.status(400).json({ success: false, error: checked.error });
      patch.triggerEmojis = checked.emojis;
    }
    if (body.workspaceId !== undefined) {
      if (typeof body.workspaceId !== 'string' || !body.workspaceId) {
        return res.status(400).json({ success: false, error: 'workspaceId must be a string' });
      }
      try {
        await requireWorkspaceAccess(req, body.workspaceId);
      } catch (err) {
        return handleAccessError(err, res);
      }
      patch.workspaceId = body.workspaceId;
    }
    // 404 for someone else's link too, so ids do not leak.
    if (!(await ownLink(userId, req.params.id))) {
      return handleAccessError(new AccessError('link not found'), res);
    }
    if (Object.keys(patch).length > 0) await updateOwnLink(userId, req.params.id, patch);
    const status = await slackStatusFor(userId);
    const link = status.links.find((l) => l.id === req.params.id);
    res.json({ success: true, data: link });
  });

  router.delete('/links/:id', async (req, res) => {
    if (await refuseUnlessEnabled(req, res)) return;
    if (!(await deleteOwnLink(assertUser(req).id, req.params.id))) {
      return handleAccessError(new AccessError('link not found'), res);
    }
    res.json({ success: true });
  });

  router.delete('/installations/:teamId', async (req, res) => {
    if (await refuseUnlessEnabled(req, res)) return;
    const teamId = req.params.teamId;
    const outcome = await forgetInstallation(assertUser(req).id, teamId);
    if (outcome === 'not_found') return handleAccessError(new AccessError('installation not found'), res);
    if (outcome === 'forbidden') {
      return res
        .status(403)
        .json({ success: false, error: 'Only the person who installed Talyn in this Slack workspace can remove it.' });
    }
    res.json({
      success: true,
      data: {
        teamId,
        message:
          'Talyn forgot this workspace’s bot token. The app is still installed in Slack: remove it there ' +
          '(Slack → Settings → Manage apps) to uninstall it. Links stay, so installing again restores them.',
      },
    } as ApiResponse<SlackForgetInstallationResponse>);
  });

  return router;
}
