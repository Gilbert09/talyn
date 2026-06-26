import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { eq } from 'drizzle-orm';
import { setupRoutes } from './routes/index.js';
import { setupWebSocket } from './services/websocket.js';
import { initWsBus, shutdownWsBus } from './services/wsBus.js';
import { closeRedis } from './services/redis.js';
import { initWebhookIndex } from './services/webhookIndex.js';
import { webhookHeadIndex } from './services/webhookHeadIndex.js';
import { checkCountCoalescer } from './services/checkCounts.js';
import { webhookWorker } from './services/webhookWorker.js';
import { prReconcileSweep } from './services/prReconcileSweep.js';
import { handleGithubWebhook } from './routes/webhooks.js';
import { initDatabase } from './db/index.js';
import { getDbClient, closeDbClient } from './db/client.js';
import { environments as environmentsTable } from './db/schema.js';
import { taskQueueService } from './services/taskQueue.js';
import { githubService } from './services/github.js';
import { prMonitorService } from './services/prMonitor.js';
import { postHogCodeStreamer } from './services/posthogCode/streamer.js';
import { registerCloudProvider } from './services/cloudProviders/registry.js';
import { postHogCodeProvider } from './services/cloudProviders/posthog/provider.js';
import { claudeCodeProvider } from './services/cloudProviders/claude/provider.js';
import { cloudTaskPoller } from './services/cloudProviders/poller.js';
import { prAutoMergeWatcher } from './services/prAutoMergeWatcher.js';
import { mergeQueueProcessor } from './services/mergeQueueProcessor.js';

const PORT = process.env.PORT || 4747;

async function main() {
  console.log('Starting FastOwl backend...');

  // Initialize database + run migrations. Must complete before services
  // read any state.
  console.log('Initializing database...');
  await initDatabase();

  // Register cloud task providers before any service that dispatches or
  // polls them. PostHog Code + Claude Code (Managed Agents) today; Codex
  // slots in here with no other changes (see docs/CLOUD_PROVIDERS.md).
  registerCloudProvider(postHogCodeProvider);
  registerCloudProvider(claudeCodeProvider);

  // Initialize services. Each init is idempotent and DB-aware.
  console.log('Initializing services...');
  await taskQueueService.init();
  await githubService.init();
  await prMonitorService.init();
  cloudTaskPoller.init();
  prAutoMergeWatcher.init();
  mergeQueueProcessor.init();

  // Webhook pipeline: prime the watch index, start the Redis Stream worker, and
  // arm the low-frequency reconcile sweep. Worker is inert without REDIS_URL.
  await initWebhookIndex().catch((err) => console.error('webhook index init failed:', err));
  await webhookWorker.init();
  // Reseed the Redis head-SHA index that lets the receiver drop CI checks for
  // commits no tracked PR head points at. Inert without REDIS_URL.
  await webhookHeadIndex.init().catch((err) => console.error('webhook head index init failed:', err));
  prReconcileSweep.init();

  // Mark cloud-provider env markers connected at boot (they have no daemon
  // to dial in — they're a credential-backed delegation marker).
  await markCloudEnvironmentsConnected();

  const app = express();
  // Only real browser origins need CORS. Desktop/CLI/MCP clients send no
  // Origin header (or `null`), so they're always allowed. Env-override
  // `ALLOWED_ORIGINS` is a comma-separated allowlist — keep it empty in
  // production if nothing legitimately runs in a browser against this API.
  // Loopback origins (localhost / 127.0.0.1 on any port) are accepted
  // unconditionally — the dev renderer on webpack-dev-server uses them,
  // and a request from 127.0.0.1 already implies code running on the
  // same host, which has other routes to the backend anyway.
  const originAllowlist = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
  // Single source of truth for "may this origin talk to us", shared by the
  // REST CORS gate and the WebSocket upgrade. A missing Origin is allowed —
  // native clients (the desktop app's main process, the CLI) send none; a
  // present Origin must be loopback (dev renderer) or explicitly allowlisted.
  const isOriginAllowed = (origin: string | undefined): boolean =>
    !origin || LOOPBACK_ORIGIN.test(origin) || originAllowlist.includes(origin);
  // The packaged desktop app's renderer loads from file://, so — unlike a
  // truly native client — its WebSocket handshake DOES carry an Origin, which
  // Chromium reports as the opaque `null` (or a `file://` URL). Recognise the
  // first-party desktop client so its WS upgrade isn't rejected as foreign.
  const isDesktopOrigin = (origin: string | undefined): boolean =>
    origin === 'null' || (origin?.startsWith('file://') ?? false);
  app.use(
    cors({
      origin(origin, cb) {
        if (isOriginAllowed(origin)) return cb(null, true);
        return cb(new Error(`Origin not allowed: ${origin}`));
      },
      credentials: true,
    })
  );
  // GitHub webhook receiver. MUST be mounted before express.json so the handler
  // gets the raw body for HMAC verification (signature is over the exact bytes).
  // Public — no auth header; the HMAC IS the auth. Kept tiny + fast: verify,
  // filter, enqueue, 202.
  app.post(
    '/api/v1/webhooks/github',
    express.raw({ type: () => true, limit: '5mb' }),
    (req, res) => {
      void handleGithubWebhook(req, res);
    }
  );

  // 2mb (vs the 100kb default) leaves comfortable room for inline
  // workspace-logo image uploads; the per-logo cap in the workspaces route is
  // the real guard.
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        taskQueue: 'ready',
        cloudPoller: 'ready',
        prMonitor: 'ready',
      },
    });
  });

  setupRoutes(app);

  const server = createServer(app);

  // Single user-facing WS server on `/ws`. Uses `noServer: true` + a
  // manual upgrade router so a stray non-`/ws` upgrade is cleanly closed
  // instead of crashing the ws library's auto-attached listener.
  const wss = new WebSocketServer({ noServer: true });
  setupWebSocket(wss);

  // Cross-replica WebSocket fan-out over Redis Pub/Sub. Inert (single-process
  // delivery only) when REDIS_URL is unset. Started after setupWebSocket so the
  // local-delivery callback is registered before the first remote message.
  initWsBus();

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    // Reject cross-site WebSocket hijacking: a browser page on a foreign
    // origin can open a WS (no CORS preflight on upgrades), so we apply the
    // same origin gate as REST — plus the desktop app's file:// origin.
    // This is defence-in-depth only: the connection is useless until it
    // sends a valid JWT in its first frame (see services/websocket.ts), so
    // an unrecognised origin that slips through still gets nothing.
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin) && !isDesktopOrigin(origin)) {
      socket.destroy();
      return;
    }
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, () => {
    console.log(`FastOwl backend running on http://localhost:${PORT}`);
    console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
    console.log(`Health check at http://localhost:${PORT}/health`);
  });

  const shutdown = async () => {
    console.log('Shutting down...');
    cloudTaskPoller.shutdown();
    prAutoMergeWatcher.shutdown();
    mergeQueueProcessor.shutdown();
    postHogCodeStreamer.shutdownAll();
    prMonitorService.shutdown();
    taskQueueService.shutdown();
    webhookWorker.shutdown();
    webhookHeadIndex.shutdown();
    // Flush any buffered check counts so an in-flight CI burst isn't lost on a
    // graceful restart (the sweep would re-derive it, but this avoids the gap).
    await checkCountCoalescer.flushAllNow().catch(() => undefined);
    prReconcileSweep.shutdown();

    server.close(async () => {
      await shutdownWsBus();
      await closeRedis();
      await closeDbClient();
      console.log('Goodbye!');
      process.exit(0);
    });

    setTimeout(() => {
      console.log('Forcing exit...');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
}

/**
 * Cloud env markers carry no daemon — they're synthetically "connected"
 * for as long as their credentials exist. Flip any that aren't already.
 */
async function markCloudEnvironmentsConnected() {
  const db = getDbClient();
  const envs = await db.select().from(environmentsTable);
  for (const env of envs) {
    if (env.status !== 'connected') {
      await db
        .update(environmentsTable)
        .set({ status: 'connected' })
        .where(eq(environmentsTable.id, env.id));
    }
  }
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
