import { Router } from 'express';
import type {
  ApiResponse,
  BillingStatus,
  CheckoutSessionResponse,
  CreateCheckoutRequest,
} from '@talyn/shared';
import { assertUser } from '../middleware/auth.js';
import { billingEnabled, buildBillingStatus } from '../services/billing/entitlements.js';
import { createCheckoutUrl, createPortalUrl } from '../services/billing/polar.js';

/**
 * Billing surface for the calling user. Mounted BEFORE the owner-scope
 * middleware (like /users): checkout/portal calls block on Polar's API, and
 * holding an owner-scoped transaction (= one pooled connection) open across
 * an external HTTP round-trip would drain the pool. Every query is
 * hard-scoped to req.user.id instead.
 */
export function billingRoutes(): Router {
  const router = Router();

  // Current plan + usage. Also the desktop's post-checkout poll target.
  router.get('/status', async (req, res) => {
    const status = await buildBillingStatus(assertUser(req).id);
    res.json({ success: true, data: status } as ApiResponse<BillingStatus>);
  });

  // Create a hosted-checkout session; the desktop opens the URL in the
  // system browser. Completion arrives via webhook → WS, not this response.
  router.post('/checkout', async (req, res) => {
    if (!billingEnabled()) {
      return res
        .status(400)
        .json({ success: false, error: 'Billing is not configured on this backend' });
    }
    const body = req.body as CreateCheckoutRequest;
    const period = body?.period === 'annual' ? 'annual' : 'monthly';
    const url = await createCheckoutUrl(assertUser(req).id, period);
    res.json({ success: true, data: { url } } as ApiResponse<CheckoutSessionResponse>);
  });

  // Authenticated customer-portal session (manage / cancel / invoices).
  router.post('/portal', async (req, res) => {
    if (!billingEnabled()) {
      return res
        .status(400)
        .json({ success: false, error: 'Billing is not configured on this backend' });
    }
    try {
      const url = await createPortalUrl(assertUser(req).id);
      res.json({ success: true, data: { url } } as ApiResponse<CheckoutSessionResponse>);
    } catch {
      // Polar has no customer for this user (never checked out) — nothing to
      // manage yet.
      res.status(400).json({
        success: false,
        error: 'No billing profile yet — subscribe first to manage your plan here.',
      });
    }
  });

  return router;
}
