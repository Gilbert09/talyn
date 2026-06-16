import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { getRedis, isRedisEnabled } from '../services/redis.js';
import { isRepoWatchedSync } from '../services/webhookIndex.js';
import { WEBHOOK_STREAM, whTrace, type WebhookDelivery } from '../services/webhookWorker.js';
import { debugBus } from '../services/debugBus.js';

/**
 * GitHub webhook receiver. The whole point is to be FAST and do no I/O that
 * can block: verify the HMAC, drop anything for a repo nobody watches, push the
 * delivery onto the Redis Stream, and return 202. All real work happens later
 * in webhookWorker on whichever replica pulls it.
 */

const SIGNATURE_PREFIX = 'sha256=';
/** Cap stream length so a backlog can't grow without bound (~ = approximate trim). */
const STREAM_MAXLEN = 10_000;

/**
 * Verify GitHub's `X-Hub-Signature-256` against the raw body. Timing-safe.
 * Returns 'valid' | 'invalid' | 'missing' so the caller can record which.
 */
export function verifyGithubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): 'valid' | 'invalid' | 'missing' {
  if (!signatureHeader) return 'missing';
  const expected = SIGNATURE_PREFIX + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return 'invalid';
  return timingSafeEqual(a, b) ? 'valid' : 'invalid';
}

export async function handleGithubWebhook(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  const eventType = String(req.headers['x-github-event'] ?? 'unknown');
  const deliveryId = String(req.headers['x-github-delivery'] ?? '');
  const secret = process.env.GITHUB_WEBHOOK_SECRET || '';

  // req.body is a Buffer here (express.raw mounted for this path).
  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

  if (!secret) {
    // Misconfiguration — never trust an unverifiable delivery.
    debugBus.recordWebhook({ action: 'received', eventType, ok: false, dropReason: 'no_secret' });
    res.status(500).json({ error: 'webhook secret not configured' });
    return;
  }

  const signature = verifyGithubSignature(rawBody, req.headers['x-hub-signature-256'] as string | undefined, secret);
  if (signature !== 'valid') {
    whTrace(`receiver DROP bad_signature ${eventType} delivery=${deliveryId}`);
    debugBus.recordWebhook({ action: 'received', eventType, ok: false, signature, dropReason: 'bad_signature' });
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  // GitHub pings the hook on creation — ack without enqueuing.
  if (eventType === 'ping') {
    debugBus.recordWebhook({ action: 'received', eventType, ok: true, signature, queued: false });
    res.status(202).json({ ok: true, pong: true });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    debugBus.recordWebhook({ action: 'received', eventType, ok: false, signature, dropReason: 'bad_json' });
    res.status(400).json({ error: 'invalid json' });
    return;
  }

  const repoFullName = (payload.repository as { full_name?: string } | undefined)?.full_name ?? '';
  whTrace(
    `receiver recv ${eventType}/${(typeof payload.action === 'string' ? payload.action : '-')} ` +
      `${repoFullName || '(no repo)'} delivery=${deliveryId}`,
  );
  const installationId = (payload.installation as { id?: number } | undefined)?.id;
  const ghAction = typeof payload.action === 'string' ? payload.action : undefined;

  // Always let installation lifecycle events through (they maintain our index +
  // allowlist even before any repo is watched). For everything else, the cheap
  // ownership filter drops repos nobody is tracking.
  const isInstallationEvent = eventType === 'installation' || eventType === 'installation_repositories';
  if (!isInstallationEvent && (!repoFullName || !isRepoWatchedSync(repoFullName))) {
    whTrace(`receiver DROP untracked_repo ${eventType} ${repoFullName || '(no repo)'} delivery=${deliveryId}`);
    debugBus.recordWebhook({
      action: 'received',
      eventType,
      ghAction,
      repo: repoFullName || undefined,
      signature,
      ok: true,
      queued: false,
      dropReason: 'untracked_repo',
    });
    res.status(202).json({ ok: true, dropped: 'untracked_repo' });
    return;
  }

  if (!isRedisEnabled()) {
    // Without Redis there's no queue to enqueue onto. Ack so GitHub doesn't
    // disable the hook; the reconcile sweep keeps data fresh meanwhile.
    debugBus.recordWebhook({ action: 'received', eventType, ghAction, repo: repoFullName, signature, ok: true, queued: false, dropReason: 'no_redis' });
    res.status(202).json({ ok: true, dropped: 'no_redis' });
    return;
  }

  const delivery: WebhookDelivery = {
    deliveryId,
    eventType,
    action: typeof payload.action === 'string' ? payload.action : undefined,
    repoFullName,
    installationId: installationId !== undefined ? String(installationId) : undefined,
    enqueuedAtMs: Date.now(),
    payload,
  };

  try {
    const redis = getRedis();
    await redis?.xadd(WEBHOOK_STREAM, 'MAXLEN', '~', String(STREAM_MAXLEN), '*', 'data', JSON.stringify(delivery));
    whTrace(`receiver QUEUED ${eventType}/${ghAction ?? '-'} ${repoFullName} delivery=${deliveryId}`);
    debugBus.recordWebhook({
      action: 'received',
      eventType,
      ghAction,
      repo: repoFullName,
      delivery: deliveryId,
      signature,
      ok: true,
      queued: true,
      durationMs: Date.now() - startedAt,
    });
    res.status(202).json({ ok: true });
  } catch (err) {
    debugBus.recordWebhook({
      action: 'received',
      eventType,
      ghAction,
      repo: repoFullName,
      delivery: deliveryId,
      signature,
      ok: false,
      dropReason: 'enqueue_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    // 500 so GitHub retries the delivery.
    res.status(500).json({ error: 'enqueue failed' });
  }
}
