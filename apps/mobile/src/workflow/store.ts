import { cloudProviders, environments, features, pullRequests, repositories, tasks, workbenches, workspaces, wsClient,
  type ClientLifecycle, type CodeReviewDismissReason, type CodeReviewFinding, type CodeReviewPreset, type CodeReviewPublic,
  type PRReviewEvent, type PRRow } from '@talyn/client/native';
import type { CreateWorkbenchInput, Workbench, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';

import { cacheKey, canCompose, canStartSend, deliveryReducer, EMPTY_DELIVERY, EMPTY_RESOURCE, emptyTranscript, explicitSendFailure,
  failureState, mergeEvents, PAGE_CEILING, PAGE_SIZE, releaseOlder, sameScope, windowFull, selectWorkbenches, upsertWorkbench, withChat, workbenchKind, workbenchTitle,
  type Delivery, type Entity, type Resource, type Scope, type Transcript } from './model';
import { applyPrUpdate, jsonEqual, mergeRowUpdate, reuseRows, type PullRequestUpdate } from './prPatch';

export const workflowApi = { workbenches, pullRequests, features, repositories, cloudProviders, workspaces, environments, tasks };
export type WorkflowApi = typeof workflowApi;
export type WorkflowSocket = Pick<typeof wsClient, 'connect' | 'on' | 'subscribe' | 'unsubscribe' | 'setCapabilities'>;
interface Entry {
  entity: Entity; id: string; state: Resource<unknown>; pending?: Promise<void>; revision: number; watchers: number; again: boolean;
  invalidated: number; requested: number;
  /** The owed refetch came from a socket echo, so it waits for `EVENT_REFETCH_INTERVAL` since the last request. */
  throttled: boolean;
  lastRequestAt: number;
}
export interface LocalState { draft: string; delivery: Delivery; offset: number; following: boolean; selectedChat: string | null }
const EMPTY_LOCAL: LocalState = Object.freeze({ draft: '', delivery: EMPTY_DELIVERY, offset: 0, following: true, selectedChat: null });
const CACHE_LIMIT = 32;
const SEND_TIMEOUT = 30_000;
/** Events read after a tool call to find its result. A result follows its call within a few events. */
export const FULL_LOOKUP = 50;
/** Bursts of invalidations inside this window cost one refetch. */
export const RECOVERY_DEBOUNCE = 250;
/** A busy repository emits constantly. Echo-driven refetches of one entry run at most this often. */
export const EVENT_REFETCH_INTERVAL = 2_000;
type PrDetail = { row: PRRow; fresh: unknown };
type MergeQueueFields = Pick<PRRow, 'mergeQueued' | 'mergeQueue'>;
/** `GET /pull-requests/:id/code-review`: the review and its findings. */
export type CodeReviewData = Awaited<ReturnType<WorkflowApi['pullRequests']['codeReview']>>;

/**
 * One in-memory owner for snapshots, cursors, drafts, and delivery state.
 *
 * Socket echoes patch rows in place where the payload carries the whole row, and
 * otherwise mark only the entries the echo names as owed a refetch. Refetches run
 * in the background with the current data still on screen.
 */
export class WorkflowStore {
  private scope: Scope | null = null;
  private generation = 0;
  private entries = new Map<string, Entry>();
  private locals = new Map<string, LocalState>();
  private listeners = new Set<() => void>();
  private unbind: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = 0;
  private connected = false;
  private active: boolean;
  private stopped = false;
  private loads = 0;
  private sends = new Map<string, Promise<void>>();
  constructor(private lifecycle: ClientLifecycle, readonly api: WorkflowApi = workflowApi, private socket: WorkflowSocket = wsClient) {
    this.active = this.canRead();
    this.unbind.push(lifecycle.subscribe(() => {
      const active = this.canRead();
      if (!active) this.markStale();
      if (active && !this.active) { this.markStale(); this.scheduleRecovery(); }
      this.active = active;
      this.emit();
    }));
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  getScope = () => this.scope;
  /** The count of successful fetches so far. */
  loadCount = () => this.loads;
  private canRead() { const state = this.lifecycle.getSnapshot(); return state.activity === 'active' && state.reachability !== 'offline'; }
  canSend() { return Boolean(this.scope && this.canRead() && this.lifecycle.getSnapshot().reachability === 'online'); }
  setScope(next: Scope | null) {
    if (sameScope(next, this.scope) || this.stopped) return;
    const prior = this.scope;
    this.generation++;
    if (prior) this.socket.unsubscribe(prior.workspace);
    this.unbind.splice(1).forEach((unbind) => unbind());
    clearTimeout(this.timer); this.timer = undefined;
    this.scope = next; this.entries.clear(); this.locals.clear(); this.sends.clear(); this.connected = false;
    if (next) {
      const generation = this.generation;
      const current = () => generation === this.generation && this.scope === next;
      const on = <T,>(event: string, handler: (payload: T) => void) => {
        this.unbind.push(this.socket.on<T>(event, (payload) => { if (current()) handler(payload); }));
      };
      this.socket.setCapabilities(['threads']);
      on<{ connected: boolean }>('connection:status', ({ connected }) => {
        if (!connected) { this.connected = false; this.markStale(); }
        else if (!this.connected) { this.connected = true; this.markStale(); this.scheduleRecovery(); }
      });
      on<{ workbench: Workbench }>('workbench:updated', ({ workbench }) => {
        if (workbench?.workspaceId === next.workspace) this.patchWorkbench(workbench);
      });
      on<{ id: string }>('workbench:deleted', ({ id }) => this.deleted(id));
      on<{ chat: WorkbenchChat }>('workbench:chat', ({ chat }) => { if (chat?.workbenchId) this.patchChat(chat); });
      on<{ chatId: string; events: WorkbenchEvent[] }>('workbench:event', ({ chatId, events }) => {
        const entry = this.entry('transcript', chatId, false);
        if (!entry || entry.state.status === 'deleted' || entry.state.status === 'unauthorized') return;
        const reading = this.local(chatId).following ? 'newest' : 'older';
        const data = mergeEvents(chatId, entry.state.data as Transcript | undefined ?? emptyTranscript(), events ?? [], 'live', undefined, reading);
        if (data === entry.state.data) return;
        entry.state = { ...entry.state, data, stale: entry.state.stale || data.gap };
        this.emit();
        if (data.gap) this.invalidateEntry(entry, false);
      });
      on<PullRequestUpdate>('pull_request:updated', (update) => { if (update?.id) this.patchPullRequest(update); });
      // The shared client owns reconnect and restores workspace subscriptions.
      this.socket.subscribe(next.workspace);
      void this.socket.connect().catch(() => this.markStale());
    }
    this.emit();
  }
  private entry(entity: Entity, id = '', create = true): Entry | undefined {
    if (!this.scope) return undefined;
    const key = cacheKey(this.scope, entity, id);
    let entry = this.entries.get(key);
    if (!entry && create) {
      this.prune();
      entry = { entity, id, state: EMPTY_RESOURCE, revision: 0, watchers: 0, again: false, invalidated: 1, requested: 0, throttled: false, lastRequestAt: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }
  private prune() {
    if (this.entries.size < CACHE_LIMIT) return;
    for (const [key, entry] of this.entries) {
      if (!entry.watchers && !entry.pending) { this.entries.delete(key); if (this.entries.size < CACHE_LIMIT) break; }
    }
  }
  read<T>(entity: Entity, id = ''): Resource<T> { return (this.entry(entity, id, false)?.state ?? EMPTY_RESOURCE) as Resource<T>; }
  watch(entity: Entity, id = '', force = false) {
    const entry = this.entry(entity, id);
    if (!entry) return () => {};
    entry.watchers++;
    if (force) { entry.invalidated++; entry.throttled = false; entry.state = { ...entry.state, stale: true }; }
    if (entry.state.stale || entry.state.status === 'idle') void this.load(entity, id);
    return () => { entry.watchers = Math.max(0, entry.watchers - 1); };
  }
  private markStale() {
    for (const entry of this.entries.values()) { entry.invalidated++; entry.throttled = false; entry.state = { ...entry.state, stale: true }; }
    this.emit();
  }
  /** Owe one entry a background refetch. Its data stays on screen. */
  private invalidateEntry(entry: Entry | undefined, throttled = true) {
    if (!entry || entry.state.status === 'deleted' || entry.state.status === 'unauthorized') return;
    entry.invalidated++;
    entry.throttled = throttled && (entry.throttled || entry.invalidated === entry.requested + 1);
    if (!entry.state.stale) entry.state = { ...entry.state, stale: true };
    if (entry.pending) entry.again = true;
    this.scheduleRecovery();
  }
  private updateData<T>(entry: Entry | undefined, change: (data: T) => T) {
    if (!entry || entry.state.data === undefined || entry.state.status === 'deleted' || entry.state.status === 'unauthorized') return false;
    const data = change(entry.state.data as T);
    if (data === entry.state.data) return false;
    entry.state = { ...entry.state, data };
    // A fetch in flight can carry an older snapshot. Ask for one more after it.
    if (entry.pending) this.invalidateEntry(entry);
    return true;
  }
  private patchWorkbench(item: Workbench) {
    let changed = this.updateData<Workbench>(this.entry('workbench', item.id, false),
      (old) => ({ ...item, chats: item.chats ?? old.chats }));
    const kind = workbenchKind(item);
    for (const list of ['sessions', 'threads'] as const) {
      const belongs = !item.archivedAt && (list === 'sessions' ? kind === 'session' : kind === 'thread');
      changed = this.updateData<Workbench[]>(this.entry(list, '', false), (rows) => upsertWorkbench(rows, item, belongs)) || changed;
    }
    for (const entry of this.entries.values()) {
      if (entry.entity !== 'children') continue;
      changed = this.updateData<Workbench[]>(entry, (rows) => upsertWorkbench(rows, item, item.threadId === entry.id)) || changed;
    }
    if (changed) this.emit();
  }
  private patchChat(chat: WorkbenchChat) {
    const patch = (rows: Workbench[]) => rows.some((row) => row.id === chat.workbenchId) ? rows.map((row) => withChat(row, chat)) : rows;
    let changed = this.updateData<Workbench>(this.entry('workbench', chat.workbenchId, false), (item) => withChat(item, chat));
    for (const entry of this.entries.values()) {
      if (entry.entity === 'sessions' || entry.entity === 'threads' || entry.entity === 'children') changed = this.updateData(entry, patch) || changed;
    }
    if (changed) this.emit();
  }
  private patchPullRequest(update: PullRequestUpdate) {
    const list = this.entry('attention', '', false);
    let changed = this.updateData<PRRow[]>(list, (rows) => {
      const result = applyPrUpdate(rows, update);
      if (result.refetch) this.invalidateEntry(list);
      return result.rows;
    });
    const detail = this.entry('pr', update.id, false);
    changed = this.updateData<PrDetail>(detail, (data) => {
      const row = mergeRowUpdate(data.row, update);
      return row === data.row ? data : { ...data, row };
    }) || changed;
    // The provider detail and queue history are not in the echo. Refresh them quietly.
    this.invalidateEntry(detail);
    if (update.mergeQueue !== undefined || update.mergeQueued !== undefined) this.invalidateEntry(this.entry('timeline', update.id, false));
    // The echo carries the review but not its findings, so the findings are refetched.
    if (update.codeReview !== undefined) {
      const review = this.entry('codeReview', update.id, false);
      changed = this.updateData<CodeReviewData>(review, (data) => jsonEqual(data.review, update.codeReview) ? data
        : { ...data, review: update.codeReview ?? null }) || changed;
      this.invalidateEntry(review);
    }
    if (changed) this.emit();
  }
  private scheduleRecovery(delay = RECOVERY_DEBOUNCE) {
    if (!this.scope || !this.canRead()) return;
    const at = Date.now() + delay;
    if (this.timer && this.timerAt <= at) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => this.recover(), delay);
  }
  private recover() {
    this.timer = undefined;
    let wait = Infinity;
    for (const entry of this.entries.values()) {
      if (!entry.watchers || entry.invalidated <= entry.requested || !entry.state.stale || entry.pending ||
        entry.state.status === 'deleted' || entry.state.status === 'unauthorized') continue;
      const remaining = entry.throttled ? entry.lastRequestAt + EVENT_REFETCH_INTERVAL - Date.now() : 0;
      if (remaining > 0) { wait = Math.min(wait, remaining); continue; }
      void this.load(entry.entity, entry.id);
    }
    if (wait < Infinity) this.scheduleRecovery(wait);
  }
  async load(entity: Entity, id = ''): Promise<void> {
    const scope = this.scope;
    const entry = this.entry(entity, id);
    if (!scope || !entry) return;
    if (entry.pending) return entry.pending;
    if (!this.canRead()) {
      entry.state = { ...entry.state, status: entry.state.data ? entry.state.status : 'offline', stale: true, refreshing: false };
      this.emit(); return;
    }
    const generation = this.generation; const revision = ++entry.revision;
    entry.requested = entry.invalidated;
    entry.throttled = false;
    entry.lastRequestAt = Date.now();
    const valid = () => generation === this.generation && revision === entry.revision && !this.stopped;
    entry.state = { ...entry.state, status: entry.state.data ? entry.state.status : 'loading', refreshing: true };
    this.emit();
    entry.pending = (async () => {
      try {
        let data = await this.fetch(entity, id, scope, entry.state.data);
        if (!valid()) return;
        if (entity === 'transcript' && entry.state.data) {
          const latest = entry.state.data as Transcript;
          data = mergeEvents(id, data as Transcript, latest.events, 'live');
        }
        const gap = entity === 'transcript' && (data as Transcript).gap;
        entry.state = { status: 'ready', data, stale: Boolean(gap) || !this.canRead() || entry.invalidated > entry.requested, refreshing: false,
          updatedAt: Date.now(), version: ++this.loads };
      } catch (error) {
        if (!valid()) return;
        const status = failureState(error);
        if (status === 'deleted' || status === 'unauthorized') this.clearEntityDrafts(entity, id);
        entry.state = { ...entry.state, status, stale: true, refreshing: false,
          ...(status === 'deleted' || status === 'unauthorized' ? { data: undefined } : {}) };
      } finally {
        if (valid()) {
          entry.pending = undefined;
          this.emit();
          if (entry.again) { entry.again = false; this.scheduleRecovery(); }
        }
      }
    })();
    return entry.pending;
  }
  private async authorizedWorkbench(id: string, scope: Scope) {
    const item = await this.api.workbenches.get(id);
    if (item.workspaceId !== scope.workspace) throw { status: 403 };
    return item;
  }
  private async authorizedPr(id: string, scope: Scope) {
    const item = await this.api.pullRequests.get(id);
    if (item.row.workspaceId !== scope.workspace) throw { status: 403 };
    return item;
  }
  private async fetch(entity: Entity, id: string, scope: Scope, data: unknown): Promise<unknown> {
    const assertScope = () => { if (this.scope !== scope) throw new Error('Scope changed.'); };
    switch (entity) {
      case 'sessions': case 'threads': {
        const kind = entity === 'sessions' ? 'session' : 'thread';
        return selectWorkbenches(await this.api.workbenches.list(scope.workspace, { kinds: [kind] }), kind, scope.workspace);
      }
      case 'attention': return reuseRows(data as PRRow[] | undefined,
        (await this.api.pullRequests.list({ workspaceId: scope.workspace, state: 'open', relationship: 'all' }))
          .filter((row) => row.workspaceId === scope.workspace));
      case 'workbench': return this.authorizedWorkbench(id, scope);
      case 'children': {
        await this.authorizedWorkbench(id, scope);
        assertScope();
        return (await this.api.workbenches.threadSessions(id)).filter((item) => item.workspaceId === scope.workspace && item.threadId === id);
      }
      case 'readiness': return this.api.workbenches.readiness(scope.workspace);
      case 'pr': return this.authorizedPr(id, scope);
      case 'timeline': await this.authorizedPr(id, scope); assertScope(); return this.api.pullRequests.mergeQueueTimeline(id);
      case 'transcript': return this.reconcile(id, scope, data as Transcript | undefined);
      case 'features': return this.api.features.get();
      case 'repositories': return (await this.api.repositories.list(scope.workspace)).filter((repo) => repo.workspaceId === scope.workspace);
      case 'providers': return this.api.cloudProviders.list(scope.workspace);
      case 'workspace': {
        const item = await this.api.workspaces.get(scope.workspace);
        if (item.id !== scope.workspace) throw { status: 403 };
        return item;
      }
      case 'environments': return this.api.environments.list();
      case 'codeReview': case 'prDescription': case 'prFiles': case 'prReviews': {
        // A held row answers the scope question without a live GitHub read.
        const held = this.findPr(id);
        if (!held) await this.authorizedPr(id, scope);
        else if (held.workspaceId !== scope.workspace) throw { status: 403 };
        assertScope();
        if (entity === 'prDescription') return this.api.pullRequests.description(id);
        if (entity === 'prFiles') return this.api.pullRequests.files(id);
        if (entity === 'prReviews') return this.api.pullRequests.reviews(id);
        return this.api.pullRequests.codeReview(id);
      }
    }
  }
  private async reconcile(chatId: string, scope: Scope, prior?: Transcript): Promise<Transcript> {
    let state = prior ?? emptyTranscript();
    // Socket events alone set no history boundary. The newest page does; the held events merge in after.
    if (!prior?.anchored || !prior.events.length) {
      const page = await this.api.workbenches.events(chatId, { before: 'latest', limit: PAGE_SIZE, ceiling: PAGE_CEILING });
      if (this.scope !== scope) throw new Error('Scope changed.');
      state = mergeEvents(chatId, emptyTranscript(), page.events, 'rest', page);
      // Older servers ignore backward paging. Continue only within a bounded recovery batch.
      if (page.oldestSeq !== undefined) return state;
    }
    for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
      if (this.scope !== scope) throw new Error('Scope changed.');
      const cursor = state.cursor;
      const page = await this.api.workbenches.events(chatId, { after: cursor, limit: PAGE_SIZE });
      if (this.scope !== scope) throw new Error('Scope changed.');
      state = mergeEvents(chatId, state, page.events, 'rest', page);
      if (state.cursor === cursor || page.events.length < PAGE_SIZE) return state;
    }
    return { ...state, gap: true };
  }
  async latest(chatId: string) {
    const entry = this.entry('transcript', chatId, false);
    if (!entry || entry.pending) return;
    entry.state = { ...entry.state, data: undefined, stale: true };
    this.updateLocal(chatId, { offset: 0, following: true });
    await this.load('transcript', chatId);
  }
  /**
   * The page of history just older than the window. The newest events stay; when the window
   * is full, the transcript is marked `limited` instead and nothing is fetched.
   */
  async older(chatId: string) {
    const entry = this.entry('transcript', chatId, false);
    const prior = entry?.state.data as Transcript | undefined;
    if (!entry || !prior?.hasOlder || !prior.oldest || prior.limited || prior.olderFailed || entry.pending || !this.canRead()) return;
    if (windowFull(prior)) { entry.state = { ...entry.state, data: { ...prior, limited: true } }; this.emit(); return; }
    const generation = this.generation; const revision = ++entry.revision;
    const valid = () => generation === this.generation && revision === entry.revision;
    entry.state = { ...entry.state, refreshing: true }; this.emit();
    entry.pending = (async () => {
      try {
        const page = await this.api.workbenches.events(chatId, { before: prior.oldest!, limit: PAGE_SIZE, ceiling: PAGE_CEILING });
        if (!valid()) return;
        if (page.oldestSeq === undefined) throw new Error('Older history is not supported.');
        entry.state = { ...entry.state, data: mergeEvents(chatId, entry.state.data as Transcript, page.events, 'older', page), refreshing: false };
      } catch {
        // The held window stays on screen. The reader retries from the top of the list.
        if (valid()) entry.state = { ...entry.state, data: { ...entry.state.data as Transcript, olderFailed: true }, refreshing: false };
      } finally { if (valid()) { entry.pending = undefined; this.emit(); } }
    })();
    return entry.pending;
  }
  /** Ask for older history again after a failed page. */
  retryOlder(chatId: string) {
    const entry = this.entry('transcript', chatId, false);
    const data = entry?.state.data as Transcript | undefined;
    if (!entry || !data?.olderFailed) return Promise.resolve();
    entry.state = { ...entry.state, data: { ...data, olderFailed: false } };
    return this.older(chatId);
  }
  /** The reader is back at the newest message: free older events past `RELEASE_AT`. */
  release(chatId: string) {
    const entry = this.entry('transcript', chatId, false);
    const data = entry?.state.data as Transcript | undefined;
    if (!entry || !data || entry.pending) return;
    const next = releaseOlder(data);
    if (next === data) return;
    entry.state = { ...entry.state, data: next }; this.emit();
  }
  /**
   * The stored events from `seq` on, whole, as the server holds them. For a tool call the
   * window keeps only in part. Nothing here enters the window.
   */
  async fullEvents(chatId: string, seq: number, limit = FULL_LOOKUP) {
    if (!this.scope || !this.canRead()) throw new Error('Offline.');
    const page = await this.api.workbenches.events(chatId, { after: Math.max(0, seq - 1), limit });
    return page.events.filter((item) => item.chatId === chatId);
  }
  private localKey(id: string) { return this.scope ? cacheKey(this.scope, 'transcript', id) : null; }
  local(id: string): LocalState { const key = this.localKey(id); return key ? this.locals.get(key) ?? EMPTY_LOCAL : EMPTY_LOCAL; }
  updateLocal(id: string, patch: Partial<LocalState>) {
    const key = this.localKey(id); if (!key) return;
    this.locals.set(key, { ...this.local(id), ...patch }); this.emit();
  }
  /** Keep a list's scroll position without a store update. A scroll fires many times a second, and no screen reads the offset live. */
  rememberOffset(id: string, offset: number) {
    const key = this.localKey(id); if (!key) return;
    const held = this.local(id);
    if (held.offset !== offset) this.locals.set(key, { ...held, offset });
  }
  private clearEntityDrafts(entity: Entity, id: string) {
    if (entity === 'transcript') { const key = this.localKey(id); if (key) this.locals.delete(key); }
    if (entity === 'workbench') {
      const selectedKey = this.localKey(`selected:${id}`); if (selectedKey) this.locals.delete(selectedKey);
      const old = this.entry('workbench', id, false)?.state.data as Workbench | undefined;
      for (const chat of old?.chats ?? []) { const key = this.localKey(chat.id); if (key) this.locals.delete(key);
        const transcript = this.entry('transcript', chat.id, false);
        if (transcript) { transcript.revision++; transcript.pending = undefined; transcript.state = { status: 'deleted', data: undefined, stale: true, refreshing: false }; }
      }
    }
  }
  private deleted(id: string) {
    const entry = this.entry('workbench', id, false);
    this.clearEntityDrafts('workbench', id);
    if (entry) { entry.revision++; entry.pending = undefined; entry.state = { status: 'deleted', data: undefined, stale: true, refreshing: false }; }
    for (const list of this.entries.values()) {
      if (list.entity === 'sessions' || list.entity === 'threads' || list.entity === 'children') {
        this.updateData<Workbench[]>(list, (rows) => rows.some((row) => row.id === id) ? rows.filter((row) => row.id !== id) : rows);
      }
    }
    this.emit();
  }
  async checkDelivery(workbenchId: string, chatId: string) {
    const generation = this.generation;
    await Promise.all([this.load('workbench', workbenchId), this.load('transcript', chatId)]);
    if (generation !== this.generation) return;
    const workbench = this.read<Workbench>('workbench', workbenchId);
    const transcript = this.read<Transcript>('transcript', chatId);
    if (workbench.status === 'ready' && !workbench.stale && transcript.status === 'ready' && !transcript.stale) {
      // No request ID exists in this contract. Refresh permits an informed manual retry only.
      this.updateLocal(chatId, { delivery: deliveryReducer(this.local(chatId).delivery, { type: 'reconciled' }) });
    }
  }
  /** Sending needs a known, readable conversation and a confirmed connection. The server validates the rest. */
  send(workbenchId: string, chatId: string, manualRetry = false): Promise<void> {
    const pending = this.sends.get(chatId); if (pending) return pending;
    const item = this.read<Workbench>('workbench', workbenchId);
    const chat = item.data?.chats?.find((value) => value.id === chatId);
    const local = this.local(chatId);
    if (!this.canSend() || !canCompose(item.data, chat) || !local.draft.trim() || !canStartSend(local.delivery, manualRetry)) return Promise.resolve();
    const generation = this.generation; const draft = local.draft;
    const valid = () => generation === this.generation && Boolean(this.read<Workbench>('workbench', workbenchId).data);
    this.updateLocal(chatId, { delivery: deliveryReducer(local.delivery, { type: 'start' }) });
    let timeout: ReturnType<typeof setTimeout>;
    const request = this.api.workbenches.sendMessage(chatId, { text: draft });
    const result = Promise.race([request, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('timeout')), SEND_TIMEOUT); })]);
    const promise = result.then((ack) => {
      if (!valid()) return;
      this.updateLocal(chatId, { draft: this.local(chatId).draft === draft ? '' : this.local(chatId).draft,
        delivery: deliveryReducer(this.local(chatId).delivery, { type: 'ack', queued: ack.queued }) });
      this.invalidateEntry(this.entry('workbench', workbenchId, false), false);
      this.invalidateEntry(this.entry('transcript', chatId, false), false);
      this.emit();
    }).catch((error: unknown) => {
      if (!valid()) return;
      this.updateLocal(chatId, { delivery: deliveryReducer(this.local(chatId).delivery, { type: explicitSendFailure(error) ? 'failed' : 'unknown' }) });
      if (!explicitSendFailure(error)) void this.checkDelivery(workbenchId, chatId);
    }).finally(() => { clearTimeout(timeout); if (generation === this.generation) this.sends.delete(chatId); });
    this.sends.set(chatId, promise);
    return promise;
  }
  /** Owe one entry a quiet refetch, e.g. after an action the socket may not echo. */
  refresh(entity: Entity, id = '') { this.invalidateEntry(this.entry(entity, id, false), false); }
  /**
   * Pull to refresh on the PR list. It asks GitHub first, as the Refresh button on desktop and web does.
   * Without that, it only re-reads the backend's cached list. A failed poll still re-reads the list.
   */
  async refreshPullRequests(): Promise<void> {
    if (this.canRead()) await this.api.repositories.forcePoll().catch(() => undefined);
    await this.load('attention');
  }

  // -------------------------------------------------------------------------
  // Actions. Each updates held rows first where web does, then the server row wins.
  // -------------------------------------------------------------------------

  /** The newest held copy of a workbench, from its own entry or any list. */
  findWorkbench(id: string): Workbench | undefined {
    const own = this.read<Workbench>('workbench', id).data;
    if (own) return own;
    for (const entry of this.entries.values()) {
      if (entry.entity !== 'sessions' && entry.entity !== 'threads' && entry.entity !== 'children') continue;
      const found = (entry.state.data as Workbench[] | undefined)?.find((item) => item.id === id);
      if (found) return found;
    }
    return undefined;
  }
  /** Apply a server row everywhere it is held. Rows of another workspace are ignored. */
  applyWorkbench(item: Workbench) {
    if (item && this.scope && item.workspaceId === this.scope.workspace) this.patchWorkbench(item);
  }
  async renameWorkbench(id: string, title: string) {
    const previous = this.findWorkbench(id);
    const next = title.trim();
    if (!previous || !next || next === workbenchTitle(previous)) return;
    this.applyWorkbench({ ...previous, title: next });
    try {
      this.applyWorkbench(await this.api.workbenches.update(id, { title: next }));
    } catch (error) {
      const current = this.findWorkbench(id);
      if (current?.title === next) this.applyWorkbench({ ...current, title: previous.title ?? null });
      throw error;
    }
  }
  async createWorkbench(input: CreateWorkbenchInput) {
    const item = await this.api.workbenches.create(input);
    this.applyWorkbench(item);
    return item;
  }
  async archiveWorkbench(id: string) { this.applyWorkbench(await this.api.workbenches.archive(id)); }
  async restoreWorkbench(id: string) { this.applyWorkbench(await this.api.workbenches.restore(id)); }
  async retryWorkbench(id: string) { this.applyWorkbench(await this.api.workbenches.retry(id)); }
  async wakeWorkbench(id: string) {
    const answer = await this.api.workbenches.wake(id);
    this.refresh('workbench', id);
    return answer;
  }
  async stopChat(workbenchId: string, chatId: string) {
    await this.api.workbenches.cancel(chatId);
    this.refresh('workbench', workbenchId);
    this.refresh('transcript', chatId);
  }

  /** The newest held copy of a pull request row. */
  findPr(id: string): PRRow | undefined {
    return this.read<PrDetail>('pr', id).data?.row ?? this.read<PRRow[]>('attention').data?.find((row) => row.id === id);
  }
  /**
   * The row from the open-PR list only. A cached detail may predate an access change, so it is never
   * drawn before the current read; the list is the data the list screen already shows.
   */
  listedPr(id: string): PRRow | undefined {
    return this.read<PRRow[]>('attention').data?.find((row) => row.id === id);
  }
  /** Patch a held pull request row in the list and in its detail. */
  patchPr(id: string, patch: Partial<PRRow>) {
    let changed = this.updateData<PRRow[]>(this.entry('attention', '', false),
      (rows) => rows.some((row) => row.id === id) ? rows.map((row) => row.id === id ? { ...row, ...patch } : row) : rows);
    changed = this.updateData<PrDetail>(this.entry('pr', id, false), (data) => ({ ...data, row: { ...data.row, ...patch } })) || changed;
    if (changed) this.emit();
  }
  /** Membership only. The echo carries the real queue entry, so none is invented here. */
  async setMergeQueue(id: string, enabled: boolean) {
    const row = this.findPr(id);
    const prior: MergeQueueFields | null = row ? { mergeQueued: row.mergeQueued, mergeQueue: row.mergeQueue } : null;
    this.patchPr(id, { mergeQueued: enabled, ...(enabled ? {} : { mergeQueue: null }) });
    try {
      await this.api.pullRequests.setMergeQueue(id, enabled);
      this.refresh('timeline', id);
    } catch (error) {
      if (prior) this.patchPr(id, prior);
      throw error;
    }
  }
  /** Hide a review request from the Reviews list, or bring it back. Optimistic, like the queue toggle. */
  async setReviewHidden(id: string, hidden: boolean) {
    const prior = this.findPr(id)?.reviewHiddenAt ?? null;
    this.patchPr(id, { reviewHiddenAt: hidden ? new Date().toISOString() : null });
    try {
      await this.api.pullRequests.setReviewHidden(id, hidden);
    } catch (error) {
      this.patchPr(id, { reviewHiddenAt: prior });
      throw error;
    }
  }
  async setAutoKeep(id: string, enabled: boolean) {
    const row = this.findPr(id);
    const prior = row ? { autoKeepMergeable: row.autoKeepMergeable, autoMergeState: row.autoMergeState } : null;
    this.patchPr(id, { autoKeepMergeable: enabled, autoMergeState: enabled ? { attempts: 0, paused: false } : null });
    try {
      await this.api.pullRequests.setAutoKeepMergeable(id, enabled);
    } catch (error) {
      if (prior) this.patchPr(id, prior);
      throw error;
    }
  }
  async mergePr(id: string) {
    const result = await this.api.pullRequests.merge(id);
    this.refresh('pr', id); this.refresh('attention');
    return result;
  }
  /** Approve or request changes as the person. The answer carries the refreshed row. */
  async submitPrReview(id: string, event: PRReviewEvent, body?: string) {
    const result = await this.api.pullRequests.submitReview(id, { event, ...(body ? { body } : {}) });
    if (result?.row) this.patchPr(id, result.row);
    this.refresh('pr', id); this.refresh('attention');
    return result;
  }
  async resubmitMergeQueue(id: string) {
    await this.api.pullRequests.resubmitMergeQueue(id);
    this.refresh('pr', id); this.refresh('timeline', id);
  }

  // Code review. The server answer wins; the findings are refetched after each action.

  /** Put a review the server returned on the PR row and the review entry. */
  private applyCodeReview(id: string, review: CodeReviewPublic | null) {
    this.patchPr(id, { codeReview: review });
    if (this.updateData<CodeReviewData>(this.entry('codeReview', id, false), (data) => jsonEqual(data.review, review) ? data : { ...data, review })) this.emit();
  }
  private patchFindings(id: string, ids: ReadonlySet<string>, patch: Partial<CodeReviewFinding>) {
    if (this.updateData<CodeReviewData>(this.entry('codeReview', id, false), (data) => data.findings.some((finding) => ids.has(finding.id))
      ? { ...data, findings: data.findings.map((finding) => ids.has(finding.id) ? { ...finding, ...patch } : finding) } : data)) this.emit();
  }
  async startCodeReview(id: string, preset: CodeReviewPreset, reset = false) {
    const review = await this.api.pullRequests.startCodeReview(id, { preset, ...(reset ? { reset: true } : {}) });
    this.applyCodeReview(id, review);
    this.refresh('codeReview', id);
    return review;
  }
  /** Stopping a fix stops its task, not the review. A review in flight is cancelled. Mirrors web. */
  async stopCodeReview(id: string, fixTaskId?: string | null) {
    try {
      if (fixTaskId) await this.api.tasks.stop(fixTaskId);
      else this.applyCodeReview(id, await this.api.pullRequests.cancelCodeReview(id));
    } finally { this.refresh('codeReview', id); }
  }
  async fixCodeReviewFindings(id: string, findingIds: string[]) {
    const result = await this.api.pullRequests.fixCodeReviewFindings(id, findingIds);
    if (result?.review) this.applyCodeReview(id, result.review);
    if (result?.taskId) this.patchPr(id, { taskId: result.taskId });
    this.refresh('codeReview', id);
    return result;
  }
  async postCodeReviewFindings(id: string, findingIds: string[]) {
    const result = await this.api.pullRequests.postCodeReviewFindings(id, findingIds);
    if (result.review) this.applyCodeReview(id, result.review);
    this.refresh('codeReview', id);
    return result;
  }
  async dismissCodeReviewFinding(id: string, findingId: string, reason?: CodeReviewDismissReason) {
    const prior = this.read<CodeReviewData>('codeReview', id).data?.findings.find((finding) => finding.id === findingId);
    this.patchFindings(id, new Set([findingId]), { disposition: 'dismissed', dismissedReason: reason ?? null });
    try {
      this.applyCodeReview(id, await this.api.pullRequests.dismissCodeReviewFinding(id, findingId, reason));
    } catch (error) {
      if (prior) this.patchFindings(id, new Set([findingId]), { disposition: prior.disposition, dismissedReason: prior.dismissedReason ?? null });
      throw error;
    } finally { this.refresh('codeReview', id); }
  }
  async undismissCodeReviewFinding(id: string, findingId: string) {
    try {
      this.applyCodeReview(id, await this.api.pullRequests.undismissCodeReviewFinding(id, findingId));
    } finally { this.refresh('codeReview', id); }
  }
  /** One finding with its body, suggestion and anchor, which the list leaves out. */
  codeReviewFinding(id: string, findingId: string) { return this.api.pullRequests.codeReviewFinding(id, findingId); }

  dispose() {
    this.setScope(null); this.stopped = true; this.unbind.forEach((unbind) => unbind()); this.listeners.clear(); clearTimeout(this.timer);
  }
}
