/**
 * Whether the Talyn backend is answering, for the app-wide banner. Mirrors web `SystemStatusBanner`:
 * "unreachable" (no answer while the phone is online) and "degraded" (it answers with server errors)
 * are different facts, and neither is the person's fault.
 *
 * Nothing polls while things are fine. A failed request starts probes of the public `/health` route
 * (a real database check that answers 503 while draining). The banner shows only after a probe
 * agrees, so one dropped request does not flash it, and it clears on the first good probe.
 */
export type BackendHealthState = 'ok' | 'unreachable' | 'degraded';
export interface BackendHealthSnapshot { state: BackendHealthState; checking: boolean; since: number | null }

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ status: number }>;
interface Deps {
  fetch: Fetch;
  /** False while the phone has no network or the app is in the background: probing then proves nothing. */
  canProbe(): boolean;
  now?(): number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

/** Probe delays while unhealthy: quick at first, then once a minute. */
export const PROBE_DELAYS_MS = [0, 5_000, 10_000, 20_000, 30_000, 60_000];
const PROBE_TIMEOUT_MS = 8_000;

/** What one failed request says about the backend. `null` means nothing (a 4xx, or the phone is offline). */
export function classifyRequestError(input: { error: unknown; status?: number }): Exclude<BackendHealthState, 'ok'> | null {
  if (input.status !== undefined) return input.status >= 500 ? 'degraded' : null;
  const error = input.error as { name?: string; online?: boolean } | null;
  if (error?.name === 'ApiNetworkError') return error.online ? 'unreachable' : null;
  return null;
}

/** What one probe says. A 2xx is healthy; a 5xx is degraded; no answer is unreachable. */
export function classifyProbe(status: number | null): BackendHealthState {
  if (status === null) return 'unreachable';
  if (status >= 500) return 'degraded';
  return 'ok';
}

export class BackendHealth {
  private snapshot: BackendHealthSnapshot = { state: 'ok', checking: false, since: null };
  private listeners = new Set<() => void>();
  private suspect = false;
  private attempt = 0;
  private timer: unknown = null;
  private inFlight: AbortController | null = null;
  private disposed = false;

  constructor(private readonly healthUrl: string, private readonly deps: Deps) {}

  getSnapshot = (): BackendHealthSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Feed every failed request here. */
  report(input: { error: unknown; status?: number }): void {
    if (this.disposed || !classifyRequestError(input)) return;
    if (this.suspect || this.snapshot.state !== 'ok') return;
    this.suspect = true;
    this.attempt = 0;
    this.schedule();
  }

  /** "Try now" from the banner, and the app coming back to the foreground or online. */
  checkNow(): void {
    if (this.disposed || (!this.suspect && this.snapshot.state === 'ok')) return;
    this.attempt = 0;
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.inFlight?.abort();
    this.listeners.clear();
  }

  private schedule(): void {
    this.clearTimer();
    const delay = PROBE_DELAYS_MS[Math.min(this.attempt, PROBE_DELAYS_MS.length - 1)];
    this.timer = (this.deps.setTimeout ?? setTimeout)(() => { void this.probe(); }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) (this.deps.clearTimeout ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
  }

  private async probe(): Promise<void> {
    this.timer = null;
    if (this.disposed) return;
    if (!this.deps.canProbe()) {
      // Try again later without counting it: an offline phone says nothing about the backend.
      this.timer = (this.deps.setTimeout ?? setTimeout)(() => { void this.probe(); }, PROBE_DELAYS_MS[1]);
      return;
    }
    this.set({ checking: true });
    const controller = new AbortController();
    this.inFlight = controller;
    const timeout = (this.deps.setTimeout ?? setTimeout)(() => controller.abort(), PROBE_TIMEOUT_MS);
    let status: number | null = null;
    try {
      status = (await this.deps.fetch(this.healthUrl, { signal: controller.signal })).status;
    } catch {
      status = null;
    } finally {
      (this.deps.clearTimeout ?? clearTimeout)(timeout as ReturnType<typeof setTimeout>);
      this.inFlight = null;
    }
    if (this.disposed) return;
    const state = classifyProbe(status);
    if (state === 'ok') {
      this.suspect = false;
      this.attempt = 0;
      this.set({ state: 'ok', checking: false, since: null });
      return;
    }
    const now = (this.deps.now ?? Date.now)();
    this.set({ state, checking: false, since: this.snapshot.state === 'ok' ? now : this.snapshot.since });
    this.attempt += 1;
    this.schedule();
  }

  private set(patch: Partial<BackendHealthSnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (next.state === this.snapshot.state && next.checking === this.snapshot.checking && next.since === this.snapshot.since) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
