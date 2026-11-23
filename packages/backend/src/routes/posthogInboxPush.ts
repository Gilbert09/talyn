import type { Request, Response, Router } from 'express';
import type {
  ApiResponse,
  InboundDelivery,
  InboundDeliverySummary,
  PostHogInboxPushRemoval,
  PostHogInboxPushReveal,
  PostHogInboxPushSetupResult,
  PostHogInboxPushState,
} from '@talyn/shared';
import {
  POSTHOG_INBOX_PUSH_FAILED_CODE,
  POSTHOG_INBOX_PUSH_FORBIDDEN_CODE,
  POSTHOG_INBOX_PUSH_SCOPES_MISSING_CODE,
  POSTHOG_INBOX_SECRET_HEADER,
} from '@talyn/shared';
import { assertUser } from '../middleware/auth.js';
import { captureWorkspaceEvent } from '../services/analytics.js';
import { scheduleProcessing } from '../services/inbound/receiver.js';
import {
  deliverySummary,
  getDelivery,
  listDeliveries,
  posthogInboxPushConnection,
  replayDelivery,
  type PostHogInboxPushConnectionRow,
} from '../services/inbound/store.js';
import { webhookUrl, webhookUrlPrefix } from '../services/inbound/url.js';
import { getPostHogInboxConnection, type PostHogInboxConnection } from '../services/posthogInbox/connection.js';
import { pollerState } from '../services/posthogInbox/poller.js';
import {
  destinationSummary,
  removePostHogInboxPush,
  rotatePostHogInboxPush,
  setUpPostHogInboxPush,
} from '../services/posthogInbox/pushSetup.js';

/**
 * The PostHog Inbox push: the webhook URL that a PostHog webhook destination
 * posts "report ready" to, and the requests it received.
 *
 * Registered on the workflows router ABOVE `/:id`, behind the same two gates
 * as the other PostHog Inbox routes: workspace access with the workflows
 * gate, then the `posthogInboxRules` flag for the caller.
 *
 * The URL belongs to the workspace and the PostHog project, never to a
 * connection row. The project comes only from `getPostHogInboxConnection`,
 * so the URL keeps working when the connection row behind it changes.
 *
 * - `GET    /posthog-inbox/webhook?workspaceId=` — the URL without its token, or null.
 * - `POST   /posthog-inbox/webhook/rotate` — make or replace it; the URL and secret are shown once.
 *   When Talyn created the PostHog destination, PostHog gets the new URL and secret too.
 * - `POST   /posthog-inbox/webhook/setup` — "Set up push in PostHog": make or rotate the URL and
 *   create or update the PostHog destination. Never shows the URL token or the secret.
 * - `DELETE /posthog-inbox/webhook?workspaceId=` — stop the push; the poller goes back to every 3 minutes.
 *   Talyn's PostHog destination is deleted too, best effort.
 * - `GET    /posthog-inbox/deliveries?workspaceId=` — the stored requests, newest first, no bodies.
 * - `GET    /posthog-inbox/deliveries/:deliveryId?workspaceId=` — one request with its body.
 * - `POST   /posthog-inbox/deliveries/:deliveryId/replay` — read the report again.
 */

type Gate = (req: Request, res: Response, workspaceId: string) => Promise<boolean>;
type CallerGate = (req: Request, res: Response) => Promise<boolean>;

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

export function registerPostHogInboxPushRoutes(router: Router, gates: { gate: Gate; posthogInboxGate: CallerGate }): void {
  /** Both gates, then the workspace's current PostHog project. Answers a refusal itself. */
  async function project(
    req: Request,
    res: Response,
    workspaceId: string
  ): Promise<{ projectId: string; integrationId: string | null; connection: PostHogInboxConnection } | null> {
    if (!(await gates.gate(req, res, workspaceId))) return null;
    if (!(await gates.posthogInboxGate(req, res))) return null;
    const connection = await getPostHogInboxConnection(workspaceId);
    if (!connection?.projectId) {
      res.status(409).json({
        success: false,
        error: "Talyn cannot read this workspace's PostHog Inbox. Connect PostHog with the Inbox permission first.",
        code: 'posthog_inbox_unavailable',
      });
      return null;
    }
    return { projectId: connection.projectId, integrationId: connection.id, connection };
  }

  /** The current project's URL row, or null. */
  async function pushConnection(
    req: Request,
    res: Response,
    workspaceId: string
  ): Promise<{ row: PostHogInboxPushConnectionRow | null; integrationId: string | null; host: string } | null> {
    const found = await project(req, res, workspaceId);
    if (!found) return null;
    return {
      row: await posthogInboxPushConnection(workspaceId, found.projectId),
      integrationId: found.integrationId,
      host: found.connection.host,
    };
  }

  const workspaceOf = (req: Request): string =>
    String((req.query.workspaceId as string | undefined) ?? (req.body as { workspaceId?: string } | undefined)?.workspaceId ?? '');

  router.get('/posthog-inbox/webhook', async (req, res) => {
    const workspaceId = workspaceOf(req);
    const found = await pushConnection(req, res, workspaceId);
    if (!found) return;
    let data: PostHogInboxPushState = null;
    if (found.row) {
      const state = found.integrationId ? await pollerState(found.integrationId) : null;
      data = {
        connectionId: found.row.id,
        urlPrefix: webhookUrlPrefix(req, found.row.id),
        projectId: found.row.projectId,
        secretRequired: found.row.secretRequired,
        createdAt: found.row.createdAt.toISOString(),
        rotatedAt: found.row.rotatedAt ? found.row.rotatedAt.toISOString() : null,
        lastDeliveryAt: found.row.lastDeliveryAt ? found.row.lastDeliveryAt.toISOString() : null,
        lastPushAt: state?.lastPushAt ? state.lastPushAt.toISOString() : null,
        destination: destinationSummary(found.row, found.host),
      };
    }
    res.json({ success: true, data } as ApiResponse<PostHogInboxPushState>);
  });

  router.post('/posthog-inbox/webhook/rotate', async (req, res) => {
    const body = (req.body ?? {}) as { workspaceId?: string; requireSecret?: unknown };
    const workspaceId = body.workspaceId ?? '';
    if (body.requireSecret !== undefined && typeof body.requireSecret !== 'boolean') {
      return res.status(400).json({ success: false, error: 'requireSecret must be true or false' });
    }
    const found = await project(req, res, workspaceId);
    if (!found) return;
    const requireSecret = body.requireSecret !== false;
    // A URL Talyn set up in PostHog: the destination gets the new URL and secret, or is marked out of date.
    const rotated = await rotatePostHogInboxPush({
      workspaceId,
      connection: found.connection,
      requireSecret,
      createdBy: assertUser(req).id,
      githubLogin: assertUser(req).githubUsername ?? null,
      urlFor: (connectionId, token) => webhookUrl(req, connectionId, token),
    });
    captureWorkspaceEvent(workspaceId, rotated.created ? 'posthog_inbox_webhook_created' : 'posthog_inbox_webhook_rotated', {
      require_secret: requireSecret,
      managed_destination: rotated.managed,
      ...(rotated.destination ? { destination: rotated.destination.state } : {}),
    });
    const data: PostHogInboxPushReveal = {
      connectionId: rotated.connectionId,
      url: rotated.url,
      secret: rotated.secret,
      secretHeader: POSTHOG_INBOX_SECRET_HEADER,
      destination: rotated.destination,
    };
    res.json({ success: true, data } as ApiResponse<PostHogInboxPushReveal>);
  });

  router.post('/posthog-inbox/webhook/setup', async (req, res) => {
    const workspaceId = (req.body as { workspaceId?: string } | undefined)?.workspaceId ?? '';
    const found = await project(req, res, workspaceId);
    if (!found) return;
    const result = await setUpPostHogInboxPush({
      workspaceId,
      connection: found.connection,
      createdBy: assertUser(req).id,
      githubLogin: assertUser(req).githubUsername ?? null,
      urlFor: (connectionId, token) => webhookUrl(req, connectionId, token),
    });
    if (!result.ok) {
      captureWorkspaceEvent(workspaceId, 'posthog_inbox_push_setup_failed', {
        reason: result.reason,
        ...(result.reason === 'posthog' ? { kind: result.failure.kind, status: result.failure.status } : {}),
      });
      if (result.reason === 'scopes_missing') {
        return res.status(409).json({
          success: false,
          error: result.message,
          code: POSTHOG_INBOX_PUSH_SCOPES_MISSING_CODE,
          missingScopes: result.missingScopes,
        });
      }
      if (result.reason === 'posthog') {
        const forbidden = result.failure.kind === 'forbidden' || result.failure.kind === 'unauthorized';
        return res.status(forbidden ? 409 : 502).json({
          success: false,
          error: result.message,
          code: forbidden ? POSTHOG_INBOX_PUSH_FORBIDDEN_CODE : POSTHOG_INBOX_PUSH_FAILED_CODE,
        });
      }
      return res.status(500).json({ success: false, error: result.message, code: POSTHOG_INBOX_PUSH_FAILED_CODE });
    }
    captureWorkspaceEvent(workspaceId, 'posthog_inbox_push_set_up', { created: result.created });
    const data: PostHogInboxPushSetupResult = {
      connectionId: result.connectionId,
      destination: result.destination,
      created: result.created,
    };
    res.json({ success: true, data } as ApiResponse<PostHogInboxPushSetupResult>);
  });

  router.delete('/posthog-inbox/webhook', async (req, res) => {
    const workspaceId = workspaceOf(req);
    if (!(await gates.gate(req, res, workspaceId))) return;
    if (!(await gates.posthogInboxGate(req, res))) return;
    // Talyn's PostHog destination goes first, while the connection can still reach it. Never blocks the removal.
    const { removed, destination } = await removePostHogInboxPush(
      workspaceId,
      await getPostHogInboxConnection(workspaceId, 'read').catch(() => null)
    );
    if (removed > 0) {
      captureWorkspaceEvent(workspaceId, 'posthog_inbox_webhook_removed', { destination: destination?.state ?? 'none' });
    }
    const data: PostHogInboxPushRemoval = { removed, destination };
    res.json({ success: true, data } as ApiResponse<PostHogInboxPushRemoval>);
  });

  router.get('/posthog-inbox/deliveries', async (req, res) => {
    const found = await pushConnection(req, res, workspaceOf(req));
    if (!found) return;
    if (!found.row) return res.json({ success: true, data: [] } as ApiResponse<InboundDeliverySummary[]>);
    const asked = Number(req.query.limit);
    const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_PAGE) : DEFAULT_PAGE;
    const data = await listDeliveries(found.row.id, { limit, cursor: (req.query.cursor as string) || null });
    res.json({ success: true, data } as ApiResponse<InboundDeliverySummary[]>);
  });

  router.get('/posthog-inbox/deliveries/:deliveryId', async (req, res) => {
    const found = await pushConnection(req, res, workspaceOf(req));
    if (!found) return;
    const data = found.row ? await getDelivery(found.row.id, String(req.params.deliveryId)) : null;
    if (!data) return res.status(404).json({ success: false, error: 'Delivery not found' });
    res.json({ success: true, data } as ApiResponse<InboundDelivery>);
  });

  router.post('/posthog-inbox/deliveries/:deliveryId/replay', async (req, res) => {
    const workspaceId = workspaceOf(req);
    const found = await pushConnection(req, res, workspaceId);
    if (!found) return;
    const replayed = found.row ? await replayDelivery(found.row.id, String(req.params.deliveryId)) : null;
    if (!found.row || !replayed) return res.status(404).json({ success: false, error: 'Delivery not found' });
    scheduleProcessing(replayed.id);
    captureWorkspaceEvent(workspaceId, 'posthog_inbox_delivery_replayed', {});
    const data = await deliverySummary(found.row.id, replayed.id);
    res.json({ success: true, data } as ApiResponse<InboundDeliverySummary | null>);
  });
}
