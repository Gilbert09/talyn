import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { eq } from 'drizzle-orm';
import { setupRoutes } from './routes/index.js';
import { setupWebSocket } from './services/websocket.js';
import { initDatabase } from './db/index.js';
import { getDbClient, closeDbClient } from './db/client.js';
import { environments as environmentsTable } from './db/schema.js';
import { taskQueueService } from './services/taskQueue.js';
import { githubService } from './services/github.js';
import { prMonitorService } from './services/prMonitor.js';
import { notificationsPoller } from './services/notificationsPoller.js';
import { postHogCodeStreamer } from './services/posthogCode/streamer.js';
import { registerCloudProvider } from './services/cloudProviders/registry.js';
import { postHogCodeProvider } from './services/cloudProviders/posthog/provider.js';
import { cloudTaskPoller } from './services/cloudProviders/poller.js';

const PORT = process.env.PORT || 4747;

async function main() {
  console.log('Starting FastOwl backend...');

  // Initialize database + run migrations. Must complete before services
  // read any state.
  console.log('Initializing database...');
  await initDatabase();

  // Register cloud task providers before any service that dispatches or
  // polls them. One provider today (PostHog Code); Codex/Claude slot in
  // here with no other changes (see docs/CLOUD_PROVIDERS.md).
  registerCloudProvider(postHogCodeProvider);

  // Initialize services. Each init is idempotent and DB-aware.
  console.log('Initializing services...');
  await taskQueueService.init();
  await githubService.init();
  await prMonitorService.init();
  notificationsPoller.init();
  cloudTaskPoller.init();

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
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        if (LOOPBACK_ORIGIN.test(origin)) return cb(null, true);
        if (originAllowlist.includes(origin)) return cb(null, true);
        return cb(new Error(`Origin not allowed: ${origin}`));
      },
      credentials: true,
    })
  );
  app.use(express.json());

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

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
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
    postHogCodeStreamer.shutdownAll();
    notificationsPoller.shutdown();
    prMonitorService.shutdown();
    taskQueueService.shutdown();

    server.close(async () => {
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
