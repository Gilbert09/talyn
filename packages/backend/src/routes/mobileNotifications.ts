import { Router, type RequestHandler } from 'express';
import { ZodError } from 'zod';
import { assertUser } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { heartbeatInput, identifierInput, installationInput, preferencesInput } from '../services/mobileNotifications/validation.js';
import { heartbeatMobileInstallation, MobileNotificationError, readMobilePreferences, registerMobileInstallation,
  removeMobileInstallation, resolveMobileNotification, saveMobilePreferences } from '../services/mobileNotifications/store.js';

export function mobileNotificationRoutes(): Router {
  const router = Router();
  const writes = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => assertUser(req).id });
  const handle = (fn: (req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler => async (req, res) => {
    try { res.json({ success: true, data: await fn(req) }); }
    catch (error) {
      if (error instanceof ZodError) { res.status(400).json({ success: false, error: 'Invalid notification request.', code: 'invalid_notification_request' }); return; }
      if (error instanceof MobileNotificationError) { res.status(error.status).json({ success: false, error: error.message, code: error.code }); return; }
      // Never send database parameters or provider response text to logs or clients.
      res.status(503).json({ success: false, error: 'Notifications are unavailable.', code: 'push_unavailable' });
    }
  };
  router.post('/installations', writes, handle((req) => registerMobileInstallation(assertUser(req).id, installationInput.parse(req.body))));
  router.patch('/installations/:installationId', writes, handle((req) => heartbeatMobileInstallation(assertUser(req).id,
    identifierInput.parse(req.params.installationId), heartbeatInput.parse(req.body))));
  router.delete('/installations/:installationId', writes, handle((req) => removeMobileInstallation(assertUser(req).id, identifierInput.parse(req.params.installationId))));
  router.get('/notification-preferences', handle((req) => readMobilePreferences(assertUser(req).id, identifierInput.parse(req.query.workspaceId))));
  router.put('/notification-preferences', writes, handle((req) => saveMobilePreferences(assertUser(req).id, preferencesInput.parse(req.body))));
  router.get('/notifications/:eventId', handle((req) => resolveMobileNotification(assertUser(req).id, identifierInput.parse(req.params.eventId))));
  return router;
}
