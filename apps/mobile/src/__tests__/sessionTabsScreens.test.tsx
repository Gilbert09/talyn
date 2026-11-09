import type { Workbench, WorkbenchBackground } from '@talyn/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Alert } from 'react-native';

import { HistoryScreen } from '../features/history/HistoryScreen';
import { WorkbenchDetailScreen } from '../features/sessions/WorkbenchDetailScreen';
import { fixture, pr, session, thread } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
let mockParams: Record<string, string> = { id: 'session-one' };
let mockNetwork = 'online';
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
const mockTeams = jest.fn();
const mockMoveSession = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  usePathname: () => '/sessions/session-one',
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => mockRouter,
  Stack: { Screen: ({ options }: { options?: { headerRight?: () => React.ReactNode } }) => options?.headerRight?.() ?? null },
}));
jest.mock('@talyn/client/native', () => ({
  ...jest.requireActual('@talyn/client/native'),
  teams: { list: (...args: unknown[]) => mockTeams(...args) },
  spaces: { moveSession: (...args: unknown[]) => mockMoveSession(...args) },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store, lifecycle: mockActive.lifecycle }), useNetwork: () => mockNetwork,
  useWorkspace: () => ({ status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] }),
  useAuth: () => ({ user: { id: 'user-one' } }),
}));

const changes = {
  files: [{ path: 'src/app.ts', status: 'modified', added: 2, removed: 1, binary: false }, { path: 'README.md', status: 'added', added: 4, removed: 0, binary: false }],
  base: 'abc', headSha: 'def',
};
const patch = ['diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,2 +1,3 @@', ' keep', '-gone line', '+added line', '+second'].join('\n');
const job = (patch_: Record<string, unknown> = {}) => ({ id: 'job-one', workbenchId: 'session-one', chatId: 'chat-one', name: 'dev server',
  command: 'npm run dev', cwd: '/work', status: 'running', exitCode: null, detail: null, startedAt: '2026-11-09T10:00:00Z', endedAt: null,
  keepAwakeUntil: null, notifyOnExit: false, lastCheckedAt: null, ...patch_ });
const background = (jobs: unknown[] = []): WorkbenchBackground => ({ workbenchId: 'session-one', jobs: jobs as never, wakeups: [] });

function extend() {
  Object.assign(mockActive.api.workbenches, {
    changes: jest.fn(async (_id: string, _opts?: unknown) => changes),
    diff: jest.fn(async (_id: string, _path?: string, _scope?: string, _opts?: unknown) => ({ patch })),
    background: jest.fn(async (_id: string) => background()),
    backgroundJobLogs: jest.fn(async () => ({ jobId: 'job-one', status: 'running', exitCode: null, lines: ['ready on :3000'], asleep: false })),
    stopBackgroundJob: jest.fn(async () => job({ status: 'stopped' })),
    openPullRequests: jest.fn(async () => [{ number: 7, title: 'Earlier work', headRef: 'tom/earlier', author: 'tom', updatedAt: '2026-11-08T10:00:00Z', draft: false, state: 'open' }]),
    linkPullRequest: jest.fn(async (id: string) => ({ workbench: session({ id, pullRequestId: 'pr-one' }) })),
    unlinkPullRequest: jest.fn(async (id: string) => session({ id, pullRequestId: null })),
    createChat: jest.fn(async () => ({ id: 'chat-new' })),
  });
}
const api = () => mockActive.api.workbenches as unknown as Record<string, jest.Mock>;
const noPr = (patch_: Partial<Workbench> = {}) => session({ pullRequestId: null, pr: null, diffStat: { added: 3, removed: 1, files: 2 }, ...patch_ });

beforeEach(() => {
  mockActive.store.dispose(); mockActive = fixture(); extend(); mockParams = { id: 'session-one' }; mockNetwork = 'online';
  Object.values(mockRouter).forEach((value) => { if (jest.isMockFunction(value)) value.mockClear(); });
  mockTeams.mockReset(); mockMoveSession.mockReset();
});
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

const tab = (name: string | RegExp) => screen.findByRole('tab', { name });

describe('session detail tabs', () => {
  it('shows Chat, Changes and PR for a session with a linked PR', async () => {
    await render(<WorkbenchDetailScreen kind="session" />);
    await tab('Chat');
    expect(screen.getAllByRole('tab').map((item) => item.props.accessibilityLabel)).toEqual(['Chat', 'Changes', 'PR']);
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeSelected();
  });
  it('keeps a thread on its conversation, with no tabs', async () => {
    mockParams = { id: 'thread-one' };
    await render(<WorkbenchDetailScreen kind="thread" />);
    await screen.findByRole('button', { name: 'Thread actions' });
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
  it('adds Jobs with the running count when the session has background jobs', async () => {
    api().background.mockResolvedValue(background([job()]));
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await tab('Jobs · 1')).toBeVisible();
  });
});

describe('changes', () => {
  it('lists the changed files and opens a diff with numbered, read-only lines', async () => {
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await tab('Changes'));
    const row = await screen.findByRole('button', { name: 'Modified: src/app.ts. 2 added, 1 removed.' });
    expect(screen.getByRole('button', { name: 'Added: README.md. 4 added, 0 removed.' })).toBeVisible();
    expect(api().changes).toHaveBeenCalledWith('session-one', {});
    await fireEvent.press(row);
    expect(await screen.findByLabelText('Added line 2: added line')).toBeVisible();
    expect(screen.getByLabelText('Removed line 2: gone line')).toBeVisible();
    expect(screen.queryByText('diff --git a/src/app.ts b/src/app.ts')).toBeNull();
    expect(api().diff).toHaveBeenCalledWith('session-one', 'src/app.ts', 'combined', {});
    await fireEvent.press(screen.getByRole('button', { name: 'All changed files' }));
    expect(await screen.findByRole('button', { name: /README\.md/ })).toBeVisible();
  });
  it('offers a wake when the box sleeps with no stored copy, and wakes only on request', async () => {
    api().changes.mockImplementation(async (_id: string, opts?: { live?: boolean }) => {
      if (opts?.live) return changes;
      throw Object.assign(new Error('asleep'), { status: 409, code: 'snapshot_unavailable' });
    });
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await tab('Changes'));
    expect(await screen.findByText('Sandbox is asleep. Talyn has no stored copy of its changes yet.')).toBeVisible();
    expect(api().changes).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Wake the sandbox' }));
    await waitFor(() => expect(api().changes).toHaveBeenLastCalledWith('session-one', { live: true }));
    expect(await screen.findByRole('button', { name: /src\/app\.ts/ })).toBeVisible();
  });
  it('says the list is a stored copy and refreshes from the sandbox on request', async () => {
    api().changes.mockResolvedValue({ ...changes, snapshotAt: new Date(Date.now() - 5 * 60_000).toISOString(), source: 'stored', storedReason: 'asleep' });
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await tab('Changes'));
    expect(await screen.findByText('Sandbox is asleep. Showing changes from 5 minutes ago.')).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Refresh from the sandbox' }));
    await waitFor(() => expect(api().changes).toHaveBeenLastCalledWith('session-one', { live: true }));
  });
  it('offers a wake for a diff that is not stored', async () => {
    api().diff.mockImplementation(async (_id: string, _path?: string, _scope?: string, opts?: { live?: boolean }) => {
      if (opts?.live) return { patch };
      throw Object.assign(new Error('asleep'), { status: 409, code: 'snapshot_unavailable' });
    });
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await tab('Changes'));
    await fireEvent.press(await screen.findByRole('button', { name: /src\/app\.ts/ }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Wake the sandbox to see it' }));
    expect(await screen.findByLabelText('Added line 3: second')).toBeVisible();
    expect(api().diff).toHaveBeenLastCalledWith('session-one', 'src/app.ts', 'combined', { live: true });
  });
  it('shows a merged PR first and the branch diff only on request', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ pr: { number: 42, state: 'merged', url: 'https://github.com/example/project/pull/42' } as never }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await tab('Changes'));
    expect(await screen.findByText('PR #42 merged. Its changes are in main.')).toBeVisible();
    expect(api().changes).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Show the branch diff anyway' }));
    await waitFor(() => expect(api().changes).toHaveBeenCalled());
  });
  it('explains a local session instead of reading it', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ runtime: 'local' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await tab('Changes'));
    expect(await screen.findByText('This session runs on a computer with the Talyn desktop app. Open it there.')).toBeVisible();
    expect(api().changes).not.toHaveBeenCalled();
  });
});

describe('pull request tab', () => {
  it('summarises the linked PR and links to its screen', async () => {
    mockActive.api.pullRequests.get.mockResolvedValue({ row: pr({ summary: { ...pr().summary, blockingReason: 'merge_conflicts',
      checks: { total: 4, passed: 3, failed: 1, inProgress: 0, skipped: 0 } } }), fresh: null });
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await tab('PR'));
    const card = await screen.findByRole('link', { name: /Pull request 42: Review current work\. Conflicts\./ });
    expect(card).toBeVisible();
    expect(screen.getByText('4 checks: 3 passed, 1 failing')).toBeVisible();
    expect(screen.getByLabelText('Review: Needs approval')).toBeVisible();
  });
  it('creates a PR through the chat, like web, and returns to the chat', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(noPr());
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await tab('PR'));
    await fireEvent.press(await screen.findByRole('button', { name: 'Create pull request' }));
    await waitFor(() => expect(mockActive.api.workbenches.sendMessage).toHaveBeenCalledWith('chat-one',
      { text: 'Create a pull request', intent: 'create_pr', planMode: false }));
    expect(await screen.findByText('Sent to the agent. It opens the pull request when its turn ends.')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeSelected();
  });
  it('shows the plan alert when the box gate refuses Create PR', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockActive.api.workbenches.get.mockResolvedValue(noPr());
    mockActive.api.workbenches.sendMessage.mockRejectedValueOnce({ status: 402, code: 'usage_exhausted', details: { notice: { message: 'No box-hours left.' } } });
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await tab('PR'));
    await fireEvent.press(await screen.findByRole('button', { name: 'Create pull request' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Out of box-hours', 'No box-hours left.', expect.any(Array)));
  });
  it('links an existing PR from the open ones', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(noPr());
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await tab('PR'));
    await fireEvent.press(await screen.findByRole('button', { name: 'Link an existing pull request' }));
    await fireEvent.press(await screen.findByRole('button', { name: '#7 Earlier work' }));
    await waitFor(() => expect(api().linkPullRequest).toHaveBeenCalledWith('session-one', 7));
  });
  it('removes a link that needs a local checkout and says where to do it', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockActive.api.workbenches.get.mockResolvedValue(noPr());
    api().linkPullRequest.mockResolvedValue({ workbench: session(), needsCheckout: { branch: 'x', remoteRef: 'refs/heads/x' } });
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await tab('PR'));
    await fireEvent.press(await screen.findByRole('button', { name: 'Link an existing pull request' }));
    await fireEvent.press(await screen.findByRole('button', { name: '#7 Earlier work' }));
    await waitFor(() => expect(api().unlinkPullRequest).toHaveBeenCalledWith('session-one'));
    expect(alert).toHaveBeenCalledWith('Could not link the pull request', expect.stringContaining('desktop app'));
  });
});

describe('jobs tab', () => {
  it('stops a running job after a confirmation and shows its output', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    api().background.mockResolvedValue(background([job()]));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await tab('Jobs · 1'));
    await fireEvent.press(await screen.findByRole('button', { name: 'dev server. Running. npm run dev' }));
    expect(await screen.findByText('ready on :3000')).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Stop' }));
    expect(alert.mock.calls[0][0]).toBe('Stop dev server?');
    expect(api().stopBackgroundJob).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0][2] as Array<{ text: string; onPress?(): void }>;
    await act(async () => buttons.find((button) => button.text === 'Stop')?.onPress?.());
    expect(api().stopBackgroundJob).toHaveBeenCalledWith('session-one', 'job-one');
  });
  it('updates from a background socket event', async () => {
    api().background.mockResolvedValue(background([job()]));
    const { wsClient } = jest.requireActual('@talyn/client/native') as { wsClient: { on: jest.Mock } };
    const handlers: Array<(payload: unknown) => void> = [];
    jest.spyOn(wsClient, 'on').mockImplementation(((name: string, handler: (payload: unknown) => void) => {
      if (name === 'workbench:background') handlers.push(handler);
      return () => {};
    }) as never);
    await render(<WorkbenchDetailScreen kind="session" />);
    await tab('Jobs · 1');
    await act(async () => handlers.forEach((handler) => handler(background([job({ status: 'exited', exitCode: 0 })]))));
    expect(await tab('Jobs')).toBeVisible();
  });
});

describe('session menu additions', () => {
  it.each([
    ['Copy branch name', 'tom/example', 'Branch name copied.'],
    ['Copy session ID', 'session-one', 'Session ID copied.'],
    ['Copy link', expect.stringMatching(/\/s\/session-one$/), 'Link copied.'],
  ])('%s copies and confirms', async (label, text, done) => {
    const copy = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Session actions' }));
    await fireEvent.press(screen.getByRole('button', { name: label }));
    expect(copy).toHaveBeenCalledWith(text);
    expect(await screen.findByText(done)).toBeVisible();
  });
  it('keeps Archive last and hides Move to space without the flag', async () => {
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Session actions' }));
    expect(screen.queryByRole('button', { name: 'Move to space…' })).toBeNull();
    const labels = screen.getAllByRole('button').map((item) => item.props.accessibilityLabel);
    expect(labels.slice(labels.indexOf('Rename'), labels.indexOf('Archive') + 1)).toEqual(['Rename', 'Open pull request on GitHub', 'Share link',
      'Copy link', 'Copy branch name', 'Copy session ID', 'Archive'].filter((label) => labels.includes(label)));
  });
  it('moves a session to a space when Spaces is offered', async () => {
    mockActive.api.features.get.mockResolvedValue({ workbenches: true, spaces: true });
    mockTeams.mockResolvedValue([{ id: 'team-one', name: 'Acme', role: 'member', spaces: [{ id: 'space-one', name: 'Platform', teamId: 'team-one' }] }]);
    mockMoveSession.mockResolvedValue(session({ spaceId: 'space-one' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await waitFor(() => expect(mockTeams).toHaveBeenCalled());
    await fireEvent.press(await screen.findByRole('button', { name: 'Session actions' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Move to space…' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Platform' }));
    await waitFor(() => expect(mockMoveSession).toHaveBeenCalledWith('session-one', 'space-one'));
  });
});

describe('history', () => {
  const archived = [
    session({ id: 'old-one', title: 'Fix login', archivedAt: '2026-11-08T10:00:00Z' }),
    session({ id: 'old-two', title: 'Add search', branch: 'tom/search', archivedAt: '2026-11-09T10:00:00Z' }),
    { ...thread(), id: 'thread-old', title: 'Plan the launch', archivedAt: '2026-11-09T09:00:00Z' },
  ];
  beforeEach(() => { mockActive.api.workbenches.list.mockResolvedValue([session(), ...archived]); });
  it('lists archived sessions newest first, and threads on their own segment', async () => {
    await render(<HistoryScreen />);
    const rows = await screen.findAllByRole('link');
    expect(rows.map((row) => row.props.accessibilityLabel)).toEqual([expect.stringMatching(/^Add search\./), expect.stringMatching(/^Fix login\./)]);
    expect(mockActive.api.workbenches.list).toHaveBeenCalledWith('one', { includeArchived: true, kinds: ['session', 'thread'] });
    await fireEvent.press(screen.getByRole('tab', { name: 'Threads' }));
    expect((await screen.findAllByRole('link')).map((row) => row.props.accessibilityLabel)).toEqual([expect.stringMatching(/^Plan the launch\./)]);
  });
  it('searches by name, branch and repository', async () => {
    await render(<HistoryScreen />);
    await screen.findAllByRole('link');
    await fireEvent.changeText(screen.getByLabelText('Search archived work'), 'tom/search');
    expect(screen.getAllByRole('link').map((row) => row.props.accessibilityLabel)).toEqual([expect.stringMatching(/^Add search\./)]);
    await fireEvent.changeText(screen.getByLabelText('Search archived work'), 'nothing like this');
    expect(screen.getByText('No archived sessions match your search.')).toBeVisible();
  });
  it('restores from the row and opens it', async () => {
    await render(<HistoryScreen />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Restore Add search' }));
    await waitFor(() => expect(mockActive.api.workbenches.restore).toHaveBeenCalledWith('old-two'));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/sessions/[id]', params: { id: 'old-two' } });
    expect(screen.queryByRole('button', { name: 'Restore Add search' })).toBeNull();
  });
  it('restores from the long-press menu, and a box refusal gets the plan alert', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockActive.api.workbenches.restore.mockRejectedValueOnce({ status: 402, code: 'usage_exhausted', details: { notice: { message: 'No box-hours left.' } } });
    await render(<HistoryScreen />);
    await fireEvent(await screen.findByRole('link', { name: /^Fix login\./ }), 'longPress');
    await fireEvent.press(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Out of box-hours', 'No box-hours left.', expect.any(Array)));
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
  it('says when nothing is archived', async () => {
    mockActive.api.workbenches.list.mockResolvedValue([session()]);
    await render(<HistoryScreen />);
    expect(await screen.findByText('No archived sessions')).toBeVisible();
  });
});
