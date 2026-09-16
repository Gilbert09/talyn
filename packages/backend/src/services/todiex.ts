import { fetchWithTimeout } from './httpTimeout.js';
import { debugBus } from './debugBus.js';

/**
 * Cross-product inbox (todiex).
 *
 * PostHog answers "how is the funnel doing" a day later; this answers "what
 * just happened" on a phone, in seconds. Tom runs several products and each
 * one kept its own news to itself — a signup here, a subscription there — so
 * the only way to learn a subscription had landed was to go and look. Every
 * event posted here shows in one feed across all the products and fires one
 * push notification.
 *
 * Deliberately a sibling of analytics.ts rather than a branch inside it. The
 * two have different jobs and different volumes: analytics captures ~25 event
 * types including every task dispatch, and routing that firehose at a phone
 * would make the phone useless. Only the handful of moments worth interrupting
 * someone for come here.
 *
 * Disabled unless TODIEX_URL and TODIEX_TOKEN are both set. Failures are
 * swallowed — an inbox that is down must never break a webhook, a login, or
 * task processing. That is also true on the receiving end: todiex commits the
 * event before it attempts the push, so a 200 here means the event is safe
 * even if the notification never arrives.
 */

/** Long enough for a cold Railway container, short enough not to hold a webhook. */
const REQUEST_TIMEOUT_MS = 5_000;

/** Display tone on the feed, and the notification emoji. Not a priority. */
export type TodiexLevel = 'info' | 'success' | 'warn' | 'error';

export interface TodiexEvent {
  /** The sender's own event name: 'subscription.created', 'user.signed_up'. */
  kind: string;
  /** One line. It has to stand alone on a lock screen. */
  title: string;
  message?: string;
  level?: TodiexLevel;
  /** Where tapping the notification lands. */
  url?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Idempotency key, scoped to this product. todiex stores and notifies at
   * most once per key, forever — which is what lets a caller fire a
   * "first ever" event unconditionally and keep no state of its own.
   */
  dedupeKey?: string | null;
  /** ISO 8601 with an offset. Defaults to the moment todiex receives it. */
  occurredAt?: string;
}

function config(): { url: string; token: string } | null {
  const url = (process.env.TODIEX_URL || '').replace(/\/+$/, '');
  const token = process.env.TODIEX_TOKEN || '';
  if (!url || !token) return null;
  return { url, token };
}

export function isTodiexConfigured(): boolean {
  return config() !== null;
}

/**
 * Post one event. Resolves once the POST settles, never throws.
 *
 * `source` is stamped here rather than passed in: one shared token serves
 * every product, so the payload string is the only thing that says which one
 * is calling, and a call site getting it wrong would file Talyn's news under
 * someone else's name.
 */
export async function postTodiexEvent(event: TodiexEvent): Promise<void> {
  const cfg = config();
  if (!cfg) return;

  const url = `${cfg.url}/api/ingest/events`;
  const startedAt = Date.now();
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: 'talyn',
          kind: event.kind,
          title: event.title,
          message: event.message ?? '',
          level: event.level ?? 'info',
          url: event.url ?? null,
          metadata: event.metadata ?? {},
          dedupeKey: event.dedupeKey ?? null,
          occurredAt: event.occurredAt ?? null,
        }),
      },
      { label: 'todiex inbox', timeoutMs: REQUEST_TIMEOUT_MS },
    );
    debugBus.recordHttp({
      service: 'todiex',
      method: 'POST',
      url,
      status: res.status,
      durationMs: Date.now() - startedAt,
      ok: res.ok,
      ...(res.ok ? {} : { error: `todiex ingest failed (${res.status})` }),
    });
  } catch (err) {
    debugBus.recordHttp({
      service: 'todiex',
      method: 'POST',
      url,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: err,
    });
  }
}

/**
 * Fire-and-forget wrapper, and the one every call site should use.
 *
 * The call sites are a webhook handler, the JWT middleware and the dispatch
 * loop — none of them may wait on an inbox, and none of them may fail because
 * of one. `void` + `.catch()` rather than a bare floating promise so an
 * unhandled rejection can never reach the process.
 */
export function notifyTodiex(event: TodiexEvent): void {
  if (!isTodiexConfigured()) return;
  void postTodiexEvent(event).catch((err) => {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.warn(`[todiex] post "${event.kind}" failed:`, msg);
  });
}
