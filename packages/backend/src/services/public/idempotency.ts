import { createHash } from 'crypto';
import { and, eq, lt } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { apiIdempotencyKeys as keysTable } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { PublicApiError } from './errors.js';

/**
 * `Idempotency-Key` for the `/v1` creates. A retried `POST /v1/sessions`
 * without it boots a second microVM; with it, the retry gets the first answer.
 *
 * The rules, in the order the code applies them:
 *  - The key is per TOKEN. Two tokens can use the same key.
 *  - The first request with a key claims it with an INSERT; the unique key
 *    `(token_id, key)` decides between two concurrent first requests.
 *  - Only a SUCCESS is saved. An error releases the key, so the client can
 *    fix the cause and retry with the same key. An error means the create
 *    did not happen, so there is nothing to protect.
 *  - The same key with a different method, path or body is 409
 *    `idempotency_key_reused`: the client has a bug, and replaying the old
 *    answer would hide it.
 *  - A key whose first request is still running is 409
 *    `idempotency_in_progress`.
 *  - Keys expire after 24 hours.
 */

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * A claim still `in_progress` after this belongs to a process that died (a
 * deploy) before it answered. A create handler answers in seconds, so a retry
 * may take such a key over.
 */
export const IDEMPOTENCY_ABANDONED_MS = 15 * 60 * 1000;
const MAX_KEY_LENGTH = 255;
const KEY_PATTERN = /^[\x21-\x7e]+$/;

export type IdempotencyClaim =
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'proceed'; complete(status: number, body: unknown): Promise<void>; release(): Promise<void> };

export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(JSON.stringify([method.toUpperCase(), path, body ?? null])).digest('hex');
}

export function validateIdempotencyKey(raw: string): string {
  const key = raw.trim();
  if (!key || key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) {
    throw new PublicApiError(
      400,
      'invalid_idempotency_key',
      `The ${IDEMPOTENCY_HEADER} header must be 1 to ${MAX_KEY_LENGTH} printable ASCII characters with no spaces.`,
      { param: IDEMPOTENCY_HEADER },
    );
  }
  return key;
}

async function insertClaim(tokenId: string, key: string, requestHash: string, now: Date): Promise<boolean> {
  const inserted = await getPoolDbClient()
    .insert(keysTable)
    .values({ tokenId, key, requestHash, status: 'in_progress', createdAt: now })
    .onConflictDoNothing()
    .returning({ key: keysTable.key });
  return inserted.length > 0;
}

function proceed(tokenId: string, key: string): IdempotencyClaim {
  const where = and(eq(keysTable.tokenId, tokenId), eq(keysTable.key, key));
  return {
    kind: 'proceed',
    async complete(status, body) {
      await getPoolDbClient()
        .update(keysTable)
        .set({ status: 'completed', responseStatus: status, responseBody: body as Record<string, unknown> })
        .where(where);
    },
    async release() {
      await getPoolDbClient().delete(keysTable).where(where);
    },
  };
}

/**
 * Claim `key` for this request, or say what the first request with it got.
 * Throws the 409s.
 */
export async function claimIdempotencyKey(
  tokenId: string,
  key: string,
  requestHash: string,
  now = new Date(),
): Promise<IdempotencyClaim> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await insertClaim(tokenId, key, requestHash, now)) return proceed(tokenId, key);

    const db = getPoolDbClient();
    const [row] = await db
      .select({
        requestHash: keysTable.requestHash,
        status: keysTable.status,
        responseStatus: keysTable.responseStatus,
        responseBody: keysTable.responseBody,
        createdAt: keysTable.createdAt,
      })
      .from(keysTable)
      .where(and(eq(keysTable.tokenId, tokenId), eq(keysTable.key, key)))
      .limit(1);
    // Released between the insert and the read: claim it again.
    if (!row) continue;

    const age = now.getTime() - row.createdAt.getTime();
    if (age >= IDEMPOTENCY_TTL_MS) {
      // Expired and not swept yet. Delete only the row we read, then claim again.
      await db
        .delete(keysTable)
        .where(and(eq(keysTable.tokenId, tokenId), eq(keysTable.key, key), eq(keysTable.createdAt, row.createdAt)));
      continue;
    }
    if (row.requestHash !== requestHash) {
      throw new PublicApiError(
        409,
        'idempotency_key_reused',
        `This ${IDEMPOTENCY_HEADER} was used with a different request. Use a new key for a new request.`,
        { param: IDEMPOTENCY_HEADER },
      );
    }
    if (row.status === 'completed') {
      return { kind: 'replay', status: row.responseStatus ?? 200, body: row.responseBody };
    }
    if (age >= IDEMPOTENCY_ABANDONED_MS) {
      const taken = await db
        .update(keysTable)
        .set({ createdAt: now })
        .where(
          and(
            eq(keysTable.tokenId, tokenId),
            eq(keysTable.key, key),
            eq(keysTable.status, 'in_progress'),
            eq(keysTable.createdAt, row.createdAt),
          ),
        )
        .returning({ key: keysTable.key });
      if (taken.length > 0) return proceed(tokenId, key);
    }
    throw new PublicApiError(
      409,
      'idempotency_in_progress',
      `A request with this ${IDEMPOTENCY_HEADER} is still running. Retry when it has finished.`,
      { param: IDEMPOTENCY_HEADER },
    );
  }
  throw new PublicApiError(
    409,
    'idempotency_in_progress',
    `A request with this ${IDEMPOTENCY_HEADER} is still running. Retry when it has finished.`,
    { param: IDEMPOTENCY_HEADER },
  );
}

/** Delete expired keys. Run by the sweep below; a read also deletes an expired key it finds. */
export async function deleteExpiredIdempotencyKeys(now = new Date()): Promise<number> {
  const deleted = await getPoolDbClient()
    .delete(keysTable)
    .where(lt(keysTable.createdAt, new Date(now.getTime() - IDEMPOTENCY_TTL_MS)))
    .returning({ key: keysTable.key });
  return deleted.length;
}

const SWEEP_POLLER = 'public-api-idempotency-sweep';
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let sweepTimer: NodeJS.Timeout | null = null;

/**
 * Delete expired idempotency keys once an hour. Every replica runs it; the
 * DELETE is the same on each, so no lock is needed. One indexed range delete.
 */
export function startIdempotencySweep(): void {
  if (sweepTimer) return;
  debugBus.registerPoller(SWEEP_POLLER, SWEEP_INTERVAL_MS, 'Deletes public API idempotency keys older than 24 hours');
  sweepTimer = setInterval(() => {
    const started = Date.now();
    deleteExpiredIdempotencyKeys()
      .then((n) => debugBus.pollerTick(SWEEP_POLLER, { durationMs: Date.now() - started, ok: true, summary: `deleted ${n}` }))
      .catch((error) => debugBus.pollerTick(SWEEP_POLLER, { durationMs: Date.now() - started, ok: false, error }));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopIdempotencySweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
