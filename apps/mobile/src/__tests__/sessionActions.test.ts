import type { Workbench } from '@talyn/shared';

import { featureOffered } from '../lib/features';
import { keyboardInset } from '../lib/keyboard';
import { boxRefusal, errorMessage } from '../lib/errors';
import { archiveCopy, canRetry, canWake, runningChat, sessionActions, webLink } from '../features/sessions/actions';
import { workspaceGate } from '../navigation/workspaceGate';
import { chat, fixture, session, thread } from './workflowFixtures';

// The hook module reads the runtime. These tests use only the pure parts.
jest.mock('../auth/AuthProvider', () => ({}));

const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

describe('feature flags', () => {
  it.each([
    [null, 'workbenches', false],
    [undefined, 'workbenches', false],
    [{}, 'workbenches', false],
    [{ workbenches: false }, 'workbenches', false],
    [{ workbenches: true }, 'workbenches', true],
    [{ workbenches: true }, 'spaces', false],
    [{ spaces: true }, 'spaces', true],
  ] as const)('offers %j %s: %s', (features, key, expected) => {
    expect(featureOffered(features as never, key)).toBe(expected);
  });
  it('loads features through the store and keeps the last answer through a failed refresh', async () => {
    const active = fixture();
    await active.store.load('features');
    expect(active.store.read('features').data).toEqual({ workbenches: true });
    active.api.features.get.mockRejectedValueOnce({ status: 503 });
    await active.store.load('features');
    expect(active.store.read('features')).toMatchObject({ status: 'error', data: { workbenches: true } });
    active.store.dispose();
  });
  it('fetches features again when the workspace changes', async () => {
    const active = fixture();
    await active.store.load('features');
    active.store.setScope({ environment: 'test-environment', user: 'test-user', workspace: 'two' });
    expect(active.store.read('features').data).toBeUndefined();
    await active.store.load('features');
    expect(active.api.features.get).toHaveBeenCalledTimes(2);
    active.store.dispose();
  });
});

describe('session action availability', () => {
  const running = chat({ id: 'chat-run', status: 'running' });
  it.each<[string, Partial<Workbench>, string[]]>([
    ['an idle session', {}, ['rename', 'share', 'archive']],
    ['a running session', { chats: [chat(), running] }, ['stop', 'rename', 'share', 'archive']],
    ['a failed start', { status: 'error' }, ['retry', 'rename', 'share', 'archive']],
    ['a failed sandbox', { sandboxState: 'error' }, ['retry', 'rename', 'share', 'archive']],
    ['a sleeping sandbox', { sandboxState: 'suspended' }, ['wake', 'rename', 'share', 'archive']],
    ['a local session that failed', { runtime: 'local', status: 'error' }, ['rename', 'share', 'archive']],
    ['an archived session', { archivedAt: '2026-11-09T10:00:00Z', chats: [running] }, ['share', 'restore']],
    ['an archived status', { status: 'archived' }, ['share', 'restore']],
    ['a session with a PR', { pr: { number: 4, url: 'https://github.com/a/b/pull/4', state: 'open', mergeable: 'mergeable', ciStatus: 'success' } },
      ['rename', 'open_pr', 'share', 'archive']],
    ['a session with an unsafe PR link', { pr: { number: 4, url: 'javascript:alert(1)', state: 'open', mergeable: 'mergeable', ciStatus: 'success' } },
      ['rename', 'share', 'archive']],
    ['a session in a thread', { threadId: 'thread-one' }, ['rename', 'parent', 'share', 'archive']],
  ])('offers the right actions for %s', (_name, patch, expected) => {
    expect(sessionActions(session(patch))).toEqual(expected);
  });
  it('hides the parent link on the thread screen and for threads', () => {
    expect(sessionActions(session({ threadId: 'thread-one' }), { onThreadScreen: true })).not.toContain('parent');
    expect(sessionActions(thread())).toEqual(['rename', 'share', 'archive']);
  });
  it.each([
    ['the selected running chat', 'chat-b', 'chat-b'],
    ['the first running chat when the selected one is idle', 'chat-idle', 'chat-a'],
    ['the first running chat without a selection', null, 'chat-a'],
  ])('stops %s', (_name, selected, expected) => {
    const item = session({ chats: [chat({ id: 'chat-idle' }), chat({ id: 'chat-a', status: 'running' }), chat({ id: 'chat-b', status: 'running' })] });
    expect(runningChat(item, selected)?.id).toBe(expected);
  });
  it.each<[Partial<Workbench>, boolean, boolean]>([
    [{}, false, false],
    [{ status: 'error' }, true, false],
    [{ sandboxState: 'suspended' }, false, true],
    [{ sandboxState: 'suspended', status: 'provisioning' }, false, false],
    [{ sandboxState: 'suspended', archivedAt: '2026-11-09T10:00:00Z' }, false, false],
  ])('retry and wake for %j', (patch, retry, wake) => {
    expect(canRetry(session(patch))).toBe(retry);
    expect(canWake(session(patch))).toBe(wake);
  });
  it('builds a web link and archive copy', () => {
    expect(webLink('a b')).toBe('https://app.talyn.dev/s/a%20b');
    expect(archiveCopy(session()).title).toBe('Archive Current work?');
    expect(archiveCopy(thread()).message).toMatch(/thread/);
  });
});

describe('box refusals and errors', () => {
  it.each([
    [{ status: 402, code: 'usage_exhausted', message: 'Raw', details: { notice: { message: 'You used 10 box-hours.' } } }, 'Out of box-hours', 'You used 10 box-hours.'],
    [{ status: 402, code: 'concurrent_box_limit_reached', message: 'Two boxes run.' }, 'All your boxes are busy', 'Two boxes run.'],
    [{ status: 402, code: 'size_requires_pro' }, 'This size needs Pro', 'This box size needs the Pro plan.'],
  ])('reads %j', (error, title, message) => {
    expect(boxRefusal(error)).toMatchObject({ title, message });
  });
  it.each([null, undefined, 'text', { status: 402, code: 'merge_queue_limit_reached' }, new Error('Nope')])('ignores %j', (error) => {
    expect(boxRefusal(error)).toBeNull();
  });
  it.each([[new Error('Server said no'), 'Server said no'], [{ message: '  ' }, 'Fallback'], [null, 'Fallback']])('messages %j', (error, expected) => {
    expect(errorMessage(error, 'Fallback')).toBe(expected);
  });
});

describe('keyboard inset', () => {
  it.each([
    [null, 918, 48, 0],
    [null, 918, 0, 0],
    [557.7, 918, 48, 312],
    [557.7, 918, 0, 360],
    [600, 800, 34, 166],
    [900, 918, 48, 0],
  ])('keyboard top %p on a %i screen with bottom inset %i pads %i', (top, screen, bottom, expected) => {
    expect(keyboardInset(top, screen, bottom)).toBe(expected);
  });
});

describe('workspace gate on cold start', () => {
  it.each([
    [{ status: 'idle', selected: null }, 'wait'],
    [{ status: 'loading', selected: null }, 'wait'],
    [{ status: 'loading', selected: 'one' }, 'ready'],
    [{ status: 'ready', selected: 'one' }, 'ready'],
    [{ status: 'ready', selected: null }, 'choose'],
    [{ status: 'error', selected: null }, 'choose'],
  ] as const)('%j → %s', (snapshot, expected) => expect(workspaceGate(snapshot)).toBe(expected));
});

describe('session store actions', () => {
  let active: ReturnType<typeof fixture>;
  beforeEach(() => { active = fixture(); });
  afterEach(() => active.store.dispose());

  it('renames optimistically and keeps the server row', async () => {
    await active.store.load('sessions'); await active.store.load('workbench', 'session-one');
    const pending = active.store.renameWorkbench('session-one', '  New name  ');
    expect(active.store.read<Workbench>('workbench', 'session-one').data?.title).toBe('New name');
    expect(active.store.read<Workbench[]>('sessions').data?.[0].title).toBe('New name');
    await pending;
    expect(active.api.workbenches.update).toHaveBeenCalledWith('session-one', { title: 'New name' });
  });
  it('restores the old title when a rename fails', async () => {
    await active.store.load('workbench', 'session-one');
    active.api.workbenches.update.mockRejectedValueOnce({ status: 500 });
    await expect(active.store.renameWorkbench('session-one', 'Broken')).rejects.toEqual({ status: 500 });
    expect(active.store.read<Workbench>('workbench', 'session-one').data?.title).toBe('Current work');
  });
  it.each(['', '   ', 'Current work'])('skips a rename to %j', async (title) => {
    await active.store.load('workbench', 'session-one');
    await active.store.renameWorkbench('session-one', title);
    expect(active.api.workbenches.update).not.toHaveBeenCalled();
  });
  it('drops an archived session from its list and brings it back on restore', async () => {
    await active.store.load('sessions');
    await active.store.archiveWorkbench('session-one');
    expect(active.store.read<Workbench[]>('sessions').data).toEqual([]);
    await active.store.restoreWorkbench('session-one');
    expect(active.store.read<Workbench[]>('sessions').data?.map((item) => item.id)).toEqual(['session-one']);
  });
  it('stops a chat and refreshes the session quietly', async () => {
    const stop = active.store.watch('workbench', 'session-one'); await settle();
    await active.store.stopChat('session-one', 'chat-one');
    expect(active.api.workbenches.cancel).toHaveBeenCalledWith('chat-one');
    expect(active.store.read('workbench', 'session-one').stale).toBe(true);
    stop();
  });
  it('ignores a server row from another workspace', async () => {
    await active.store.load('sessions');
    active.store.applyWorkbench(session({ id: 'foreign', workspaceId: 'other' }));
    expect(active.store.read<Workbench[]>('sessions').data?.map((item) => item.id)).toEqual(['session-one']);
  });
});
