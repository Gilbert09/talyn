import { Router } from 'express';
import type { DebugCategory } from '@fastowl/shared';
import { debugBus } from '../services/debugBus.js';

const CATEGORIES: ReadonlySet<string> = new Set([
  'http',
  'polling',
  'websocket',
  'event',
  'error',
]);

/**
 * Developer-only debug surface. Not workspace-scoped — it exposes the
 * backend's own internals (requests, poll ticks, WS traffic), which are a
 * single global view. Auth is applied by the parent `requireAuth` middleware;
 * the desktop Debug panel is additionally gated behind a Settings toggle.
 */
export function debugRoutes(): Router {
  const router = Router();

  // Buffered events — backfill for a panel that opens after activity started.
  router.get('/events', (req, res) => {
    const categoryRaw = req.query.category as string | undefined;
    const category =
      categoryRaw && CATEGORIES.has(categoryRaw)
        ? (categoryRaw as DebugCategory)
        : undefined;
    const service = (req.query.service as string | undefined) || undefined;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

    const events = debugBus.getEvents({ category, service, limit });
    res.json({ success: true, data: events });
  });

  // Point-in-time view: poller states, counters, WS client count.
  router.get('/snapshot', (_req, res) => {
    res.json({ success: true, data: debugBus.snapshot() });
  });

  // Drop the buffer (and lifetime counters) for a clean view.
  router.delete('/events', (_req, res) => {
    debugBus.clear();
    res.json({ success: true, data: { cleared: true } });
  });

  return router;
}
