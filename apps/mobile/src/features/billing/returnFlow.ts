import {
  MOBILE_BILLING_RETURN_KINDS, MOBILE_BILLING_RETURN_RESULTS, PLAN_TIER_LABELS, formatCreditBalance, isPlanTier,
  type BillingStatus, type MobileBillingReturnKind, type MobileBillingReturnResult,
} from '@talyn/shared';

/** What the browser flow did: bought a plan, bought credits, reset usage, or managed the subscription. */
export type ReturnKind = MobileBillingReturnKind;
/** `unknown` when the app saw the browser come back but not the link it came back on. */
export type ReturnResult = MobileBillingReturnResult | 'unknown';

export function returnKindOf(value: unknown): ReturnKind {
  const raw = Array.isArray(value) ? value[0] : value;
  return (MOBILE_BILLING_RETURN_KINDS as readonly unknown[]).includes(raw) ? raw as ReturnKind : 'checkout';
}
export function returnResultOf(value: unknown): ReturnResult {
  const raw = Array.isArray(value) ? value[0] : value;
  return (MOBILE_BILLING_RETURN_RESULTS as readonly unknown[]).includes(raw) ? raw as ReturnResult : 'unknown';
}

/**
 * Waits between status reads after a return, about 20 seconds in all. Polar
 * grants the plan by webhook, so the first read often still shows the old one.
 */
export const RETURN_POLL_DELAYS_MS = [1_000, 2_000, 3_000, 4_000, 5_000, 5_000] as const;

/** Whether the status shows what the flow bought, compared with the status before it. */
export function returnLanded(kind: ReturnKind, before: BillingStatus | null, after: BillingStatus): boolean {
  if (kind === 'portal') return true;
  if (!before) return kind === 'checkout' ? after.tier !== undefined && after.tier !== 'free' : true;
  if (kind === 'checkout') return after.tier !== before.tier || after.period !== before.period;
  if (kind === 'reset') return (after.usage?.resets ?? 0) > (before.usage?.resets ?? 0);
  return (after.credits?.balanceMicros ?? 0) > (before.credits?.balanceMicros ?? 0);
}

export function returnTitle(kind: ReturnKind): string {
  if (kind === 'reset') return 'Resetting your usage…';
  return kind === 'credits' ? 'Adding your credits…' : kind === 'portal' ? 'Updating your plan…' : 'Finishing your upgrade…';
}

export interface ReturnBanner { tone: 'success' | 'information' | 'warning'; message: string }

/** The banner the plan page shows after the flow, or null for none. */
export function returnBanner(kind: ReturnKind, result: ReturnResult, landed: boolean, after: BillingStatus | null): ReturnBanner | null {
  if (result === 'cancel') {
    if (kind === 'reset') return { tone: 'information', message: 'The usage reset was canceled. Nothing was charged.' };
    return { tone: 'information', message: kind === 'credits' ? 'The credit purchase was canceled. Nothing was charged.' : 'Checkout was canceled. Nothing was charged.' };
  }
  if (kind === 'portal') return null;
  if (landed && kind === 'reset') return { tone: 'success', message: 'Usage reset. Your box-hours are back.' };
  if (landed && kind === 'credits') {
    return { tone: 'success', message: `Credits added. Your balance is ${formatCreditBalance(after?.credits?.balanceMicros ?? 0)}.` };
  }
  if (landed) {
    const tier = after && isPlanTier(after.tier) ? PLAN_TIER_LABELS[after.tier] : null;
    return { tone: 'success', message: tier ? `You are on ${tier} now.` : 'Your plan is updated.' };
  }
  if (result === 'unknown') return null;
  if (kind === 'reset') {
    return { tone: 'warning', message: 'Your usage reset has not arrived yet. It can take a minute. Pull down to refresh.' };
  }
  return { tone: 'warning', message: kind === 'credits'
    ? 'Your credits have not arrived yet. They can take a minute. Pull down to refresh.'
    : 'Your plan has not updated yet. It can take a minute. Pull down to refresh.' };
}

export interface ReturnState {
  phase: 'idle' | 'finishing' | 'done';
  kind: ReturnKind;
  startedAt: number;
  banner: ReturnBanner | null;
}

type Read = () => Promise<BillingStatus>;
type Wait = (ms: number) => Promise<void>;
const sleep: Wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A second start for the same kind within this window is the same return. */
const SAME_RETURN_MS = 30_000;

/**
 * The one return in progress. The auth session's promise and, on Android, the
 * deep link can both report the same return, so a start while one runs joins it.
 */
export class BillingReturnTracker {
  private state: ReturnState = { phase: 'idle', kind: 'checkout', startedAt: 0, banner: null };
  private baseline: BillingStatus | null = null;
  private listeners = new Set<() => void>();
  private run = 0;

  constructor(private readonly now: () => number = Date.now, private readonly wait: Wait = sleep) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;

  /** The status before the browser opened, to tell what changed. */
  remember(status: BillingStatus | null | undefined) { this.baseline = status ?? null; }

  /** True when a return of this kind started a moment ago. */
  active(kind: ReturnKind): boolean {
    return this.state.phase !== 'idle' && this.state.kind === kind && this.now() - this.state.startedAt < SAME_RETURN_MS;
  }

  /** Polls until the status shows the change or the time runs out. Resolves with the banner. */
  async start(kind: ReturnKind, result: ReturnResult, read: Read, onStatus?: (status: BillingStatus) => void): Promise<ReturnBanner | null> {
    if (this.active(kind) && this.state.phase === 'finishing' && result !== 'cancel') return this.finished();
    const run = ++this.run;
    this.set({ phase: 'finishing', kind, startedAt: this.now(), banner: null });
    const before = this.baseline;
    let after: BillingStatus | null = null;
    let landed = false;
    const delays = result === 'cancel' || kind === 'portal' ? [0] : [0, ...RETURN_POLL_DELAYS_MS];
    for (const delay of delays) {
      if (delay) await this.wait(delay);
      if (run !== this.run) return null;
      try {
        after = await read();
        onStatus?.(after);
        landed = returnLanded(kind, before, after);
      } catch { /* A failed read is one less try. */ }
      if (landed || result === 'cancel') break;
    }
    if (run !== this.run) return null;
    const banner = returnBanner(kind, result, landed, after);
    this.baseline = null;
    this.set({ phase: 'done', kind, startedAt: this.state.startedAt, banner });
    return banner;
  }

  /** The plan page took the banner. */
  clear() {
    this.run += 1;
    this.set({ ...this.state, phase: 'idle', banner: null });
  }

  private finished(): Promise<ReturnBanner | null> {
    return new Promise((resolve) => {
      const stop = this.subscribe(() => {
        if (this.state.phase !== 'finishing') { stop(); resolve(this.state.banner); }
      });
    });
  }

  private set(next: ReturnState) {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
}

export const billingReturn = new BillingReturnTracker();
