import { Router, type Request, type Response } from 'express';
import type {
  ApiResponse,
  InboundDelivery,
  InboundDeliverySummary,
  WebhookConnectionSummary,
  WebhookSecretReveal,
  WorkflowDefinition,
} from '@talyn/shared';
import { workflowIntegrationOf } from '@talyn/shared';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { captureWorkspaceEvent } from '../services/analytics.js';
import { scheduleProcessing } from '../services/inbound/receiver.js';
import {
  deliverySummary,
  getDelivery,
  listDeliveries,
  replayDelivery,
  rotateWebhookConnection,
  webhookConnectionForRule,
} from '../services/inbound/store.js';
import { webhookUrl, webhookUrlPrefix } from '../services/inbound/url.js';
import { getWorkflow } from '../services/workflows/store.js';
import { userMayUseWebhookRules, workspaceMayUseWorkflows } from '../services/workflowsAccess.js';

/**
 * A webhook rule's URL and the requests it received.
 *
 * Mounted at `/workflows` beside `workflowRoutes`, below `ownerScope`. The
 * inbound tables are backend-pool only, so the store reads the pool, and
 * `requireWorkspaceAccess` is the authorisation. Every route answers 404 when
 * the `webhookRules` flag is off for the caller, or when the rule is not a
 * webhook rule.
 */

const DEFAULT_PAGE = 50;
/** A page of deliveries carries no body, so 200 rows is a few tens of kilobytes. */
const MAX_PAGE = 200;

export function workflowWebhookRoutes(): Router {
  const router = Router();

  /** The rule, after every gate. Answers the request itself and returns null on a refusal. */
  async function webhookRule(req: Request, res: Response): Promise<WorkflowDefinition | null> {
    const user = assertUser(req);
    if (!(await userMayUseWebhookRules({ distinctId: user.id, email: user.email }))) {
      res.status(404).json({ success: false, error: 'Not found', code: 'webhook_rules_unavailable' });
      return null;
    }
    const rule = await getWorkflow(String(req.params.id));
    if (!rule || workflowIntegrationOf(rule) !== 'webhook') {
      res.status(404).json({ success: false, error: 'Webhook automation not found' });
      return null;
    }
    try {
      await requireWorkspaceAccess(req, rule.workspaceId);
    } catch (err) {
      handleAccessError(err, res);
      return null;
    }
    if (!(await workspaceMayUseWorkflows(rule.workspaceId))) {
      res.status(404).json({ success: false, error: 'Not found', code: 'workflows_unavailable' });
      return null;
    }
    return rule;
  }

  router.get('/:id/webhook', async (req, res) => {
    const rule = await webhookRule(req, res);
    if (!rule) return;
    const connection = await webhookConnectionForRule(rule.id);
    if (!connection) {
      return res.status(404).json({
        success: false,
        error: 'This automation has no URL. Rotate the URL to make one.',
        code: 'webhook_missing',
      });
    }
    const data: WebhookConnectionSummary = {
      connectionId: connection.id,
      ruleId: connection.ruleId,
      urlPrefix: webhookUrlPrefix(req, connection.id),
      createdAt: connection.createdAt.toISOString(),
      rotatedAt: connection.rotatedAt ? connection.rotatedAt.toISOString() : null,
      lastDeliveryAt: connection.lastDeliveryAt ? connection.lastDeliveryAt.toISOString() : null,
    };
    res.json({ success: true, data } as ApiResponse<WebhookConnectionSummary>);
  });

  router.post('/:id/webhook/rotate', async (req, res) => {
    const rule = await webhookRule(req, res);
    if (!rule) return;
    const rotated = await rotateWebhookConnection(rule.workspaceId, rule.id, assertUser(req).id);
    captureWorkspaceEvent(rule.workspaceId, 'webhook_url_rotated', { workflow_id: rule.id });
    const data: WebhookSecretReveal = {
      connectionId: rotated.connectionId,
      url: webhookUrl(req, rotated.connectionId, rotated.secrets.token),
      signingSecret: rotated.secrets.signingSecret,
    };
    res.json({ success: true, data } as ApiResponse<WebhookSecretReveal>);
  });

  router.get('/:id/deliveries', async (req, res) => {
    const rule = await webhookRule(req, res);
    if (!rule) return;
    const connection = await webhookConnectionForRule(rule.id);
    if (!connection) return res.json({ success: true, data: [] } as ApiResponse<InboundDeliverySummary[]>);
    const asked = Number(req.query.limit);
    const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_PAGE) : DEFAULT_PAGE;
    const data = await listDeliveries(connection.id, { limit, cursor: (req.query.cursor as string) || null });
    res.json({ success: true, data } as ApiResponse<InboundDeliverySummary[]>);
  });

  router.get('/:id/deliveries/:deliveryId', async (req, res) => {
    const rule = await webhookRule(req, res);
    if (!rule) return;
    const connection = await webhookConnectionForRule(rule.id);
    const data = connection ? await getDelivery(connection.id, String(req.params.deliveryId)) : null;
    if (!data) return res.status(404).json({ success: false, error: 'Delivery not found' });
    res.json({ success: true, data } as ApiResponse<InboundDelivery>);
  });

  router.post('/:id/deliveries/:deliveryId/replay', async (req, res) => {
    const rule = await webhookRule(req, res);
    if (!rule) return;
    const connection = await webhookConnectionForRule(rule.id);
    const replayed = connection ? await replayDelivery(connection.id, String(req.params.deliveryId)) : null;
    if (!connection || !replayed) return res.status(404).json({ success: false, error: 'Delivery not found' });
    scheduleProcessing(replayed.id);
    captureWorkspaceEvent(rule.workspaceId, 'webhook_delivery_replayed', { workflow_id: rule.id });
    const data = await deliverySummary(connection.id, replayed.id);
    res.json({ success: true, data } as ApiResponse<InboundDeliverySummary | null>);
  });

  return router;
}
