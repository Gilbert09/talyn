import type { PRRow } from '@talyn/client/native';
import type { Workbench } from '@talyn/shared';

import { EVENT_LIMIT, PAGE_CEILING, PAGE_SIZE, RELEASE_KEEP, type Transcript } from '../workflow/model';
import { EVENT_REFETCH_INTERVAL, FULL_LOOKUP, RECOVERY_DEBOUNCE } from '../workflow/store';
import { chat, deferred, event, fixture, pr, scope, session } from './workflowFixtures';

const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
let active: ReturnType<typeof fixture>;
beforeEach(() => { jest.useFakeTimers(); active = fixture(); });
afterEach(() => { active.store.dispose(); jest.useRealTimers(); });

describe('authoritative reads and boundaries', () => {
  it('loads the selected workspace through the native client and coalesces concurrent reads', async () => {
    const { store, api, socket } = active;
    await Promise.all([store.load('sessions'), store.load('sessions')]);
    expect(api.workbenches.list).toHaveBeenCalledTimes(1);
    expect(api.workbenches.list).toHaveBeenCalledWith('one', { kinds: ['session'] });
    expect(store.read('sessions')).toMatchObject({ status: 'ready', stale: false, data: [session()] });
    expect(socket.connect).toHaveBeenCalledTimes(1); expect(socket.setCapabilities).toHaveBeenCalledWith(['threads']);
    expect(socket.subscribe).toHaveBeenCalledWith('one');
  });
  it.each(['environment', 'user', 'workspace'] as const)('clears snapshots and drafts when %s changes', async (field) => {
    const { store } = active; await store.load('sessions'); store.updateLocal('chat-one', { draft: 'Private draft' });
    store.setScope({ ...scope, [field]: 'other' });
    expect(store.read('sessions').data).toBeUndefined(); expect(store.local('chat-one').draft).toBe('');
  });
  it('rejects a late snapshot after logout', async () => {
    const { store, api } = active; const pending = deferred<ReturnType<typeof session>[]>();
    api.workbenches.list.mockReturnValueOnce(pending.promise);
    const request = store.load('sessions'); store.setScope(null); pending.resolve([session()]); await request;
    expect(store.read('sessions').data).toBeUndefined();
  });
  it.each([401, 403, 404, 410])('removes inaccessible content for HTTP %s', async (status) => {
    const { store, api } = active; await store.load('workbench', 'session-one'); store.updateLocal('chat-one', { draft: 'Private draft' });
    api.workbenches.get.mockRejectedValueOnce({ status }); await store.load('workbench', 'session-one');
    expect(store.read('workbench', 'session-one').data).toBeUndefined(); expect(store.local('chat-one').draft).toBe('');
    expect(store.read('workbench', 'session-one').status).toBe(status < 404 ? 'unauthorized' : 'deleted');
  });
  it.each(['workbench', 'pr'] as const)('validates deep-linked %s against the selected workspace', async (entity) => {
    const { store, api } = active;
    api.workbenches.get.mockResolvedValueOnce(session({ workspaceId: 'other' }));
    api.pullRequests.get.mockResolvedValueOnce({ row: pr({ workspaceId: 'other' }), fresh: null });
    await store.load(entity, 'foreign'); expect(store.read(entity, 'foreign')).toMatchObject({ status: 'unauthorized', data: undefined });
  });
  it('does not follow a cross-workspace child or queue request', async () => {
    const { store, api } = active;
    api.workbenches.get.mockResolvedValueOnce(session({ workspaceId: 'other' })); await store.load('children', 'foreign');
    expect(api.workbenches.threadSessions).not.toHaveBeenCalled();
    api.pullRequests.get.mockResolvedValueOnce({ row: pr({ workspaceId: 'other' }), fresh: null }); await store.load('timeline', 'foreign');
    expect(api.pullRequests.mergeQueueTimeline).not.toHaveBeenCalled();
  });
  it('preserves drafts and read position across navigation and suspension in the same scope', () => {
    const { store, network } = active; store.updateLocal('chat-one', { draft: 'Unsent', offset: 1840, following: false });
    network({ activity: 'suspended' }); network({ activity: 'active' });
    store.setScope({ ...scope }); expect(store.local('chat-one')).toMatchObject({ draft: 'Unsent', offset: 1840, following: false });
  });
  it('makes no requests while offline and never retries failed snapshots in a loop', async () => {
    const { store, api, network } = active; network({ reachability: 'offline' }); await store.load('sessions');
    expect(api.workbenches.list).not.toHaveBeenCalled(); expect(store.read('sessions').status).toBe('offline');
    network({ reachability: 'online' }); api.workbenches.list.mockRejectedValueOnce({ status: 503 });
    const stop = store.watch('sessions'); await settle(); jest.advanceTimersByTime(300000); await settle();
    expect(api.workbenches.list).toHaveBeenCalledTimes(1); stop();
  });
});

describe('socket invalidation, resume, and transcript reconciliation', () => {
  it('coalesces a burst of echoes into one background refetch', async () => {
    const { store, api, emit } = active; const stop = store.watch('attention'); await settle();
    for (let index = 0; index < 100; index++) emit('pull_request:updated', { id: `new-${index}`, state: 'open' });
    jest.advanceTimersByTime(RECOVERY_DEBOUNCE); await settle();
    expect(api.pullRequests.list).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(EVENT_REFETCH_INTERVAL); await settle();
    expect(api.pullRequests.list).toHaveBeenCalledTimes(2); expect(store.read('attention').stale).toBe(false);
    jest.advanceTimersByTime(EVENT_REFETCH_INTERVAL * 5); await settle();
    expect(api.pullRequests.list).toHaveBeenCalledTimes(2); stop();
  });
  it('marks snapshots stale until the recovery REST request succeeds', async () => {
    const { store, api, emit } = active; store.watch('sessions'); await settle();
    const pending = deferred<ReturnType<typeof session>[]>(); api.workbenches.list.mockReturnValueOnce(pending.promise);
    emit('connection:status', { connected: false }); emit('connection:status', { connected: true });
    jest.advanceTimersByTime(250); await settle(); expect(store.read('sessions').stale).toBe(true);
    pending.resolve([session()]); await settle(); expect(store.read('sessions').stale).toBe(false);
  });
  it('runs one recovery on foreground resume without another reconnect loop', async () => {
    const { store, api, socket, network, emit } = active; store.watch('sessions'); await settle();
    network({ activity: 'suspended' }); network({ reachability: 'offline' }); network({ activity: 'active' });
    expect(store.read('sessions').stale).toBe(true); network({ reachability: 'online' });
    emit('connection:status', { connected: true }); emit('connection:status', { connected: true });
    jest.advanceTimersByTime(250); await settle();
    expect(api.workbenches.list).toHaveBeenCalledTimes(2); expect(socket.connect).toHaveBeenCalledTimes(1);
  });
  it('reconciles missing sequence ranges with forward REST history', async () => {
    const { store, api, emit } = active; store.watch('transcript', 'chat-one'); await settle();
    emit('workbench:event', { chatId: 'chat-one', events: [event(3), event(3)] });
    expect(store.read<Transcript>('transcript', 'chat-one').data?.gap).toBe(true);
    api.workbenches.events.mockResolvedValueOnce({ events: [event(2), event(3)], cursor: 3, oldestSeq: 2, hasOlder: false });
    jest.advanceTimersByTime(250); await settle();
    expect(api.workbenches.events).toHaveBeenLastCalledWith('chat-one', { after: 1, limit: 200 });
    const state = store.read<Transcript>('transcript', 'chat-one');
    expect(state.data?.events.map((item) => item.seq)).toEqual([1, 2, 3]); expect(state.stale).toBe(false);
  });
  it('keeps events that arrive while a snapshot is in flight', async () => {
    const { store, api, emit } = active; await store.load('transcript', 'chat-one');
    const pending = deferred<Awaited<ReturnType<typeof api.workbenches.events>>>(); api.workbenches.events.mockReturnValueOnce(pending.promise);
    const load = store.load('transcript', 'chat-one'); emit('workbench:event', { chatId: 'chat-one', events: [event(3)] });
    pending.resolve({ events: [event(2)], cursor: 2, oldestSeq: 2, hasOlder: false }); await load;
    expect(store.read<Transcript>('transcript', 'chat-one').data?.events.map((item) => item.seq)).toEqual([1, 2, 3]);
  });
  it('retains live events received during the first history request', async () => {
    const { store, api, emit } = active;
    const pending = deferred<Awaited<ReturnType<typeof api.workbenches.events>>>();
    api.workbenches.events.mockReturnValueOnce(pending.promise);
    const load = store.load('transcript', 'chat-one');
    emit('workbench:event', { chatId: 'chat-one', events: [event(2)] });
    pending.resolve({ events: [event(1)], cursor: 1, oldestSeq: 1, hasOlder: false }); await load;
    expect(store.read<Transcript>('transcript', 'chat-one').data?.events.map((item) => item.seq)).toEqual([1, 2]);
  });
  it('uses supported backward paging for older history', async () => {
    const { store, api } = active;
    api.workbenches.events.mockResolvedValueOnce({ events: [event(10)], cursor: 10, oldestSeq: 10, hasOlder: true });
    await store.load('transcript', 'chat-one');
    api.workbenches.events.mockResolvedValueOnce({ events: [event(9)], cursor: 9, oldestSeq: 9, hasOlder: false });
    await store.older('chat-one'); expect(api.workbenches.events).toHaveBeenLastCalledWith('chat-one', { before: 10, limit: 200, ceiling: 400 });
    expect(store.read<Transcript>('transcript', 'chat-one').data?.events.map((item) => item.seq)).toEqual([9, 10]);
  });
  it('caps recovery batches and retained events for large histories', async () => {
    const { store, api } = active;
    api.workbenches.events.mockImplementation(async (_id, options) => {
      const after = (options as { after?: number })?.after ?? 0;
      return { events: Array.from({ length: 200 }, (_, index) => event(after + index + 1)), cursor: after + 200 } as Awaited<ReturnType<typeof api.workbenches.events>>;
    });
    await store.load('transcript', 'chat-one');
    expect(api.workbenches.events.mock.calls.length).toBeLessThanOrEqual(5);
    expect(store.read<Transcript>('transcript', 'chat-one').data?.events.length).toBeLessThanOrEqual(EVENT_LIMIT);
    expect(store.read('transcript', 'chat-one').stale).toBe(true);
  });
  it('does not resurrect a deleted workbench or retain its drafts', async () => {
    const { store, api, emit } = active; await store.load('workbench', 'session-one'); store.updateLocal('chat-one', { draft: 'Unsent' });
    const pending = deferred<ReturnType<typeof session>>(); api.workbenches.get.mockReturnValueOnce(pending.promise);
    const load = store.load('workbench', 'session-one'); emit('workbench:deleted', { id: 'session-one' }); pending.resolve(session()); await load;
    expect(store.read('workbench', 'session-one')).toMatchObject({ status: 'deleted', data: undefined }); expect(store.local('chat-one').draft).toBe('');
  });
  it('does not restore a deleted transcript from a late socket frame', async () => {
    const { store, emit } = active;
    await store.load('workbench', 'session-one'); await store.load('transcript', 'chat-one');
    emit('workbench:deleted', { id: 'session-one' });
    emit('workbench:event', { chatId: 'chat-one', events: [event(2)] });
    expect(store.read('transcript', 'chat-one')).toMatchObject({ status: 'deleted', data: undefined });
  });
  it('ignores callbacks from an old workspace subscription', async () => {
    const { store, handlers } = active;
    const handler = [...handlers.get('workbench:deleted')!][0]; store.setScope({ ...scope, workspace: 'two' });
    await store.load('workbench', 'session-one'); handler({ id: 'session-one' });
    expect(store.read('workbench', 'session-one').status).toBe('unauthorized');
  });
});

describe('text delivery without automatic resend', () => {
  async function prepare() { await active.store.load('workbench', 'session-one'); active.store.updateLocal('chat-one', { draft: 'Hello' }); }
  it.each([false, true])('shows acknowledged queued=%s and clears only the submitted draft', async (queued) => {
    await prepare(); active.api.workbenches.sendMessage.mockResolvedValueOnce({ queued });
    await active.store.send('session-one', 'chat-one');
    expect(active.api.workbenches.sendMessage).toHaveBeenCalledWith('chat-one', { text: 'Hello' });
    expect(active.store.local('chat-one')).toMatchObject({ draft: '', delivery: { status: queued ? 'queued' : 'sent' } });
  });
  it('serializes sends and shows Sending before acknowledgement', async () => {
    await prepare(); const pending = deferred<{ queued: boolean }>(); active.api.workbenches.sendMessage.mockReturnValueOnce(pending.promise);
    const first = active.store.send('session-one', 'chat-one'); active.store.send('session-one', 'chat-one');
    expect(active.store.local('chat-one').delivery.status).toBe('sending'); expect(active.api.workbenches.sendMessage).toHaveBeenCalledTimes(1);
    pending.resolve({ queued: false }); await first;
  });
  it('shows explicit failures and retries only after a manual action', async () => {
    await prepare(); active.api.workbenches.sendMessage.mockRejectedValueOnce({ status: 409 });
    await active.store.send('session-one', 'chat-one');
    expect(active.store.local('chat-one')).toMatchObject({ draft: 'Hello', delivery: { status: 'failed' } });
    jest.advanceTimersByTime(300000); await settle(); expect(active.api.workbenches.sendMessage).toHaveBeenCalledTimes(1);
    await active.store.send('session-one', 'chat-one'); expect(active.api.workbenches.sendMessage).toHaveBeenCalledTimes(1);
    await active.store.send('session-one', 'chat-one', true); expect(active.api.workbenches.sendMessage).toHaveBeenCalledTimes(2);
  });
  it('checks history and server queue after a timeout without matching message text', async () => {
    await prepare(); active.api.workbenches.sendMessage.mockReturnValueOnce(new Promise(() => {}));
    const send = active.store.send('session-one', 'chat-one'); jest.advanceTimersByTime(30000); await send; await settle();
    expect(active.store.local('chat-one')).toMatchObject({ draft: 'Hello', delivery: { status: 'unknown', checked: true } });
    expect(active.api.workbenches.get).toHaveBeenCalledTimes(2); expect(active.api.workbenches.events).toHaveBeenCalled();
    await active.store.send('session-one', 'chat-one'); expect(active.api.workbenches.sendMessage).toHaveBeenCalledTimes(1);
    await active.store.send('session-one', 'chat-one', true); expect(active.api.workbenches.sendMessage).toHaveBeenCalledTimes(2);
  });
  it('does not offer resend until both recovery reads succeed', async () => {
    await prepare(); active.api.workbenches.sendMessage.mockRejectedValueOnce(new TypeError('Network failure'));
    active.api.workbenches.events.mockRejectedValueOnce({ status: 503 }); await active.store.send('session-one', 'chat-one'); await settle();
    expect(active.store.local('chat-one').delivery).toMatchObject({ status: 'unknown', checked: false });
    await active.store.send('session-one', 'chat-one', true); expect(active.api.workbenches.sendMessage).toHaveBeenCalledTimes(1);
  });
  it.each(['offline', 'unknown'] as const)('does not queue a message when reachability is %s', async (reachability) => {
    await prepare(); active.network({ reachability }); await active.store.send('session-one', 'chat-one');
    expect(active.api.workbenches.sendMessage).not.toHaveBeenCalled(); expect(active.store.local('chat-one').draft).toBe('Hello');
  });
  it('sends while a background refresh is owed, because the server validates the send', async () => {
    await prepare(); active.emit('connection:status', { connected: false });
    expect(active.store.read('workbench', 'session-one').stale).toBe(true);
    await active.store.send('session-one', 'chat-one'); expect(active.api.workbenches.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('rejects sends with unauthorized parent state', async () => {
    await prepare(); active.api.workbenches.get.mockRejectedValueOnce({ status: 403 }); await active.store.load('workbench', 'session-one');
    await active.store.send('session-one', 'chat-one'); expect(active.api.workbenches.sendMessage).not.toHaveBeenCalled();
  });
  it('does not restore a draft or delivery status after an account change', async () => {
    await prepare(); const pending = deferred<{ queued: boolean }>(); active.api.workbenches.sendMessage.mockReturnValueOnce(pending.promise);
    const send = active.store.send('session-one', 'chat-one'); active.store.setScope({ ...scope, user: 'other' });
    pending.resolve({ queued: true }); await send; expect(active.store.local('chat-one')).toMatchObject({ draft: '', delivery: { status: 'idle' } });
  });
});

describe('targeted invalidation and stale-while-revalidate', () => {
  it('patches the named workbench in place and leaves other workbenches alone', async () => {
    const { store, api, emit } = active;
    const stopA = store.watch('workbench', 'session-one'); const stopB = store.watch('workbench', 'session-two'); await settle();
    const before = store.read('workbench', 'session-two');
    emit('workbench:updated', { workbench: session({ title: 'Renamed', chats: undefined }) });
    jest.advanceTimersByTime(EVENT_REFETCH_INTERVAL * 2); await settle();
    expect(store.read<Workbench>('workbench', 'session-one').data).toMatchObject({ title: 'Renamed', chats: [chat()] });
    expect(store.read('workbench', 'session-two')).toBe(before);
    expect(api.workbenches.get).toHaveBeenCalledTimes(2); stopA(); stopB();
  });
  it.each([
    ['ignores another workspace', session({ workspaceId: 'two', title: 'Foreign' }), ['session-one', 'older'], 'Current work'],
    ['keeps creation order when a row changes', session({ title: 'Renamed', updatedAt: '2026-11-09T00:00:00Z' }), ['session-one', 'older'], 'Renamed'],
    ['inserts a new session in creation order', session({ id: 'newest', createdAt: '2026-11-09T00:00:00Z' }), ['newest', 'session-one', 'older'], 'Current work'],
    ['drops an archived session', session({ archivedAt: '2026-11-09T00:00:00Z' }), ['older'], undefined],
  ] as const)('%s in a list without a refetch', async (_name, update, ids, firstTitle) => {
    const { store, api, emit } = active;
    api.workbenches.list.mockResolvedValueOnce([session(), session({ id: 'older', createdAt: '2026-11-01T00:00:00Z', title: 'Older' })]);
    const stop = store.watch('sessions'); await settle();
    emit('workbench:updated', { workbench: update });
    jest.advanceTimersByTime(EVENT_REFETCH_INTERVAL * 2); await settle();
    const rows = store.read<Workbench[]>('sessions').data!;
    expect(rows.map((row) => row.id)).toEqual(ids);
    expect(rows.find((row) => row.id === 'session-one')?.title).toBe(firstTitle);
    expect(api.workbenches.list).toHaveBeenCalledTimes(1); stop();
  });
  it('moves a chat status into the workbench and its list row without a refetch', async () => {
    const { store, api, emit } = active; const stopList = store.watch('sessions'); const stopItem = store.watch('workbench', 'session-one'); await settle();
    emit('workbench:chat', { chat: chat({ status: 'running' }) });
    expect(store.read<Workbench>('workbench', 'session-one').data?.chats?.[0].status).toBe('running');
    expect(store.read<Workbench[]>('sessions').data?.[0].chats?.[0].status).toBe('running');
    jest.advanceTimersByTime(EVENT_REFETCH_INTERVAL * 2); await settle();
    expect(api.workbenches.get).toHaveBeenCalledTimes(1); expect(api.workbenches.list).toHaveBeenCalledTimes(1);
    expect(api.workbenches.events).not.toHaveBeenCalled(); stopList(); stopItem();
  });
  it('removes a deleted workbench from lists without a refetch', async () => {
    const { store, api, emit } = active; const stop = store.watch('threads'); await settle();
    emit('workbench:deleted', { id: 'thread-one' });
    expect(store.read<Workbench[]>('threads').data).toEqual([]);
    jest.advanceTimersByTime(EVENT_REFETCH_INTERVAL * 2); await settle(); expect(api.workbenches.list).toHaveBeenCalledTimes(1); stop();
  });
  it.each([
    ['patches a held row', { id: 'pr-one', state: 'open', lastSummary: { ciStatus: 'failing_required' } }, ['pr-one'], 1],
    ['drops a row that closed', { id: 'pr-one', state: 'merged' }, [], 1],
    ['ignores a closed PR it does not hold', { id: 'other', state: 'closed' }, ['pr-one'], 1],
    ['refetches for an open PR it does not hold', { id: 'other', state: 'open' }, ['pr-one'], 2],
  ] as const)('%s on a PR echo', async (_name, update, ids, calls) => {
    const { store, api, emit } = active; const stop = store.watch('attention'); await settle();
    emit('pull_request:updated', update);
    expect(store.read<PRRow[]>('attention').data?.map((row) => row.id)).toEqual(ids);
    if (update.id === 'pr-one' && update.state === 'open') expect(store.read<PRRow[]>('attention').data?.[0].summary.ciStatus).toBe('failing_required');
    jest.advanceTimersByTime(EVENT_REFETCH_INTERVAL * 2); await settle();
    expect(api.pullRequests.list).toHaveBeenCalledTimes(calls); stop();
  });
  it('refreshes only the PR detail an echo names', async () => {
    const { store, api, emit } = active;
    const stopOne = store.watch('pr', 'pr-one'); const stopTwo = store.watch('pr', 'pr-two'); await settle();
    expect(api.pullRequests.get).toHaveBeenCalledTimes(2);
    emit('pull_request:updated', { id: 'pr-one', state: 'open', lastSummary: { title: 'Patched' } });
    expect(store.read<{ row: PRRow }>('pr', 'pr-one').data?.row.summary.title).toBe('Patched');
    expect(store.read('pr', 'pr-two').stale).toBe(false);
    jest.advanceTimersByTime(EVENT_REFETCH_INTERVAL * 2); await settle();
    expect(api.pullRequests.get.mock.calls.map((call) => (call as unknown[])[0])).toEqual(['pr-one', 'pr-two', 'pr-one']); stopOne(); stopTwo();
  });
  it('keeps data and order on screen while a background refetch runs', async () => {
    const { store, api, emit } = active; const stop = store.watch('attention'); await settle();
    const pending = deferred<PRRow[]>(); api.pullRequests.list.mockReturnValueOnce(pending.promise);
    const before = store.read<PRRow[]>('attention').data;
    emit('pull_request:updated', { id: 'other', state: 'open' });
    jest.advanceTimersByTime(EVENT_REFETCH_INTERVAL); await settle();
    expect(store.read('attention')).toMatchObject({ status: 'ready', refreshing: true }); expect(store.read('attention').data).toBe(before);
    pending.resolve([pr(), pr({ id: 'other' })]); await settle();
    expect(store.read<PRRow[]>('attention').data?.map((row) => row.id)).toEqual(['pr-one', 'other']); stop();
  });
  it('recovers at once after a reconnect, without the echo throttle', async () => {
    const { store, api, emit } = active; const stop = store.watch('sessions'); await settle();
    emit('connection:status', { connected: true });
    jest.advanceTimersByTime(RECOVERY_DEBOUNCE); await settle();
    expect(api.workbenches.list).toHaveBeenCalledTimes(2); stop();
  });
});

describe('transcript paging on a phone', () => {
  type Page = Awaited<ReturnType<typeof active.api.workbenches.events>>;
  const page = (from: number, to: number, hasOlder = from > 1): Page =>
    ({ events: Array.from({ length: to - from + 1 }, (_, index) => event(from + index)), cursor: to, oldestSeq: from, hasOlder });
  const held = () => active.store.read<Transcript>('transcript', 'chat-one').data!;
  it('asks for a bounded newest page', async () => {
    const { store, api } = active;
    await store.load('transcript', 'chat-one');
    expect(api.workbenches.events).toHaveBeenCalledWith('chat-one', { before: 'latest', limit: PAGE_SIZE, ceiling: PAGE_CEILING });
  });
  it('fetches the newest page when only socket events are held', async () => {
    const { store, api, emit } = active;
    api.workbenches.events.mockRejectedValueOnce({ status: 503 }); await store.load('transcript', 'chat-one');
    emit('workbench:event', { chatId: 'chat-one', events: [event(57)] });
    expect(held()).toMatchObject({ anchored: false });
    api.workbenches.events.mockResolvedValueOnce(page(1, 57, false));
    await store.load('transcript', 'chat-one');
    expect(api.workbenches.events).toHaveBeenLastCalledWith('chat-one', { before: 'latest', limit: PAGE_SIZE, ceiling: PAGE_CEILING });
    expect(held().events).toHaveLength(57); expect(held().anchored).toBe(true);
  });
  it('pages older history back to the start and keeps the newest events', async () => {
    const { store, api } = active;
    api.workbenches.events.mockResolvedValueOnce(page(601, 800)); await store.load('transcript', 'chat-one');
    for (const [from, to] of [[401, 600], [201, 400], [1, 200]]) {
      api.workbenches.events.mockResolvedValueOnce(page(from, to)); await store.older('chat-one');
    }
    expect(held().events).toHaveLength(800); expect(held().events.at(-1)?.seq).toBe(800); expect(held().hasOlder).toBe(false);
    api.workbenches.events.mockClear(); await store.older('chat-one');
    expect(api.workbenches.events).not.toHaveBeenCalled();
  });
  it('keeps the window and offers a retry when an older page fails', async () => {
    const { store, api } = active;
    api.workbenches.events.mockResolvedValueOnce(page(201, 400)); await store.load('transcript', 'chat-one');
    api.workbenches.events.mockRejectedValueOnce(new Error('offline')); await store.older('chat-one');
    expect(store.read('transcript', 'chat-one').status).toBe('ready');
    expect(held()).toMatchObject({ olderFailed: true, hasOlder: true }); expect(held().events).toHaveLength(200);
    api.workbenches.events.mockClear(); await store.older('chat-one');
    expect(api.workbenches.events).not.toHaveBeenCalled();
    api.workbenches.events.mockResolvedValueOnce(page(1, 200)); await store.retryOlder('chat-one');
    expect(held()).toMatchObject({ olderFailed: false, hasOlder: false }); expect(held().events).toHaveLength(400);
  });
  it('fetches nothing when the window is full and marks it limited', async () => {
    const { store, api } = active;
    api.workbenches.events.mockResolvedValueOnce(page(1001, 1000 + EVENT_LIMIT)); await store.load('transcript', 'chat-one');
    api.workbenches.events.mockClear(); await store.older('chat-one');
    expect(api.workbenches.events).not.toHaveBeenCalled(); expect(held().limited).toBe(true);
    store.release('chat-one');
    expect(held()).toMatchObject({ limited: false, hasOlder: true }); expect(held().events).toHaveLength(RELEASE_KEEP);
    expect(held().events.at(-1)?.seq).toBe(1000 + EVENT_LIMIT);
  });
  it.each([
    ['following the newest', true, 1],
    ['reading older history', false, 0],
  ])('trims live growth by where the reader is: %s', async (_name, following, dropped) => {
    const { store, api, emit } = active;
    api.workbenches.events.mockResolvedValueOnce(page(1, EVENT_LIMIT, false)); await store.load('transcript', 'chat-one');
    store.updateLocal('chat-one', { following });
    emit('workbench:event', { chatId: 'chat-one', events: [event(EVENT_LIMIT + 1)] });
    expect(held().events[0].seq).toBe(1 + dropped);
  });
  it('reads a whole tool call without putting it in the window', async () => {
    const { store, api } = active;
    await store.load('transcript', 'chat-one');
    const before = held();
    api.workbenches.events.mockResolvedValueOnce({ events: [event(3), event(4, { chatId: 'other' })], cursor: 4 } as Page);
    const events = await store.fullEvents('chat-one', 3);
    expect(api.workbenches.events).toHaveBeenLastCalledWith('chat-one', { after: 2, limit: FULL_LOOKUP });
    expect(events.map((item) => item.seq)).toEqual([3]);
    expect(held()).toBe(before);
  });
});
