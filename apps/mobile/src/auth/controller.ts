import type { Session, User } from '@supabase/supabase-js';

import { ATTEMPT_TTL_MS, callbackCode, SignInError } from './callback';
import type { SecureSessionStorage } from './storage';

export interface AuthResult { data: { session: Session | null }; error: unknown }
export interface AuthGateway {
  getSession(): Promise<AuthResult>;
  refreshSession(): Promise<AuthResult>;
  signInWithOAuth(options: { provider: 'github'; options: { redirectTo: string; skipBrowserRedirect: true } }): Promise<{ data: { url: string | null }; error: unknown }>;
  exchangeCodeForSession(code: string): Promise<AuthResult>;
  signOut(options: { scope: 'local' }): Promise<{ error: unknown }>;
  startAutoRefresh(): void | Promise<void>;
  stopAutoRefresh(): void | Promise<void>;
}
export interface AuthBrowser {
  open(url: string, callback: string): Promise<{ type: string; url?: string }>;
  dismiss(): void;
}
export type AuthStatus = 'restoring' | 'signedOut' | 'signingIn' | 'signedIn' | 'locked';
export interface AuthSnapshot {
  status: AuthStatus;
  /** `githubLogin` is the GitHub username, when the session carries it. */
  user: (Pick<User, 'id' | 'email'> & { githubLogin?: string }) | null;
  issue: SignInError['kind'] | 'outage' | null;
  notice?: 'deleted';
}
type Attempt = { callback: string; startedAt: number; phase: 'awaiting' | 'exchanging' };

function snapshotUser(user: User): NonNullable<AuthSnapshot['user']> {
  const login = (user.user_metadata as { user_name?: unknown } | undefined)?.user_name;
  return { id: user.id, email: user.email, ...(typeof login === 'string' && login ? { githubLogin: login } : {}) };
}

export function isRefreshRejection(error: unknown): boolean {
  const value = error as { name?: string; code?: string; status?: number } | null;
  return value?.name === 'AuthApiError' && (value.status === 400 || value.status === 401 || value.status === 403) &&
    ['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired'].includes(value.code ?? '');
}

export class AuthController {
  private snapshot: AuthSnapshot = { status: 'restoring', user: null, issue: null };
  private session: Session | null = null;
  private listeners = new Set<() => void>();
  private epoch = 0;
  private blocked = false;
  private disposed = false;
  private active = false;
  private refreshVersion = 0;
  private refreshLifecycle: Promise<void> = Promise.resolve();
  private login: Promise<void> | null = null;
  private exchange: Promise<void> | null = null;
  private recovery: Promise<boolean> | null = null;
  private cleanup: Promise<void> | null = null;
  private cleanupUser: string | null = null;
  private cancelBrowser: (() => void) | null = null;

  constructor(private auth: AuthGateway, private storage: SecureSessionStorage,
    private browser: AuthBrowser, private callback: string,
    private boundary: (priorUser: string | null) => Promise<void>, private now = Date.now) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: AuthSnapshot) {
    if (this.disposed) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  private valid(epoch: number) { return !this.disposed && !this.blocked && this.epoch === epoch; }
  private async accept(session: Session | null, epoch: number) {
    if (!this.valid(epoch)) return;
    const prior = this.session?.user.id ?? null;
    if (prior !== (session?.user.id ?? null)) {
      await this.boundary(prior);
      if (!this.valid(epoch)) return;
    }
    this.session = session;
    this.setActive(this.active);
    this.publish({ status: session ? 'signedIn' : 'signedOut', user: session ? snapshotUser(session.user) : null, issue: null });
  }

  private async pending(): Promise<Attempt | null> {
    const raw = await this.storage.getItem('attempt');
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Attempt;
      if (value.callback !== this.callback || !Number.isFinite(value.startedAt) ||
        value.startedAt > this.now() || this.now() - value.startedAt >= ATTEMPT_TTL_MS || value.phase !== 'awaiting') {
        throw new Error();
      }
      if (!await this.storage.getItem('session-code-verifier')) throw new Error();
      return value;
    } catch { throw new SignInError('expired'); }
  }
  private async clearAttempt() {
    await this.storage.removeItem('attempt');
    await this.storage.removeItem('session-code-verifier');
  }

  restore = async () => {
    if (this.blocked) { await this.signOut(); return; }
    const epoch = this.epoch;
    try {
      try { if (!await this.pending()) await this.clearAttempt(); } catch { await this.clearAttempt(); }
      const result = await this.auth.getSession();
      if (!this.valid(epoch)) return;
      if (isRefreshRejection(result.error)) { await this.signOut(); return; }
      if (result.error) {
        this.publish({ ...this.snapshot, status: 'locked', issue: 'outage' });
        return;
      }
      await this.accept(result.data.session, epoch);
    } catch {
      if (this.valid(epoch)) this.publish({ ...this.snapshot, status: 'locked', issue: 'storage' });
    }
  };

  signIn = (): Promise<void> => {
    if (this.login) return this.login;
    if (this.exchange) return this.exchange;
    if (this.cleanup || this.disposed || this.session) return Promise.resolve();
    this.blocked = false;
    const epoch = ++this.epoch;
    this.publish({ status: 'signingIn', user: null, issue: null });
    this.login = this.runSignIn(epoch).finally(() => { this.login = null; });
    return this.login;
  };
  private async runSignIn(epoch: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.clearAttempt();
      if (!this.valid(epoch)) return;
      const result = await this.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: this.callback, skipBrowserRedirect: true } });
      if (!this.valid(epoch)) return;
      if (result.error || !result.data.url) throw new SignInError('failed');
      // Supabase stores the verifier before it returns the provider URL.
      if (!await this.storage.getItem('session-code-verifier')) throw new SignInError('storage');
      await this.storage.setItem('attempt', JSON.stringify({ callback: this.callback, startedAt: this.now(), phase: 'awaiting' }));
      if (!this.valid(epoch)) return;
      const interrupted = new Promise<never>((_, reject) => {
        this.cancelBrowser = () => reject(new SignInError('cancelled'));
        timer = setTimeout(() => reject(new SignInError('timeout')), ATTEMPT_TTL_MS);
      });
      const response = await Promise.race([this.browser.open(result.data.url, this.callback), interrupted]);
      if (!this.valid(epoch)) return;
      if (response.type === 'success' && response.url) await this.handleCallback(response.url);
      else if (this.exchange) await this.exchange;
      else if (!this.session) throw new SignInError('cancelled');
    } catch (error) {
      // A warm link can finish before the browser reports dismissal.
      if (this.exchange) await this.exchange;
      if (this.valid(epoch) && !this.session) {
        await this.fail(error);
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.cancelBrowser = null;
      this.browser.dismiss();
    }
  }

  cancelSignIn = () => {
    if (this.snapshot.status !== 'signingIn') return;
    void this.signOut().then(() => {
      if (this.snapshot.status === 'signedOut') this.publish({ ...this.snapshot, issue: 'cancelled' });
    });
  };

  handleCallback = (url: string): Promise<void> => {
    if (this.exchange) return this.exchange;
    if (this.blocked || this.disposed || this.session) return Promise.resolve();
    const epoch = this.epoch;
    this.exchange = this.exchangeCallback(url, epoch).finally(() => { this.exchange = null; });
    return this.exchange;
  };
  private async exchangeCallback(url: string, epoch: number) {
    try {
      const code = callbackCode(url, this.callback);
      const pending = await this.pending();
      if (!pending || !this.valid(epoch)) throw new SignInError('expired');
      this.publish({ status: 'signingIn', user: null, issue: null });
      // Claim the code durably before exchange. A restart requires a fresh attempt.
      await this.storage.setItem('attempt', JSON.stringify({ ...pending, phase: 'exchanging' }));
      if (!this.valid(epoch)) return;
      const result = await this.auth.exchangeCodeForSession(code);
      if (!this.valid(epoch)) return;
      if (result.error || !result.data.session) throw new SignInError('failed');
      await this.clearAttempt();
      await this.accept(result.data.session, epoch);
    } catch (error) {
      if (this.valid(epoch)) await this.fail(error);
    } finally { this.browser.dismiss(); }
  }
  private async fail(error: unknown) {
    try {
      await this.clearAttempt();
      this.publish({ status: 'signedOut', user: null, issue: error instanceof SignInError ? error.kind : 'failed' });
    } catch { this.publish({ status: 'locked', user: null, issue: 'storage' }); }
  }

  getAccessToken = async (): Promise<string | null> => {
    const epoch = this.epoch;
    const user = this.session?.user.id;
    if (!user || !this.valid(epoch)) return null;
    try {
      const result = await this.auth.getSession();
      if (!this.valid(epoch) || this.session?.user.id !== user) return null;
      if (isRefreshRejection(result.error)) { void this.signOut(); return null; }
      if (result.error) return null;
      if (!result.data.session) { this.publish({ ...this.snapshot, status: 'locked', issue: 'storage' }); return null; }
      if (result.data.session.user.id !== user) { void this.signOut(); return null; }
      return result.data.session.access_token;
    } catch { return null; }
  };

  recoverSession = (): Promise<boolean> => {
    if (this.recovery) return this.recovery;
    const epoch = this.epoch;
    const user = this.session?.user.id;
    if (!user || !this.valid(epoch)) return Promise.resolve(false);
    this.recovery = (async () => {
      try {
        const result = await this.auth.refreshSession();
        if (!this.valid(epoch)) return false;
        if (isRefreshRejection(result.error)) { void this.signOut(); return false; }
        if (result.error) {
          this.publish({ ...this.snapshot, issue: 'outage' });
          return false;
        }
        if (!result.data.session) { this.publish({ ...this.snapshot, issue: 'outage' }); return false; }
        if (result.data.session.user.id !== user) { void this.signOut(); return false; }
        this.session = result.data.session;
        this.publish({ ...this.snapshot, issue: null });
        return true;
      } catch { return false; }
    })().finally(() => { this.recovery = null; });
    return this.recovery;
  };

  authEvent(event: string, session: Session | null) {
    if (this.blocked || this.disposed) return;
    if (event === 'SIGNED_IN' && this.session && session && session.user.id !== this.session.user.id) { void this.signOut(); return; }
    if (event === 'TOKEN_REFRESHED' && this.session) {
      if (!session) return;
      if (session.user.id !== this.session.user.id) { void this.signOut(); return; }
      this.session = session;
    }
    // The refresh transport reports explicit rejection. Other events cannot prove it.
  }

  setActive(active: boolean) {
    this.active = active;
    const version = ++this.refreshVersion;
    this.refreshLifecycle = this.refreshLifecycle.then(async () => {
      if (version !== this.refreshVersion) return;
      if (this.active && this.session && !this.blocked && !this.disposed) await this.auth.startAutoRefresh();
      else await this.auth.stopAutoRefresh();
    }).catch(() => {});
  }

  signOut = (): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    if (this.cleanup) return this.cleanup;
    this.blocked = true;
    this.epoch++;
    this.setActive(this.active);
    this.cancelBrowser?.();
    this.browser.dismiss();
    const prior = this.session?.user.id ?? this.cleanupUser;
    this.cleanupUser = prior;
    this.session = null;
    this.publish({ status: 'restoring', user: null, issue: null });
    // Reset sockets and user memory before waiting for any remote operation.
    const boundary = this.boundary(prior);
    this.cleanup = (async () => {
      try {
        await Promise.allSettled([boundary, this.login, this.exchange, this.recovery]);
        await this.auth.signOut({ scope: 'local' }).catch(() => {});
        await this.storage.clearAuth();
        await boundary;
        this.cleanupUser = null;
        this.publish({ status: 'signedOut', user: null, issue: null });
      } catch { this.publish({ status: 'locked', user: null, issue: 'storage' }); }
    })().finally(() => { this.cleanup = null; });
    return this.cleanup;
  };

  markAccountDeleted() {
    if (this.snapshot.status === 'signedOut') this.publish({ ...this.snapshot, notice: 'deleted' });
  }

  dispose() {
    this.disposed = true;
    this.blocked = true;
    this.epoch++;
    this.cancelBrowser?.();
    this.browser.dismiss();
    this.setActive(this.active);
    this.session = null;
    this.listeners.clear();
  }
}
