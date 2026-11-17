import type { Workbench, WorkbenchTranscriptMatch } from '@talyn/shared';
import { Gesture } from 'react-native-gesture-handler';

import { activeTarget, badgeText, configureDrawerSwipe, DRAWER_SWIPE_VERTICAL_SLOP, drawerEntries, drawerWidth, matchesQuery, needsYou,
  needsYouCount, normalizeQuery, toggled, withTranscriptMatches, type DrawerEntry, type DrawerInput } from '../features/nav/model';
import { chat, session, thread } from './workflowFixtures';

const none = new Set<string>();
const input = (patch: Partial<DrawerInput>): DrawerInput =>
  ({ sessions: [], threads: [], query: '', collapsedGroups: none, collapsedThreads: none, ...patch });
const keys = (entries: DrawerEntry[]) => entries.map((entry) => entry.key);

const alpha = session({ id: 'alpha', title: 'Alpha fix', repoFullName: 'org/alpha', branch: 'tom/alpha', createdAt: '2026-11-08T09:00:00Z' });
const beta = session({ id: 'beta', title: 'Beta work', repoFullName: 'org/beta', branch: 'tom/beta-branch', createdAt: '2026-11-08T10:00:00Z' });
const child = session({ id: 'child', title: 'Child task', repoFullName: 'org/alpha', threadId: 'thread-one', createdAt: '2026-11-08T11:00:00Z' });
const waiting = session({ id: 'waiting', title: 'Waiting', repoFullName: 'org/beta', chats: [chat({ status: 'awaiting_input' })], createdAt: '2026-11-08T12:00:00Z' });

describe('needs you', () => {
  it.each<[string, Partial<Workbench>, boolean]>([
    ['an answer', { chats: [chat({ status: 'awaiting_input' })] }, true],
    ['a failed chat', { chats: [chat({ status: 'error' })] }, true],
    ['a failed start', { status: 'error' }, true],
    ['a running chat', { chats: [chat({ status: 'running' })] }, false],
    ['an idle session', {}, false],
    ['an archived session that waits', { chats: [chat({ status: 'awaiting_input' })], archivedAt: '2026-11-09T00:00:00Z' }, false],
  ])('with %s is %s', (_name, patch, expected) => {
    expect(needsYou(session(patch))).toBe(expected);
  });

  it('counts sessions and threads, and nothing unknown', () => {
    expect(needsYouCount(undefined, undefined)).toBe(0);
    expect(needsYouCount([waiting, alpha], [thread()])).toBe(1);
  });
});

describe('search', () => {
  it.each([
    ['  Alpha ', 'alpha'], ['', ''], ['BETA', 'beta'],
  ])('normalizes %j to %j', (raw, expected) => { expect(normalizeQuery(raw)).toBe(expected); });

  it.each([
    ['', true], ['alpha fix', true], ['org/alpha', true], ['tom/alpha', true], ['beta', false], ['session-one', true],
  ])('matches %j: %s', (query, expected) => { expect(matchesQuery(alpha, query)).toBe(expected); });
});

describe('drawer entries', () => {
  it('shows a spinner before anything loads', () => {
    expect(drawerEntries(input({ sessions: undefined, threads: undefined }))).toEqual([{ type: 'loading', key: 'loading' }]);
  });

  it('says there are no sessions yet and keeps the Threads heading', () => {
    expect(keys(drawerEntries(input({})))).toEqual(['heading:threads', 'heading:sessions', 'starters:sessions']);
  });

  it('orders Needs you, Threads with sessions, then repositories newest first', () => {
    const entries = drawerEntries(input({ sessions: [alpha, beta, child, waiting], threads: [thread()] }));
    expect(keys(entries)).toEqual([
      'heading:needs', 'needs:waiting',
      'heading:threads', 'thread:thread-one', 'child:thread-one:child',
      'heading:sessions',
      'group:org/beta', 'session:waiting', 'session:beta',
      'group:org/alpha', 'session:child', 'session:alpha',
    ]);
    expect(entries.find((entry) => entry.type === 'thread')).toMatchObject({ childCount: 1, running: 0, expanded: true });
  });

  it('counts running sessions on a thread', () => {
    const busy = session({ ...child, chats: [chat({ status: 'running' })] });
    const queued = session({ id: 'queued', threadId: 'thread-one', chats: [chat({ queuedMessages: [{ id: 'q' }] as never })] });
    const entry = drawerEntries(input({ sessions: [busy, queued], threads: [thread()] })).find((item) => item.type === 'thread');
    expect(entry).toMatchObject({ running: 2, childCount: 2 });
  });

  it('collapses a group and a thread, and marks a group that hides work that needs the person', () => {
    const entries = drawerEntries(input({ sessions: [alpha, beta, child, waiting], threads: [thread()],
      collapsedGroups: new Set(['org/beta']), collapsedThreads: new Set(['thread-one']) }));
    expect(keys(entries)).not.toContain('child:thread-one:child');
    expect(keys(entries)).not.toContain('session:beta');
    expect(entries.find((entry) => entry.key === 'group:org/beta')).toMatchObject({ expanded: false, hidden: 2, attention: true });
    expect(entries.find((entry) => entry.key === 'group:org/alpha')).toMatchObject({ expanded: true, hidden: 0, attention: false });
  });

  it('labels sessions with no repository', () => {
    const loose = session({ id: 'loose', repoFullName: '' });
    expect(keys(drawerEntries(input({ sessions: [loose] })))).toContain('group:No repository');
  });

  it('leaves archived work out', () => {
    const archived = session({ id: 'old', archivedAt: '2026-11-09T00:00:00Z' });
    expect(keys(drawerEntries(input({ sessions: [archived] })))).not.toContain('session:old');
  });

  it.each<[string, string[]]>([
    ['alpha', ['heading:threads', 'thread:thread-one', 'child:thread-one:child', 'heading:sessions', 'group:org/alpha', 'session:child', 'session:alpha']],
    ['beta-branch', ['heading:sessions', 'group:org/beta', 'session:beta']],
    ['child', ['heading:threads', 'thread:thread-one', 'child:thread-one:child', 'heading:sessions', 'group:org/alpha', 'session:child']],
    ['planning', ['heading:threads', 'thread:thread-one', 'child:thread-one:child']],
    ['waiting', ['heading:needs', 'needs:waiting', 'heading:sessions', 'group:org/beta', 'session:waiting']],
    ['no such thing', ['notice:search']],
  ])('searches for %j and opens collapsed groups and threads', (query, expected) => {
    const entries = drawerEntries(input({ sessions: [alpha, beta, child, waiting], threads: [thread()], query,
      collapsedGroups: new Set(['org/alpha', 'org/beta']), collapsedThreads: new Set(['thread-one']) }));
    expect(keys(entries)).toEqual(expected);
  });
});

describe('transcript matches', () => {
  const found = (item: Workbench): WorkbenchTranscriptMatch => ({ workbench: item, chatId: 'chat-one', seq: 1, role: 'user', snippet: `in ${item.id}` });
  const old = session({ id: 'old', title: 'Old', archivedAt: '2026-11-09T00:00:00Z' });
  const named = drawerEntries(input({ sessions: [alpha, beta], query: 'alpha' }));
  const unmatched = drawerEntries(input({ sessions: [alpha, beta], query: 'zzz' }));

  it.each<[string, DrawerEntry[], WorkbenchTranscriptMatch[], boolean, string[]]>([
    ['adds matches below the name matches', named, [found(old)], false,
      ['heading:sessions', 'group:org/alpha', 'session:alpha', 'heading:transcripts', 'transcript:old']],
    ['leaves out a session the name search shows', named, [found(alpha), found(old)], false,
      ['heading:sessions', 'group:org/alpha', 'session:alpha', 'heading:transcripts', 'transcript:old']],
    ['lists a session once', unmatched, [found(old), found(old)], false, ['heading:transcripts', 'transcript:old']],
    ['adds nothing when every match is shown', named, [found(alpha)], false, ['heading:sessions', 'group:org/alpha', 'session:alpha']],
    ['keeps the no-match notice with no matches', unmatched, [], false, ['notice:search']],
    ['says it searches when nothing else matches', unmatched, [], true, ['notice:transcripts']],
    ['stays quiet while it searches below name matches', named, [], true, ['heading:sessions', 'group:org/alpha', 'session:alpha']],
    ['shows matches in place of the no-match notice', unmatched, [found(beta)], false, ['heading:transcripts', 'transcript:beta']],
  ])('%s', (_name, entries, matches, loading, expected) => {
    expect(keys(withTranscriptMatches(entries, matches, loading))).toEqual(expected);
  });

  it('names the group and carries the match', () => {
    const entries = withTranscriptMatches(unmatched, [found(old)], false);
    expect(entries[0]).toEqual({ type: 'heading', key: 'heading:transcripts', section: 'transcripts', title: 'In transcripts' });
    expect(entries[1]).toEqual({ type: 'transcript', key: 'transcript:old', match: found(old) });
  });
});

describe('active target', () => {
  it.each<[string, string | string[] | undefined, string | null]>([
    ['/', undefined, 'home'],
    ['/home', undefined, 'home'],
    ['/home/', undefined, 'home'],
    ['/pulls', undefined, 'pulls:mine'],
    ['/pulls', 'reviews', 'pulls:reviews'],
    ['/pulls', ['queue'], 'pulls:queue'],
    ['/pulls', 'unknown', 'pulls:mine'],
    ['/settings', undefined, 'settings'],
    ['/spaces/space-one', undefined, 'spaces'],
    ['/integrations', undefined, 'integrations'],
    ['/integrations/schedule', undefined, 'integrations'],
    ['/usage', undefined, 'usage'],
    ['/agents', undefined, 'agents'],
    ['/insights', undefined, 'insights'],
    ['/history', undefined, 'history'],
    ['/sessions/session-one', undefined, null],
    ['/workspaces', undefined, null],
  ])('maps %s (tab %j) to %s', (path, tab, expected) => {
    expect(activeTarget(path, tab)).toBe(expected);
  });
});

describe('small helpers', () => {
  it.each<[number | null | undefined, string | null]>([
    [null, null], [undefined, null], [0, null], [-1, null], [Number.NaN, null], [1, '1'], [99, '99'], [100, '99+'], [2.7, '2'],
  ])('badge for %s is %s', (count, expected) => { expect(badgeText(count)).toBe(expected); });

  it.each([[320, 272], [400, 340], [430, 360], [1024, 360]])('drawer width on a %ipt screen is %ipt', (screen, expected) => {
    expect(drawerWidth(screen)).toBe(expected);
  });

  it('lets an edge swipe drift vertically before it cancels', () => {
    const pan = Gesture.Pan().activeOffsetX([-5, 5]).failOffsetY([-5, 5]);
    const config = configureDrawerSwipe(pan).config;
    expect(config).toMatchObject({ failOffsetYStart: -DRAWER_SWIPE_VERTICAL_SLOP, failOffsetYEnd: DRAWER_SWIPE_VERTICAL_SLOP,
      activeOffsetXStart: -5, activeOffsetXEnd: 5 });
    expect(DRAWER_SWIPE_VERTICAL_SLOP).toBeGreaterThan(5);
  });

  it('toggles a key without changing the old set', () => {
    const before = new Set(['a']);
    expect([...toggled(before, 'b')]).toEqual(['a', 'b']);
    expect([...toggled(before, 'a')]).toEqual([]);
    expect([...before]).toEqual(['a']);
  });
});
