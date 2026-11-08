import { pullRequests, workbenches, wsClient, type ClientLifecycle } from '@talyn/client/native';
import type { Workbench, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';

import { cacheKey, canCompose, canStartSend, deliveryReducer, EMPTY_DELIVERY, EMPTY_RESOURCE, emptyTranscript, explicitSendFailure,
  failureState, mergeEvents, PAGE_SIZE, sameScope, selectWorkbenches, type Delivery, type Entity, type Resource,
  type Scope, type Transcript } from './model';

export const workflowApi = { workbenches, pullRequests };
export type WorkflowApi = typeof workflowApi;
export type WorkflowSocket = Pick<typeof wsClient, 'connect' | 'on' | 'subscribe' | 'unsubscribe' | 'setCapabilities'>;
interface Entry { entity: Entity; id: string; state: Resource<unknown>; pending?: Promise<void>; revision: number; watchers: number; again: boolean; invalidated: number; requested: number }
export interface LocalState { draft: string; delivery: Delivery; offset: number; following: boolean; selectedChat: string | null }
const EMPTY_LOCAL: LocalState = Object.freeze({ draft: '', delivery: EMPTY_DELIVERY, offset: 0, following: true, selectedChat: null });
const CACHE_LIMIT = 32;
const SEND_TIMEOUT = 30_000;

/** One in-memory owner for snapshots, cursors, drafts, and delivery state. */
export class WorkflowStore {
  private scope: Scope | null = null;
  private generation = 0;
  private entries = new Map<string, Entry>();
  private locals = new Map<string, LocalState>();
  private listeners = new Set<() => void>();
  private unbind: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private connected = false;
  private active: boolean;
  private stopped = false;
  private sends = new Map<string, Promise<void>>();
  constructor(private lifecycle: ClientLifecycle, private api: WorkflowApi = workflowApi, private socket: WorkflowSocket = wsClient) {
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
        if (workbench.workspaceId === next.workspace) this.invalidate(['sessions', 'threads', 'workbench', 'children']);
      });
      on<{ id: string }>('workbench:deleted', ({ id }) => this.deleted(id));
      on<{ chat: WorkbenchChat }>('workbench:chat', ({ chat }) => {
        if (this.hasWorkbench(chat.workbenchId)) this.invalidate(['workbench', 'sessions', 'threads', 'transcript']);
      });
      on<{ chatId: string; events: WorkbenchEvent[] }>('workbench:event', ({ chatId, events }) => {
        const entry = this.entry('transcript', chatId, false);
        if (!entry || entry.state.status === 'deleted' || entry.state.status === 'unauthorized') return;
        const data = mergeEvents(chatId, entry.state.data as Transcript | undefined ?? emptyTranscript(), events);
        entry.state = { ...entry.state, data, stale: entry.state.stale || data.gap };
        this.emit();
        if (data.gap) { entry.invalidated++; if (entry.pending) entry.again = true; this.scheduleRecovery(); }
      });
      on('pull_request:updated', () => this.invalidate(['attention', 'pr', 'timeline']));
      // The shared client owns reconnect and restores workspace subscriptions.
      this.socket.subscribe(next.workspace);
      void this.socket.connect().catch(() => this.markStale());
    }
    this.emit();
  }
  private hasWorkbench(id: string) { return Boolean(this.entry('workbench', id, false)?.state.data); }
  private entry(entity: Entity, id = '', create = true): Entry | undefined {
    if (!this.scope) return undefined;
    const key = cacheKey(this.scope, entity, id);
    let entry = this.entries.get(key);
    if (!entry && create) {
      this.prune();
      entry = { entity, id, state: EMPTY_RESOURCE, revision: 0, watchers: 0, again: false, invalidated: 1, requested: 0 };
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
    if (force) { entry.invalidated++; entry.state = { ...entry.state, stale: true }; }
    if (entry.state.stale || entry.state.status === 'idle') void this.load(entity, id);
    return () => { entry.watchers = Math.max(0, entry.watchers - 1); };
  }
  private markStale() {
    for (const entry of this.entries.values()) { entry.invalidated++; entry.state = { ...entry.state, stale: true }; }
    this.emit();
  }
  private invalidate(entities: Entity[]) {
    for (const entry of this.entries.values()) {
      if (!entities.includes(entry.entity) || entry.state.status === 'deleted') continue;
      entry.invalidated++;
      entry.state = { ...entry.state, stale: true };
      if (entry.pending) entry.again = true;
    }
    this.emit(); this.scheduleRecovery();
  }
  private scheduleRecovery() {
    if (this.timer || !this.scope || !this.canRead()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const entry of this.entries.values()) {
        if (entry.watchers && entry.invalidated > entry.requested && entry.state.stale && entry.state.status !== 'deleted' && entry.state.status !== 'unauthorized') void this.load(entry.entity, entry.id);
      }
    }, 250);
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
        entry.state = { status: 'ready', data, stale: Boolean(gap) || !this.canRead() || entry.invalidated > entry.requested, refreshing: false, updatedAt: Date.now() };
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
      case 'attention': return (await this.api.pullRequests.list({ workspaceId: scope.workspace, state: 'open', relationship: 'all' }))
        .filter((row) => row.workspaceId === scope.workspace);
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
    }
  }
  private async reconcile(chatId: string, scope: Scope, prior?: Transcript): Promise<Transcript> {
    let state = prior ?? emptyTranscript();
    if (!prior?.events.length) {
      const page = await this.api.workbenches.events(chatId, { before: 'latest', limit: PAGE_SIZE });
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
  async older(chatId: string) {
    const entry = this.entry('transcript', chatId, false);
    const prior = entry?.state.data as Transcript | undefined;
    if (!entry || !prior?.hasOlder || !prior.oldest || entry.pending || !this.canRead()) return;
    const generation = this.generation; const revision = ++entry.revision;
    const valid = () => generation === this.generation && revision === entry.revision;
    entry.state = { ...entry.state, refreshing: true }; this.emit();
    entry.pending = (async () => {
      try {
        const page = await this.api.workbenches.events(chatId, { before: prior.oldest!, limit: PAGE_SIZE });
        if (!valid()) return;
        if (page.oldestSeq === undefined) throw new Error('Older history is not supported.');
        entry.state = { ...entry.state, status: 'ready', data: mergeEvents(chatId, entry.state.data as Transcript, page.events, 'older', page), refreshing: false };
      } catch {
        if (valid()) entry.state = { ...entry.state, status: 'error', stale: true, refreshing: false };
      } finally { if (valid()) { entry.pending = undefined; this.emit(); } }
    })();
    return entry.pending;
  }
  private localKey(id: string) { return this.scope ? cacheKey(this.scope, 'transcript', id) : null; }
  local(id: string): LocalState { const key = this.localKey(id); return key ? this.locals.get(key) ?? EMPTY_LOCAL : EMPTY_LOCAL; }
  updateLocal(id: string, patch: Partial<LocalState>) {
    const key = this.localKey(id); if (!key) return;
    this.locals.set(key, { ...this.local(id), ...patch }); this.emit();
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
    this.invalidate(['sessions', 'threads', 'children']); this.emit();
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
  send(workbenchId: string, chatId: string, manualRetry = false): Promise<void> {
    const pending = this.sends.get(chatId); if (pending) return pending;
    const item = this.read<Workbench>('workbench', workbenchId);
    const chat = item.data?.chats?.find((value) => value.id === chatId);
    const local = this.local(chatId);
    if (!this.canSend() || item.stale || !canCompose(item.data, chat) || !local.draft.trim() ||
      !canStartSend(local.delivery, manualRetry)) return Promise.resolve();
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
      this.invalidate(['workbench', 'transcript', 'sessions', 'threads']);
    }).catch((error: unknown) => {
      if (!valid()) return;
      this.updateLocal(chatId, { delivery: deliveryReducer(this.local(chatId).delivery, { type: explicitSendFailure(error) ? 'failed' : 'unknown' }) });
      if (!explicitSendFailure(error)) void this.checkDelivery(workbenchId, chatId);
    }).finally(() => { clearTimeout(timeout); if (generation === this.generation) this.sends.delete(chatId); });
    this.sends.set(chatId, promise);
    return promise;
  }
  dispose() {
    this.setScope(null); this.stopped = true; this.unbind.forEach((unbind) => unbind()); this.listeners.clear(); clearTimeout(this.timer);
  }
}
