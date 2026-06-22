import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { getRedis, isRedisEnabled } from '../services/redis.js';
import { isRepoWatchedSync } from '../services/webhookIndex.js';
import { shouldDropByHeadSha, noteHeadSha } from '../services/webhookHeadIndex.js';
import { WEBHOOK_STREAM, whTrace, type WebhookDelivery } from '../services/webhookWorker.js';
import { debugBus } from '../services/debugBus.js';

/**
 * GitHub webhook receiver. The whole point is to be FAST and do no I/O that
 * can block: verify the HMAC, drop anything for a repo nobody watches, push the
 * delivery onto the Redis Stream, and return 202. All real work happens later
 * in webhookWorker on whichever replica pulls it.
 */

const SIGNATURE_PREFIX = 'sha256=';
/**
 * Cap stream length so a backlog can't grow without bound. `~` makes the trim
 * approximate — Redis keeps *at least* this many, evicting the oldest entries
 * in whole nodes — so a sustained backlog drops the oldest unprocessed
 * deliveries (the poll/reconcile loop backfills anything trimmed). A backlog
 * only forms if the worker can't keep up; under normal load the stream stays
 * near-empty, so this is a safety valve, not a steady-state limit.
 *
 * Default 50k (~5× the old 10k). Override with WEBHOOK_STREAM_MAXLEN — sized to
 * your Redis memory, since each entry holds a full webhook payload (~10-30KB).
 * A non-positive / unparseable value falls back to the default rather than
 * disabling the cap.
 */
const STREAM_MAXLEN = (() => {
  const fromEnv = Number(process.env.WEBHOOK_STREAM_MAXLEN);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 50_000;
})();

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

/** The head SHA a `check_run`/`check_suite` payload is for (the dedupe/match key). */
function checkHeadSha(eventType: string, payload: Record<string, unknown>): string | undefined {
  const node = (eventType === 'check_run' ? payload.check_run : payload.check_suite) as
    | { head_sha?: unknown }
    | undefined;
  return typeof node?.head_sha === 'string' ? node.head_sha : undefined;
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

  // Note a live PR head BEFORE we might drop checks for it: a freshly opened /
  // force-pushed PR's head must be forwardable the instant its event arrives,
  // even before the worker writes the row or the next reseed runs. Cheap Redis
  // SADD into a short-TTL set; awaited so the head is recorded before we ack.
  if (eventType === 'pull_request') {
    const headSha = (payload.pull_request as { head?: { sha?: string } } | undefined)?.head?.sha;
    await noteHeadSha(repoFullName, headSha);
  }

  // The firehose: drop `check_run`/`check_suite` whose commit is not the head of
  // any tracked OPEN PR — they could never change a pill count, and this spares
  // both the stream slot and the ~1-2 DB round-trips a no-op would have cost.
  // Fails OPEN (never drops) when the repo isn't authoritatively seeded yet.
  if (eventType === 'check_run' || eventType === 'check_suite') {
    const headSha = checkHeadSha(eventType, payload);
    if (await shouldDropByHeadSha(repoFullName, headSha)) {
      whTrace(
        `receiver DROP head_sha_not_tracked ${eventType} ${repoFullName} ` +
          `sha=${headSha?.slice(0, 7) ?? '-'} delivery=${deliveryId}`,
      );
      debugBus.recordWebhook({
        action: 'received',
        eventType,
        ghAction,
        repo: repoFullName,
        signature,
        ok: true,
        queued: false,
        dropReason: 'head_sha_not_tracked',
      });
      res.status(202).json({ ok: true, dropped: 'head_sha_not_tracked' });
      return;
    }
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
