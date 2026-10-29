import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { slackEvents, slackInstallations, slackOauthStates, slackUserLinks } from '../../db/schema.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { debugBus } from '../debugBus.js';
import { TickGuard } from '../tickGuard.js';
import { slackSigningSecret } from './config.js';
import { removeTeam } from './store.js';
import { onAppMention, onMessage, onReactionAdded } from './triggers.js';

/**
 * Slack Events API: verify, store, answer 200, process later.
 *
 * Slack wants a 200 within 3 seconds and retries otherwise, and during a
 * deploy two replicas can both receive a delivery. So the receiver only
 * verifies and inserts; `event_id` as the primary key makes the insert the
 * idempotency. Processing runs right after the response on the replica whose
 * insert won, and the sweep below picks up anything a crash left behind.
 */

/** Slack's own replay window for a signed request. */
const MAX_SKEW_SECONDS = 5 * 60;

export type SlackSignatureResult = 'valid' | 'invalid' | 'missing' | 'stale';

/**
 * Verify `X-Slack-Signature` (v0): HMAC-SHA256 of `v0:{timestamp}:{raw body}`
 * with the signing secret, compared in constant time. A timestamp more than
 * five minutes from now, in either direction, is refused before the HMAC.
 */
export function verifySlackSignature(
  rawBody: Buffer,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): SlackSignatureResult {
  if (!timestampHeader || !signatureHeader) return 'missing';
  if (!/^\d+$/.test(timestampHeader)) return 'invalid';
  if (Math.abs(nowSeconds - Number(timestampHeader)) > MAX_SKEW_SECONDS) return 'stale';
  const expected =
    'v0=' +
    createHmac('sha256', secret)
      .update(`v0:${timestampHeader}:`)
      .update(rawBody)
      .digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return 'invalid';
  return timingSafeEqual(a, b) ? 'valid' : 'invalid';
}

/** The parts of an `event_callback` envelope this module reads. */
interface EventEnvelope {
  type?: unknown;
  challenge?: unknown;
  event_id?: unknown;
  team_id?: unknown;
  event?: { type?: unknown } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Store one `event_callback`. Returns true when THIS call inserted it, which
 * is what decides who processes it right away. A retry or the other replica
 * gets false.
 */
export async function ingestSlackEvent(body: EventEnvelope): Promise<{ eventId: string; inserted: boolean } | null> {
  const eventId = typeof body.event_id === 'string' ? body.event_id : '';
  const eventType = typeof body.event?.type === 'string' ? body.event.type : '';
  if (!eventId || !eventType) return null;
  // The deprecated verification token is a credential; it never needs storing.
  const { token: _token, ...payload } = body;
  const rows = await getPoolDbClient()
    .insert(slackEvents)
    .values({
      eventId,
      teamId: typeof body.team_id === 'string' ? body.team_id : null,
      eventType,
      payload,
    })
    .onConflictDoNothing({ target: slackEvents.eventId })
    .returning({ eventId: slackEvents.eventId });
  return { eventId, inserted: rows.length > 0 };
}

export async function handleSlackWebhook(req: Request, res: Response): Promise<void> {
  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const secret = slackSigningSecret();
  if (!secret) {
    debugBus.recordEvent({ service: 'slack_events', action: 'refused', ok: false, summary: 'SLACK_SIGNING_SECRET is not set' });
    res.status(500).json({ error: 'slack signing secret not configured' });
    return;
  }
  const signature = verifySlackSignature(
    rawBody,
    req.headers['x-slack-request-timestamp'] as string | undefined,
    req.headers['x-slack-signature'] as string | undefined,
    secret
  );
  if (signature !== 'valid') {
    debugBus.recordEvent({
      service: 'slack_events',
      action: 'refused',
      ok: false,
      summary: `signature ${signature}`,
    });
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  let body: EventEnvelope;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as EventEnvelope;
  } catch {
    res.status(400).json({ error: 'invalid json' });
    return;
  }

  if (body.type === 'url_verification') {
    res.status(200).json({ challenge: typeof body.challenge === 'string' ? body.challenge : '' });
    return;
  }
  if (body.type !== 'event_callback') {
    // Signed but not something we act on (e.g. app_rate_limited). Acknowledge.
    res.status(200).end();
    return;
  }

  let stored: Awaited<ReturnType<typeof ingestSlackEvent>>;
  try {
    stored = await ingestSlackEvent(body);
  } catch (err) {
    // Not stored, so let Slack retry.
    console.error('[slack] could not store event:', err);
    res.status(500).json({ error: 'could not store event' });
    return;
  }
  res.status(200).end();
  if (!stored) return;
  debugBus.recordEvent({
    service: 'slack_events',
    action: 'received',
    summary: `${typeof body.event?.type === 'string' ? body.event.type : '?'} ${stored.eventId}${stored.inserted ? '' : ' (duplicate)'}`,
    meta: { duplicate: !stored.inserted },
  });
  if (stored.inserted) {
    setImmediate(() => {
      void processSlackEvent(stored.eventId).catch((err) =>
        console.error(`[slack] processing ${stored.eventId} failed:`, err)
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export type SlackEventOutcome = 'handled' | 'ignored';

export interface SlackEventContext {
  eventId: string;
  teamId: string | null;
  /** The whole stored envelope (without the verification token). */
  payload: Record<string, unknown>;
  /** `payload.event`, for convenience. */
  event: Record<string, unknown>;
  /** This is the last try: a handler that fails now is settled `failed`. */
  finalAttempt: boolean;
}

type SlackEventHandler = (ctx: SlackEventContext) => Promise<SlackEventOutcome>;

const ignore: SlackEventHandler = async () => 'ignored';

async function onAppUninstalled(ctx: SlackEventContext): Promise<SlackEventOutcome> {
  if (!ctx.teamId) return 'ignored';
  await removeTeam(ctx.teamId);
  return 'handled';
}

/**
 * `tokens_revoked`: `tokens.bot` lists bot user ids whose token died, which
 * ends the installation; `tokens.oauth` lists user ids whose own grant was
 * revoked, which ends their link.
 */
async function onTokensRevoked(ctx: SlackEventContext): Promise<SlackEventOutcome> {
  if (!ctx.teamId) return 'ignored';
  const tokens = (ctx.event.tokens ?? {}) as { oauth?: unknown; bot?: unknown };
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const bots = ids(tokens.bot);
  const users = ids(tokens.oauth);
  const db = getPoolDbClient();
  if (bots.length > 0) {
    const install = await db
      .select({ botUserId: slackInstallations.botUserId })
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, ctx.teamId))
      .limit(1);
    if (install[0] && bots.includes(install[0].botUserId)) await removeTeam(ctx.teamId);
  }
  if (users.length > 0) {
    await db
      .delete(slackUserLinks)
      .where(and(eq(slackUserLinks.teamId, ctx.teamId), inArray(slackUserLinks.slackUserId, users)));
  }
  return bots.length > 0 || users.length > 0 ? 'handled' : 'ignored';
}

/**
 * What each event type does. An absent type is stored and marked `ignored`.
 * The three session triggers are in `triggers.ts`.
 */
export const SLACK_EVENT_HANDLERS: Record<string, SlackEventHandler> = {
  app_uninstalled: onAppUninstalled,
  tokens_revoked: onTokensRevoked,
  app_mention: onAppMention,
  reaction_added: onReactionAdded,
  message: onMessage,
};

/**
 * A claim older than this is presumed dead (a crash mid-processing), and a
 * second replica may take the event. Longer than one trigger takes: a few
 * Slack reads, at most two code searches and a create, each with its own
 * 10-30 s timeout.
 */
const CLAIM_TIMEOUT_MS = 2 * 60_000;
/** After this many failed tries an event is settled `failed` and stops retrying. */
export const MAX_EVENT_ATTEMPTS = 5;

/**
 * Process one stored event. The conditional UPDATE is a claim, so two
 * replicas (or the inline path and the sweep) cannot both run a handler.
 */
export async function processSlackEvent(eventId: string): Promise<SlackEventOutcome | 'failed' | 'skipped'> {
  const db = getPoolDbClient();
  const now = new Date();
  const claimed = await db
    .update(slackEvents)
    .set({ claimedAt: now, attempts: sql`${slackEvents.attempts} + 1` })
    .where(
      and(
        eq(slackEvents.eventId, eventId),
        isNull(slackEvents.processedAt),
        or(isNull(slackEvents.claimedAt), lt(slackEvents.claimedAt, new Date(now.getTime() - CLAIM_TIMEOUT_MS)))
      )
    )
    .returning({
      teamId: slackEvents.teamId,
      eventType: slackEvents.eventType,
      payload: slackEvents.payload,
      attempts: slackEvents.attempts,
    });
  const row = claimed[0];
  if (!row) return 'skipped';

  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const handler = SLACK_EVENT_HANDLERS[row.eventType] ?? ignore;
  try {
    // No request and no owner scope: a handler's queries go to the pool.
    const outcome = await runWithoutScope(() =>
      handler({
        eventId,
        teamId: row.teamId,
        payload,
        event: (payload.event ?? {}) as Record<string, unknown>,
        finalAttempt: row.attempts >= MAX_EVENT_ATTEMPTS,
      })
    );
    await db
      .update(slackEvents)
      .set({ processedAt: new Date(), outcome, error: null })
      .where(eq(slackEvents.eventId, eventId));
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const giveUp = row.attempts >= MAX_EVENT_ATTEMPTS;
    await db
      .update(slackEvents)
      .set(
        giveUp
          ? { processedAt: new Date(), outcome: 'failed', error: message.slice(0, 1000) }
          : { claimedAt: null, error: message.slice(0, 1000) }
      )
      .where(eq(slackEvents.eventId, eventId));
    debugBus.recordEvent({
      service: 'slack_events',
      action: 'failed',
      ok: false,
      summary: `${row.eventType} ${eventId} attempt ${row.attempts}${giveUp ? ' (gave up)' : ''}`,
      error: err,
    });
    return 'failed';
  }
}


// ---------------------------------------------------------------------------
// Sweep: retry what a crash left behind, and delete old rows
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 60_000;
/** Older than this and still unprocessed means the inline path did not finish. */
const PENDING_GRACE_MS = 60_000;
const SWEEP_BATCH = 50;
/** Processed events are kept this long for debugging, then deleted. */
export const PROCESSED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const CLEANUP_EVERY_MS = 60 * 60_000;

class SlackEventSweep {
  private timer: NodeJS.Timeout | null = null;
  private guard = new TickGuard('slack_event_sweep', 5 * 60_000);
  private lastCleanupAt = 0;

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      'slack_event_sweep',
      SWEEP_INTERVAL_MS,
      'Slack events: retries any delivery that was stored but not processed (a crash or deploy mid-way), and hourly deletes processed events older than 7 days and expired sign-in states.'
    );
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests. */
  async tick(now: Date = new Date()): Promise<{ retried: number; deleted: number }> {
    if (!this.guard.tryBegin()) return { retried: 0, deleted: 0 };
    const startedAt = Date.now();
    try {
      const outcome = await guardCrossReplica('slack_event_sweep:tick', () => this.run(now), {
        maxHoldMs: this.guard.maxMs,
      });
      debugBus.pollerTick('slack_event_sweep', { durationMs: Date.now() - startedAt, ok: true });
      return outcome.result ?? { retried: 0, deleted: 0 };
    } catch (err) {
      debugBus.pollerTick('slack_event_sweep', { durationMs: Date.now() - startedAt, ok: false, error: err });
      return { retried: 0, deleted: 0 };
    } finally {
      this.guard.end();
    }
  }

  private async run(now: Date): Promise<{ retried: number; deleted: number }> {
    const db = getPoolDbClient();
    const due = await db
      .select({ eventId: slackEvents.eventId })
      .from(slackEvents)
      .where(and(isNull(slackEvents.processedAt), lt(slackEvents.receivedAt, new Date(now.getTime() - PENDING_GRACE_MS))))
      .orderBy(slackEvents.receivedAt)
      .limit(SWEEP_BATCH);
    let retried = 0;
    for (const { eventId } of due) {
      if ((await processSlackEvent(eventId)) !== 'skipped') retried += 1;
    }

    let deleted = 0;
    if (now.getTime() - this.lastCleanupAt >= CLEANUP_EVERY_MS) {
      this.lastCleanupAt = now.getTime();
      const gone = await db
        .delete(slackEvents)
        .where(lt(slackEvents.processedAt, new Date(now.getTime() - PROCESSED_RETENTION_MS)))
        .returning({ eventId: slackEvents.eventId });
      deleted = gone.length;
      await db.delete(slackOauthStates).where(lt(slackOauthStates.expiresAt, now));
    }
    return { retried, deleted };
  }

  /** Tests: run the hourly cleanup on the next tick. */
  resetForTests(): void {
    this.lastCleanupAt = 0;
  }
}

export const slackEventSweep = new SlackEventSweep();
