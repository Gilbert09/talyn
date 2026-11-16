import type { Request, Response, Router } from 'express';
import type {
  ApiResponse,
  InboundDelivery,
  InboundDeliverySummary,
  PostHogInboxPushReveal,
  PostHogInboxPushState,
} from '@talyn/shared';
import { POSTHOG_INBOX_SECRET_HEADER } from '@talyn/shared';
import { assertUser } from '../middleware/auth.js';
import { captureWorkspaceEvent } from '../services/analytics.js';
import { scheduleProcessing } from '../services/inbound/receiver.js';
import {
  deletePostHogInboxPushConnections,
  deliverySummary,
  getDelivery,
  listDeliveries,
  posthogInboxPushConnection,
  replayDelivery,
  rotatePostHogInboxPushConnection,
  type PostHogInboxPushConnectionRow,
} from '../services/inbound/store.js';
import { webhookUrl, webhookUrlPrefix } from '../services/inbound/url.js';
import { getPostHogInboxConnection } from '../services/posthogInbox/connection.js';
import { pollerState } from '../services/posthogInbox/poller.js';

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
 * - `DELETE /posthog-inbox/webhook?workspaceId=` — stop the push; the poller goes back to every 3 minutes.
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
  ): Promise<{ projectId: string; integrationId: string | null } | null> {
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
    return { projectId: connection.projectId, integrationId: connection.id };
  }

  /** The current project's URL row, or null. */
  async function pushConnection(
    req: Request,
    res: Response,
    workspaceId: string
  ): Promise<{ row: PostHogInboxPushConnectionRow | null; integrationId: string | null } | null> {
    const found = await project(req, res, workspaceId);
    if (!found) return null;
    return { row: await posthogInboxPushConnection(workspaceId, found.projectId), integrationId: found.integrationId };
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
    const rotated = await rotatePostHogInboxPushConnection(workspaceId, found.projectId, {
      requireSecret,
      createdBy: assertUser(req).id,
    });
    captureWorkspaceEvent(workspaceId, rotated.created ? 'posthog_inbox_webhook_created' : 'posthog_inbox_webhook_rotated', {
      require_secret: requireSecret,
    });
    const data: PostHogInboxPushReveal = {
      connectionId: rotated.connectionId,
      url: webhookUrl(req, rotated.connectionId, rotated.token),
      secret: rotated.secret,
      secretHeader: POSTHOG_INBOX_SECRET_HEADER,
    };
    res.json({ success: true, data } as ApiResponse<PostHogInboxPushReveal>);
  });

  router.delete('/posthog-inbox/webhook', async (req, res) => {
    const workspaceId = workspaceOf(req);
    if (!(await gates.gate(req, res, workspaceId))) return;
    if (!(await gates.posthogInboxGate(req, res))) return;
    const removed = await deletePostHogInboxPushConnections(workspaceId);
    if (removed > 0) captureWorkspaceEvent(workspaceId, 'posthog_inbox_webhook_removed', {});
    res.json({ success: true, data: { removed } } as ApiResponse<{ removed: number }>);
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
