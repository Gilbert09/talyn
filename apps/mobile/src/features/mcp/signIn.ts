import { SIGN_IN_MAX_MS, SIGN_IN_POLL_MS } from './model';

export interface SignInFlow { flowId: string; authorizeUrl: string; expiresAt: string }
export interface SignInStatus { status: 'pending' | 'connected' | 'needs_reauth'; pending: boolean; detail?: string }

export type SignInResult =
  | { outcome: 'connected' }
  | { outcome: 'error'; detail: string }
  | { outcome: 'timeout' }
  | { outcome: 'superseded' };

export interface SignInDeps {
  start(): Promise<SignInFlow>;
  /** Opens the browser and resolves when it returns to the app or closes. */
  open(url: string): Promise<'returned' | 'dismissed'>;
  status(flowId: string): Promise<SignInStatus>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** False once the person starts again or leaves, so a late answer changes nothing. */
  alive(): boolean;
  /** The browser closed and the sign-in is not finished yet. */
  onBrowserClosed?(authorizeUrl: string): void;
}

/**
 * Starts an OAuth sign-in, opens the browser and polls the flow like web: every
 * 2 seconds until the flow expires or 10 minutes pass. The browser closing
 * skips the wait once, so a return to the app is checked at once.
 */
export async function runMcpSignIn(deps: SignInDeps): Promise<SignInResult> {
  const flow = await deps.start();
  if (!deps.alive()) return { outcome: 'superseded' };
  let closed = false;
  let wake: (() => void) | null = null;
  let woken = new Promise<void>((resolve) => { wake = resolve; });
  void deps.open(flow.authorizeUrl).then(() => {
    closed = true;
    wake?.();
  });
  const expires = Date.parse(flow.expiresAt);
  const until = Math.min(Number.isFinite(expires) ? expires : Infinity, deps.now() + SIGN_IN_MAX_MS);
  let notified = false;
  while (deps.now() < until) {
    await Promise.race([deps.sleep(SIGN_IN_POLL_MS), woken]);
    // The wake is spent after one use. Later checks wait the full interval.
    woken = new Promise<void>(() => undefined);
    if (!deps.alive()) return { outcome: 'superseded' };
    const status = await deps.status(flow.flowId);
    if (!deps.alive()) return { outcome: 'superseded' };
    if (status.status === 'connected' && !status.pending) return { outcome: 'connected' };
    if (!status.pending || status.status === 'needs_reauth') {
      return { outcome: 'error', detail: status.detail ?? 'Sign-in did not finish. Try again.' };
    }
    if (closed && !notified) {
      notified = true;
      deps.onBrowserClosed?.(flow.authorizeUrl);
    }
  }
  return { outcome: 'timeout' };
}
