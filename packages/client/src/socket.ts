import type { WSEvent, WSClientMessage, SpacePresenceMember, SpacePresenceMessage, DeskPresenceState } from '@talyn/shared';
import { getConfig, getRuntime, getWebSocketUrl, onConfigChange, type ApiClientConfig } from './config.js';
import { canRun, resolveRuntime, type ClientSocket, type ClientState } from './runtime.js';

type EventHandler<T = unknown> = (payload: T) => void;

// How often the client pings the server to prove the socket is alive.
// The backend replies to `{type:'ping'}` with `connection:status {pong}`.
const HEARTBEAT_INTERVAL_MS = 25_000;
/**
 * How long a ping may go unanswered before the socket is considered dead.
 *
 * The server answers `{type:'ping'}` synchronously on receipt, so a healthy
 * round trip is milliseconds — this is ~1000x that. It sits just under one
 * heartbeat interval so a genuine miss is caught on the very next tick rather
 * than the one after.
 */
const PONG_TIMEOUT_MS = 20_000;
/**
 * A tick arriving later than this multiple of the interval means the timer was
 * throttled or frozen, not that the socket is slow — browsers clamp background
 * timers to ~1/min and freeze them outright for a bfcached page.
 */
const THROTTLED_TICK_FACTOR = 1.5;
// Backoff cap. We retry forever (a dev backend restart shouldn't leave the
// list permanently frozen until app relaunch) but never wait longer than this.
const MAX_RECONNECT_DELAY_MS = 30_000;

/** The server rejected this connection's authorization (token invalid/expired). */
const WS_CLOSE_UNAUTHORIZED = 4401;
/** The server refused the connection for capacity (per-owner or global limit). */
const WS_CLOSE_CAPACITY = 1013;
/**
 * Backoff floor for a rejection that will repeat. 2^5 = 32s, so the delay goes
 * straight to the 30s ceiling instead of climbing from one second.
 */
const SLOW_RETRY_ATTEMPTS = 5;

export class WebSocketClient {
  private ws: ClientSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectTimer: (() => void) | null = null;
  // Drives only the backoff curve, not a give-up threshold — reset to 0 on
  // every successful open so the next outage starts fast again.
  private reconnectAttempts = 0;
  private retryNotBefore = 0;
  private heartbeatTimer: (() => void) | null = null;
  // True once a ping has been sent and we're still waiting for its pong. If
  // the next heartbeat tick fires while still awaiting, the socket is a
  // zombie (half-open after sleep / killed backend) and we force a reconnect.
  private awaitingPong = false;
  /** When the outstanding ping was sent — wall clock, not tick count. */
  private pingSentAt = 0;
  /** When the previous heartbeat tick ran, to detect a throttled/frozen gap. */
  private lastTickAt = 0;
  private runtime = resolveRuntime();
  private state: ClientState = this.runtime.lifecycle.getSnapshot();
  private unbindLifecycle: (() => void) | null = null;
  private unbindConfig: (() => void) | null = null;
  private config: ApiClientConfig | null = null;
  private heartbeatGeneration = 0;
  private disposed = false;
  private presenceTimer: (() => void) | null = null;
  private spacePresence = new Map<string, SpacePresenceMessage>();
  private subscribedSpaces = new Set<string>();
  /** The last desk presence reported, re-sent after a reconnect. Null = never reported. */
  private deskPresence: DeskPresenceState | null = null;
  private subscribedWorkspaces: Set<string> = new Set();
  /** Sent with every subscribe. The server holds back events a client did not opt in to. */
  private capabilities: string[] = [];
  // Admin Debug-panel owner filter, re-sent on (re)connect so the server keeps
  // streaming only the selected account's events. undefined = all.
  private debugFilter: string | undefined;
  private authenticated = false;
  private shouldReconnect = false;
  private connectGeneration = 0;
  /** One console.error per outage; later attempts only warn (see onerror). */
  private errorLoggedSinceOpen = false;
  /**
   * True from the moment `connect()` commits until its socket is assigned.
   *
   * The readyState guard cannot cover that window on its own: `getAuthToken()`
   * is awaited BEFORE `this.ws` exists, so two calls arriving while the token is
   * in flight both saw a null socket and both went on to open one.
   */
  private connecting = false;

  async connect(): Promise<void> {
    if (this.disposed) return;
    const config = getConfig();
    if (this.config && this.config !== config) this.reset();
    this.config = config;
    this.shouldReconnect = true;
    if (!this.unbindConfig) this.unbindConfig = onConfigChange(() => this.reset());
    if (!this.unbindLifecycle) {
      this.runtime = getRuntime();
      this.state = this.runtime.lifecycle.getSnapshot();
      this.bindLifecycle();
    }
    if (!this.shouldReconnect || this.config !== config || !canRun(this.state)) return;
    if (this.runtime.scheduler.now() < this.retryNotBefore) {
      this.scheduleReconnect();
      return;
    }
    // Bail if a socket is already open or mid-handshake — re-entry from a
    // focus/online wake would otherwise orphan the in-flight socket.
    if (
      this.ws?.readyState === 1 ||
      this.ws?.readyState === 0
    )
      return;

    // Serialize token lookups as well as socket creation.
    if (this.connecting) return;
    this.connecting = true;
    if (this.reconnectTimer !== null) {
      this.reconnectTimer();
      this.reconnectTimer = null;
    }
    const generation = ++this.connectGeneration;

    try {
      const token = await config.getAccessToken().catch(() => null);
      // Logout or a newer attempt can supersede this asynchronous token lookup.
      if (!this.shouldReconnect || generation !== this.connectGeneration) return;
      if (!token) {
        // Defer until we have a session — callers usually gate this behind
        // the AuthProvider so it's a transient case on cold start.
        console.log('WebSocket connect deferred: no auth token yet');
        this.scheduleReconnect();
        return;
      }
      console.log('Connecting to WebSocket...');
      // Token rides in the first frame after open, not the URL, so it
      // doesn't end up in access/edge logs. The backend closes the
      // socket if auth doesn't arrive within its handshake window.
      this.authenticated = false;
      // Held in a local as well as on the field. Every handler below belongs to
      // THIS socket, so it must act on this one and stand down if the field has
      // moved on — reading `this.ws` inside a handler is what let an orphan
      // write to its replacement.
      const socket = this.runtime.createWebSocket(getWebSocketUrl());
      this.ws = socket;

      socket.onopen = () => {
        // An orphan: opened by a superseded `connect()`. Close it rather than
        // leaving a second authenticated socket open against the same account.
        if (this.ws !== socket || !this.shouldReconnect || generation !== this.connectGeneration) {
          socket.close();
          return;
        }
        console.log('WebSocket opened; authenticating…');
        // NOT `reconnectAttempts = 0` — an open socket is not an accepted one.
        // The server can still reject us after open (owner connection limit,
        // an expired or revoked token), and resetting the backoff here made
        // every such rejection reconnect at a flat one second, forever.
        // The reset happens once the server confirms the connection.
        this.errorLoggedSinceOpen = false;
        // Checked even after the identity test: `onopen` can still be delivered
        // after a sleep/wake close, and `send` throws on anything but OPEN.
        if (socket.readyState !== 1) return;
        socket.send(JSON.stringify({ type: 'auth', token }));
        this.startHeartbeat();
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket || !this.shouldReconnect || generation !== this.connectGeneration) return;
        try {
          const data = JSON.parse(event.data) as WSEvent;
          const payload = data.payload as
            | { connected?: boolean; pong?: boolean }
            | undefined;
          // Any pong clears the in-flight heartbeat — the socket is alive.
          if (data.type === 'connection:status' && payload?.pong) {
            this.awaitingPong = false;
            return;
          }
          // The server emits connection:status {connected:true} only
          // after auth succeeds. That's our signal to resubscribe.
          if (
            data.type === 'connection:status' &&
            payload?.connected &&
            !this.authenticated
          ) {
            this.authenticated = true;
            // Accepted. This is the point a connection has proven itself, so
            // it is the point the backoff may start over.
            this.reconnectAttempts = 0;
            this.retryNotBefore = 0;
            for (const workspaceId of this.subscribedWorkspaces) {
              this.send(this.subscribeMessage(workspaceId));
            }
            for (const spaceId of this.subscribedSpaces) {
              this.send({ type: 'subscribe_space', spaceId });
            }
            for (const presence of this.spacePresence.values()) this.send(presence);
            if (this.deskPresence) this.send({ type: 'desk_presence', state: this.deskPresence } satisfies WSClientMessage);
            if (this.debugFilter !== undefined) {
              this.send({ type: 'debug:filter', owner: this.debugFilter });
            }
          }
          this.emit(data.type, data.payload);
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      // `event` is optional only for defensiveness: a real CloseEvent always
      // carries a code, but a caller that closes the socket directly may not.
      socket.onclose = (event?: { code: number }) => {
        const code = event?.code;
        // An orphan closing is not a disconnect: the live socket is elsewhere.
        // Reporting it would emit connection:status {connected:false} under a
        // healthy connection and queue a reconnect that fights it.
        if (this.ws !== socket || generation !== this.connectGeneration) return;
        this.ws = null;
        console.log(`WebSocket disconnected${code === undefined ? '' : ` (code ${code})`}`);
        this.authenticated = false;
        this.stopHeartbeat();
        this.emit('connection:status', { connected: false });
        if (generation !== this.connectGeneration || !this.shouldReconnect) return;
        // A rejection the server will repeat until something changes. Retrying
        // it fast costs the backend a token verification and a user write per
        // attempt, and burns this address's upgrade budget — so back off hard
        // rather than at the usual first-failure speed.
        if (code === WS_CLOSE_UNAUTHORIZED || code === WS_CLOSE_CAPACITY) {
          this.reconnectAttempts = Math.max(this.reconnectAttempts, SLOW_RETRY_ATTEMPTS);
          this.retryNotBefore = this.runtime.scheduler.now() + MAX_RECONNECT_DELAY_MS;
        }
        this.scheduleReconnect();
      };

      socket.onerror = () => {
        if (this.ws !== socket || generation !== this.connectGeneration) return;
        // The browser Event carries no diagnostics ("[object Event]") —
        // describe the socket state instead. console.error becomes a PostHog
        // $exception via autocapture, so it's reserved for a REAL outage: the
        // connection still failing on the 3rd+ reconnect attempt (~7s of
        // backoff). Single-blip drops — every backend deploy disconnects each
        // client once — stay at console.warn and never reach error tracking.
        // errorLoggedSinceOpen keeps it to one $exception per outage (an
        // extended outage used to flood the project with one identical event
        // per retry).
        const detail = `readyState=${socket.readyState}, reconnectAttempts=${this.reconnectAttempts}`;
        if (this.reconnectAttempts >= 3 && !this.errorLoggedSinceOpen) {
          this.errorLoggedSinceOpen = true;
          // The counters go on their own console line, NOT into the captured
          // message. Error tracking groups by message text, so embedding
          // readyState and reconnectAttempts minted a separate issue per
          // combination for what is one fault.
          console.warn(`WebSocket error detail: ${detail}`);
          console.error(`WebSocket connection failed: ${getWebSocketUrl()}`);
        } else {
          console.warn(`WebSocket error on ${getWebSocketUrl()} (${detail})`);
        }
      };
    } catch (error) {
      if (generation === this.connectGeneration && this.shouldReconnect) {
        console.warn('WebSocket connection attempt failed:', error);
        this.scheduleReconnect();
      }
    } finally {
      // A cancelled lookup must not release a newer attempt's guard.
      if (generation === this.connectGeneration) this.connecting = false;
    }
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.unbindLifecycle?.();
    this.unbindLifecycle = null;
    this.lifecycleBinding = null;
    this.spacePresence.clear();
    this.deskPresence = null;
    this.reconnectAttempts = 0;
    this.retryNotBefore = 0;
    this.stopConnection();
    this.emit('connection:status', { connected: false });
  }

  /** Call at account or environment boundaries, before binding the next account. */
  reset(): void {
    this.handlers.clear();
    this.subscribedWorkspaces.clear();
    this.subscribedSpaces.clear();
    this.capabilities = [];
    this.debugFilter = undefined;
    this.disconnect();
    this.unbindConfig?.();
    this.unbindConfig = null;
    this.config = null;
  }

  /** Release listeners and prevent further use of this instance. */
  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  private stopConnection(): void {
    this.connectGeneration++;
    this.connecting = false;
    this.reconnectTimer?.();
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.authenticated = false;
    const socket = this.ws;
    this.ws = null;
    socket?.close();
  }

  subscribe(workspaceId: string): void {
    this.subscribedWorkspaces.add(workspaceId);
    if (this.ws?.readyState === 1) {
      this.send(this.subscribeMessage(workspaceId));
    }
  }

  subscribeSpace(spaceId: string): void {
    this.subscribedSpaces.add(spaceId);
    if (this.authenticated) this.send({ type: 'subscribe_space', spaceId } satisfies WSClientMessage);
  }

  unsubscribeSpace(spaceId: string): void {
    this.subscribedSpaces.delete(spaceId);
    this.spacePresence.delete(spaceId);
    if (this.authenticated) this.send({ type: 'unsubscribe_space', spaceId } satisfies WSClientMessage);
  }

  sendPresence(spaceId: string, sessionId: string | null, state: SpacePresenceMember['state']): void {
    if (!this.subscribedSpaces.has(spaceId)) return;
    const message: SpacePresenceMessage = { type: 'presence', spaceId, sessionId, state };
    this.spacePresence.set(spaceId, message);
    if (this.authenticated) this.send(message);
  }

  /**
   * Tell the server whether the person is using this computer. The caller
   * repeats `active` while it holds; the server forgets it after a minute
   * without one. Safe while disconnected: the latest state goes out on the
   * next accepted connection.
   */
  setDeskPresence(state: DeskPresenceState): void {
    this.deskPresence = state;
    if (this.authenticated) this.send({ type: 'desk_presence', state } satisfies WSClientMessage);
  }

  /**
   * What this client can show, for example `threads`. Without `threads` the
   * server sends no thread rows. Call before `subscribe`; a later call takes
   * effect on the next subscribe or reconnect.
   */
  setCapabilities(capabilities: string[]): void {
    this.capabilities = [...capabilities];
  }

  private subscribeMessage(workspaceId: string): Record<string, unknown> {
    return { type: 'subscribe', workspaceId, ...(this.capabilities.length > 0 ? { capabilities: this.capabilities } : {}) };
  }

  unsubscribe(workspaceId: string): void {
    this.subscribedWorkspaces.delete(workspaceId);
    if (this.ws?.readyState === 1) {
      this.send({ type: 'unsubscribe', workspaceId });
    }
  }

  /**
   * Admin Debug panel: tell the server which account's debug events to stream
   * to this client (account id, 'system', 'all', or undefined for all). The
   * server only fans matching events to us, so a single-user filter doesn't
   * pull everyone's traffic over the wire.
   */
  setDebugFilter(owner: string | undefined): void {
    this.debugFilter = owner;
    if (this.ws?.readyState === 1) {
      this.send({ type: 'debug:filter', owner: owner ?? null });
    }
  }

  on<T>(event: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    const handlers = this.handlers.get(event)!;
    handlers.add(handler as EventHandler);

    // Return unsubscribe function
    return () => {
      handlers.delete(handler as EventHandler);
    };
  }

  private emit(event: string, payload: unknown): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        if (this.handlers.get(event) !== eventHandlers) return;
        try {
          handler(payload);
        } catch (err) {
          console.error(`Handler error for ${event}:`, err);
        }
      }
    }
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private scheduleReconnect(): void {
    // Already a reconnect queued — don't stack timers (focus/online events
    // and an onclose can all fire near-simultaneously).
    if (!this.shouldReconnect || !canRun(this.state) || this.reconnectTimer !== null) return;

    const baseDelay = Math.min(
      1000 * Math.pow(2, Math.min(this.reconnectAttempts, SLOW_RETRY_ATTEMPTS)),
      MAX_RECONNECT_DELAY_MS
    );
    const random = Math.max(0, Math.min(1, this.runtime.random()));
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, Math.max(
      this.retryNotBefore - this.runtime.scheduler.now(),
      baseDelay * (1 + this.runtime.reconnectJitter * random)
    ));
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, SLOW_RETRY_ATTEMPTS);

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    const generation = this.connectGeneration;
    this.reconnectTimer = this.runtime.scheduler.timeout(() => {
      if (generation !== this.connectGeneration || !this.shouldReconnect || !canRun(this.state)) return;
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /**
   * Heartbeat: ping the server every interval. If a tick fires while the
   * previous ping is still unanswered, the socket is half-open (laptop slept,
   * backend was killed without a clean close) — terminate it so onclose runs
   * and the backoff loop reconnects.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.lastTickAt = this.runtime.scheduler.now();
    const heartbeatGeneration = this.heartbeatGeneration;
    this.presenceTimer = this.runtime.scheduler.interval(() => {
      if (heartbeatGeneration !== this.heartbeatGeneration || !this.authenticated || !canRun(this.state)) return;
      for (const presence of this.spacePresence.values()) this.send(presence);
    }, 20_000);
    this.heartbeatTimer = this.runtime.scheduler.interval(() => {
      if (heartbeatGeneration !== this.heartbeatGeneration || !canRun(this.state)) return;
      const now = this.runtime.scheduler.now();
      const sinceLastTick = now - this.lastTickAt;
      this.lastTickAt = now;
      if (this.ws?.readyState !== 1) return;

      // A tick that arrived far too late tells us the TIMER was suspended,
      // not that the socket is unhealthy — so it must not be used as
      // evidence either way. Re-ping and judge on the next one. Without
      // this, returning to a backgrounded tab reliably killed a perfectly
      // good socket and started reconnect churn: the old check simply read
      // "a tick fired while awaitingPong" as proof of death.
      if (sinceLastTick > HEARTBEAT_INTERVAL_MS * THROTTLED_TICK_FACTOR) {
        this.awaitingPong = true;
        this.pingSentAt = now;
        this.send({ type: 'ping' });
        return;
      }

      if (this.awaitingPong) {
        // Wall clock, not "one tick has passed".
        if (now - this.pingSentAt < PONG_TIMEOUT_MS) return;
        console.warn('WebSocket heartbeat missed; reconnecting');
        this.awaitingPong = false;
        this.ws.close();
        return;
      }

      this.awaitingPong = true;
      this.pingSentAt = now;
      this.send({ type: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    this.heartbeatGeneration++;
    if (this.presenceTimer !== null) {
      this.presenceTimer();
      this.presenceTimer = null;
    }
    if (this.heartbeatTimer) {
      this.heartbeatTimer();
      this.heartbeatTimer = null;
    }
    this.awaitingPong = false;
  }

  private bindLifecycle(): void {
    const lifecycle = this.runtime.lifecycle;
    // Ignore callbacks that a host delivers after listener disposal.
    const binding = {};
    this.lifecycleBinding = binding;
    this.unbindLifecycle = () => { this.lifecycleBinding = null; };
    const unbind = lifecycle.subscribe((event) => {
      if (this.lifecycleBinding !== binding || !this.shouldReconnect) return;
      if (event.type === 'wake') {
        this.state = lifecycle.getSnapshot();
        if (canRun(this.state)) this.wake();
        return;
      }
      const wasRunning = canRun(this.state);
      this.state = event.state;
      if (!canRun(this.state)) {
        this.stopConnection();
        this.emit('connection:status', { connected: false });
      } else if (!wasRunning) {
        this.wake();
      }
    });
    if (this.lifecycleBinding === binding) this.unbindLifecycle = unbind;
    else unbind();
  }

  private lifecycleBinding: object | null = null;

  private wake(): void {
    if (!this.shouldReconnect || !canRun(this.state)) return;
    if (this.ws?.readyState === 1) {
      this.probeLiveness();
      return;
    }
    if (this.ws?.readyState === 0 || this.connecting) return;
    if (this.runtime.scheduler.now() < this.retryNotBefore) {
      this.scheduleReconnect();
      return;
    }
    this.reconnectTimer?.();
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    void this.connect();
  }

  /**
   * Force an immediate liveness check on a socket we believe is open, and
   * restart the heartbeat cadence from now. Used on wake, where the interval
   * timer may have been throttled or frozen for minutes.
   */
  private probeLiveness(): void {
    if (this.ws?.readyState !== 1) return;
    if (this.awaitingPong) {
      // A ping was already outstanding across the sleep/hide. Nothing came
      // back, so stop trusting this socket and let onclose → backoff run.
      this.awaitingPong = false;
      this.ws.close();
      return;
    }
    this.startHeartbeat();
    this.awaitingPong = true;
    this.pingSentAt = this.runtime.scheduler.now();
    this.send({ type: 'ping' });
  }
}


export const wsClient = new WebSocketClient();
