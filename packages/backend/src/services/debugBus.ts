import type {
  DebugCategory,
  DebugEvent,
  DebugPollerState,
  DebugRateLimitState,
  DebugSnapshot,
} from '@fastowl/shared';

/**
 * In-process observability bus for the developer Debug panel.
 *
 * Every interesting internal activity — outbound HTTP, poll ticks, WebSocket
 * traffic, domain events — is recorded here as a {@link DebugEvent}. Events
 * are held in a bounded ring buffer (backfill for a panel that opens late) and
 * pushed live to a registered sink (the WebSocket broadcast).
 *
 * This module deliberately imports nothing from the services it observes — the
 * live sink and the WS client count are injected as callbacks — so it can be
 * imported from anywhere (github, websocket, the pollers, …) with no risk of a
 * circular dependency.
 *
 * Recording captures METADATA ONLY. Never pass request/response bodies, auth
 * headers, or tokens; URLs are stripped of their query string by
 * {@link redactUrl} at the call site.
 */

const MAX_EVENTS = 1000;
const MAX_ERROR_LEN = 500;

type LiveSink = (event: DebugEvent) => void;
type ClientCounter = () => number;

/** Strip the query string (and any credentials) from a URL for safe display. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.split('?')[0] ?? raw;
  }
}

function truncate(s: string): string {
  return s.length > MAX_ERROR_LEN ? `${s.slice(0, MAX_ERROR_LEN)}…` : s;
}

class DebugBus {
  private buffer: DebugEvent[] = [];
  private seq = 0;
  private enabled = true;
  private sink: LiveSink | null = null;
  private clientCounter: ClientCounter | null = null;
  private counters: Record<string, number> = {};
  private pollers = new Map<string, DebugPollerState>();
  private rateLimits = new Map<string, DebugRateLimitState>();

  // Rate-limit cards are refreshed by their poller every ~30s. Drop any not
  // observed within this window so a dead poller or a disconnected account
  // ages out instead of showing frozen numbers forever — and so a card set
  // that was relabelled (e.g. a workspace-label fallback once its GitHub login
  // resolves) doesn't linger as a stale duplicate. Comfortably longer than the
  // poll cadence so a healthy poller's cards never flicker out.
  private static readonly RATE_LIMIT_STALE_MS = 3 * 60_000;

  /** Global kill-switch. Recording is a cheap no-op while disabled. */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  /** Registered by websocket.ts to fan each event out to connected clients. */
  setLiveSink(fn: LiveSink | null): void {
    this.sink = fn;
  }

  /** Registered by websocket.ts so the snapshot can report live client count. */
  setClientCounter(fn: ClientCounter | null): void {
    this.clientCounter = fn;
  }

  record(input: Omit<DebugEvent, 'id' | 'timestamp'>): void {
    if (!this.enabled) return;
    const event: DebugEvent = {
      ...input,
      summary: truncate(input.summary),
      id: ++this.seq,
      timestamp: new Date().toISOString(),
    };
    this.buffer.push(event);
    if (this.buffer.length > MAX_EVENTS) this.buffer.shift();
    this.counters[event.category] = (this.counters[event.category] ?? 0) + 1;
    if (this.sink) {
      try {
        this.sink(event);
      } catch {
        // The sink (a WS broadcast) must never break recording.
      }
    }
  }

  // ---- Typed convenience recorders ---------------------------------------

  recordHttp(input: {
    service: string;
    method: string;
    url: string;
    status?: number;
    durationMs: number;
    ok: boolean;
    bytes?: number;
    error?: string;
  }): void {
    const path = redactUrl(input.url);
    const status = input.status ?? (input.ok ? 200 : 'ERR');
    this.record({
      category: 'http',
      service: input.service,
      action: 'request',
      ok: input.ok,
      summary: `${input.method} ${path} → ${status} ${Math.round(input.durationMs)}ms`,
      durationMs: input.durationMs,
      meta: {
        status: input.status,
        ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
        ...(input.error ? { error: truncate(input.error) } : {}),
      },
    });
  }

  recordWs(input: {
    action: string;
    summary: string;
    ok?: boolean;
    meta?: Record<string, unknown>;
  }): void {
    this.record({
      category: 'websocket',
      service: 'ws',
      action: input.action,
      ok: input.ok ?? true,
      summary: input.summary,
      meta: input.meta,
    });
  }

  recordEvent(input: {
    service: string;
    action: string;
    summary: string;
    ok?: boolean;
    meta?: Record<string, unknown>;
  }): void {
    this.record({
      category: 'event',
      service: input.service,
      action: input.action,
      ok: input.ok ?? true,
      summary: input.summary,
      meta: input.meta,
    });
  }

  // ---- Poller registry ----------------------------------------------------

  registerPoller(name: string, intervalMs: number, description: string): void {
    const existing = this.pollers.get(name);
    if (existing) {
      existing.intervalMs = intervalMs;
      existing.description = description;
      return;
    }
    this.pollers.set(name, {
      name,
      description,
      intervalMs,
      tickCount: 0,
      lastTickAt: null,
      lastDurationMs: null,
      lastOk: null,
      lastError: null,
    });
  }

  pollerTick(
    name: string,
    input: { durationMs: number; ok: boolean; summary?: string; error?: string },
  ): void {
    let p = this.pollers.get(name);
    if (!p) {
      this.registerPoller(name, 0, '');
      p = this.pollers.get(name)!;
    }
    p.tickCount += 1;
    p.lastTickAt = new Date().toISOString();
    p.lastDurationMs = Math.round(input.durationMs);
    p.lastOk = input.ok;
    p.lastError = input.error ? truncate(input.error) : null;

    this.record({
      category: input.ok ? 'polling' : 'error',
      service: name,
      action: 'tick',
      ok: input.ok,
      summary: input.summary ?? `${name} tick ${Math.round(input.durationMs)}ms`,
      durationMs: input.durationMs,
      meta: input.error ? { error: truncate(input.error) } : undefined,
    });
  }

  // ---- Rate-limit registry ------------------------------------------------

  /**
   * Record the last-seen rate-limit budget for an API bucket, parsed from a
   * provider's response headers. Overwrites the previous snapshot for `name`.
   * A no-op while disabled, and silently ignores partial/garbage header sets.
   */
  recordRateLimit(input: {
    name: string;
    description: string;
    limit: number;
    remaining: number;
    used: number;
    resetAt: string;
    resource?: string | null;
  }): void {
    if (!this.enabled) return;
    if (!Number.isFinite(input.limit) || input.limit <= 0) return;
    this.rateLimits.set(input.name, {
      name: input.name,
      description: input.description,
      limit: input.limit,
      remaining: input.remaining,
      used: input.used,
      resetAt: input.resetAt,
      resource: input.resource ?? null,
      observedAt: new Date().toISOString(),
    });
  }

  // ---- Read side ----------------------------------------------------------

  getEvents(filter?: {
    category?: DebugCategory;
    service?: string;
    limit?: number;
  }): DebugEvent[] {
    let events = this.buffer;
    if (filter?.category) events = events.filter((e) => e.category === filter.category);
    if (filter?.service) events = events.filter((e) => e.service === filter.service);
    if (filter?.limit && filter.limit > 0 && events.length > filter.limit) {
      events = events.slice(events.length - filter.limit);
    }
    return events;
  }

  snapshot(): DebugSnapshot {
    this.pruneStaleRateLimits();
    return {
      pollers: [...this.pollers.values()],
      counters: { ...this.counters },
      bufferSize: this.buffer.length,
      wsClients: this.clientCounter?.() ?? 0,
      rateLimits: [...this.rateLimits.values()],
    };
  }

  /** Evict rate-limit cards whose last observation is older than the TTL. */
  private pruneStaleRateLimits(): void {
    const cutoff = Date.now() - DebugBus.RATE_LIMIT_STALE_MS;
    for (const [name, rl] of this.rateLimits) {
      if (new Date(rl.observedAt).getTime() < cutoff) this.rateLimits.delete(name);
    }
  }

  clear(): void {
    this.buffer = [];
    this.counters = {};
  }

  /** Test helper — drop all state including the poller registry. */
  _reset(): void {
    this.clear();
    this.pollers.clear();
    this.rateLimits.clear();
    this.seq = 0;
  }
}

export const debugBus = new DebugBus();
