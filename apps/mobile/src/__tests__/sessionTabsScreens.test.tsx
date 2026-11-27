import type { Workbench, WorkbenchBackground } from '@talyn/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Alert, Dimensions, Platform, StyleSheet } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { HistoryScreen } from '../features/history/HistoryScreen';
import { HeaderTitle, SessionStatusRow } from '../features/sessions/DetailHeader';
import { WorkbenchDetailScreen } from '../features/sessions/WorkbenchDetailScreen';
import { palettes } from '../theme/tokens';
import { chat, fixture, pr, review, session, thread } from './workflowFixtures';

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
  Stack: { Screen: ({ options }: { options?: { headerTitle?: () => React.ReactNode; headerRight?: () => React.ReactNode } }) => {
    const React_ = jest.requireActual('react'); const { View } = jest.requireActual('react-native');
    return React_.createElement(View, { testID: 'navigation-header' }, options?.headerTitle?.(), options?.headerRight?.());
  } },
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

/** Opens one of the views from the session menu. */
async function openView(label: string) {
  await fireEvent.press(await screen.findByRole('button', { name: 'Session actions' }));
  await fireEvent.press(screen.getByRole('button', { name: label }));
}
const withRow = (rowPatch: Parameters<typeof pr>[0]) => mockActive.api.pullRequests.get.mockResolvedValue({ row: pr(rowPatch), fresh: null });
const summary = (summaryPatch: Partial<ReturnType<typeof pr>['summary']>) => ({ summary: { ...pr().summary, ...summaryPatch } });

describe('compact session header', () => {
  it('keeps status controls below the navigation header', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ diffStat: { added: 123456, removed: 78901, files: 200 } }));
    withRow({ codeReview: review() });
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByRole('header', { name: 'Current work. #42 open, waiting on checks or review.' })).toBeVisible();
    expect(await screen.findByRole('button', { name: /^Pull request 42\. .*Open the pull request\.$/ })).toBeVisible();
    expect(await screen.findByRole('button', { name: /^Changes: 200 files/ })).toBeVisible();
    expect(await screen.findByTestId('session-review-badge')).toBeVisible();
    const navigation = within(screen.getByTestId('navigation-header'));
    expect(navigation.getAllByRole('button').map((button) => button.props.accessibilityLabel))
      .toEqual(['Find in transcript', 'Session actions']);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByText(/Updated /)).toBeNull();
    expect(screen.queryByText('example/project')).toBeNull();
  });
  it.each([
    ['ios', 320, 0, 1],
    ['ios', 375, 0, 2],
    ['ios', 812, 44, 1],
    ['android', 320, 0, 1],
    ['android', 360, 0, 2],
    ['android', 800, 24, 1],
  ] as const)('reserves room for navigation on %s at %d dp with %d dp insets and font scale %d', async (os, width, inset, fontScale) => {
    jest.replaceProperty(Platform, 'OS', os);
    jest.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 800, scale: 1, fontScale });
    const title = 'A long session title that must leave room for search and the session menu';
    const onPress = jest.fn();
    await render(<SafeAreaInsetsContext.Provider value={{ top: 0, bottom: 0, left: inset, right: inset }}>
      <HeaderTitle item={session({ title })} row={null} onPress={onPress} />
    </SafeAreaInsetsContext.Provider>);
    const heading = screen.getByRole('header', { name: new RegExp(`^${title}`) });
    const maxWidth = StyleSheet.flatten(heading.props.style).maxWidth;
    expect(maxWidth).toBeGreaterThan(0);
    expect(maxWidth + (os === 'ios' ? 196 : 186)).toBeLessThanOrEqual(width - 2 * inset);
    expect(screen.getByText(title).props.numberOfLines).toBe(1);
    await fireEvent.press(heading);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['a session without status', noPr({ diffStat: null })],
    ['a thread', thread()],
  ])('leaves no status row for %s', async (_label, item) => {
    const { toJSON } = await render(<SessionStatusRow item={item} row={null} onChanges={jest.fn()} />);
    expect(toJSON()).toBeNull();
  });
  it('opens the pull request from its number', async () => {
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Pull request 42\./ }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/attention/[id]', params: { id: 'pr-one' } });
  });
  it('shows the +/- count and opens Changes from it', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ diffStat: { added: 12, removed: 3, files: 2 } }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Changes: 2 files, 12 added, 3 removed' }));
    expect(await screen.findByRole('button', { name: 'Modified: src/app.ts. 2 added, 1 removed.' })).toBeVisible();
  });
  it('keeps a thread to its title and menu, with no PR marks or actions', async () => {
    mockParams = { id: 'thread-one' };
    await render(<WorkbenchDetailScreen kind="thread" />);
    expect(await screen.findByRole('header', { name: /^Planning work\./ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Thread actions' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Pull request|^Changes:/ })).toBeNull();
    expect(screen.queryByLabelText('Quick actions')).toBeNull();
  });
  it('hides the action row when there is nothing to do', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(noPr({ diffStat: null }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await screen.findByRole('header', { name: /^Current work\./ });
    expect(screen.queryByLabelText('Quick actions')).toBeNull();
  });
  it('shows the full details in a sheet from the title', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ chats: [chat({ agent: 'claude', model: 'claude-opus-5-5', effort: 'high' })], threadId: 'thread-one' }));
    withRow(summary({ blockingReason: 'merge_conflicts' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('header', { name: /^Current work\./ }));
    expect(await screen.findByRole('header', { name: 'Session details' })).toBeVisible();
    expect(screen.getByLabelText('Repository: example/project')).toBeVisible();
    expect(screen.getByLabelText('Branch: tom/example → main')).toBeVisible();
    expect(screen.getByLabelText('Agent: Claude · Opus 5.5 · High effort')).toBeVisible();
    expect(screen.getByLabelText(/^Updated: /)).toBeVisible();
    expect(screen.getByRole('button', { name: /Pull request 42: Review current work\. Conflicts\./ })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Open parent thread' }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/threads/[id]', params: { id: 'thread-one' } });
  });
  it.each([
    ['with findings', review(), 'Code review: 2 findings. Must fix 1 · Should fix 1. Show the findings.'],
    ['that failed', review({ phase: 'failed', openCount: 0, failureReason: 'The runner stopped.' }),
      'Code review: The review did not finish. The runner stopped. Show the findings.'],
  ])('shows the code review %s in the details sheet and opens its findings', async (_name, codeReview, label) => {
    withRow({ codeReview });
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('header', { name: /^Current work\./ }));
    await fireEvent.press(await screen.findByRole('button', { name: label }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/attention/[id]', params: { id: 'pr-one', tab: 'findings' } });
  });
  it('shows no code review in the details sheet when the PR has none', async () => {
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('header', { name: /^Current work\./ }));
    await screen.findByRole('header', { name: 'Session details' });
    expect(screen.queryByRole('button', { name: /^Code review/ })).toBeNull();
  });
  it.each([
    ['a GitHub rule', { kind: 'workflow', workflowId: 'wf-one', runId: 'r' }, 'GitHub', { kind: 'github', id: 'wf-one' }],
    ['a Linear rule', { kind: 'workflow', workflowId: 'wf-two', runId: 'r', integration: 'linear' }, 'Linear', { kind: 'linear', id: 'wf-two' }],
    ['a PostHog Inbox rule', { kind: 'workflow', workflowId: 'wf-three', runId: 'r', integration: 'posthog_inbox' }, 'PostHog Inbox', { kind: 'posthog_inbox', id: 'wf-three' }],
    ['a scheduled loop', { kind: 'loop', loopId: 'lp-one', runId: 'r' }, 'Schedule', { kind: 'schedule', id: 'lp-one' }],
  ] as const)('links %s that started the session back to it', async (_name, source, label, params) => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ source }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('header', { name: /^Current work\./ }));
    await fireEvent.press(await screen.findByRole('button', { name: `Open the ${label} automation that started this session` }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/integrations/[kind]/[id]', params });
  });
  it('shows no automation row for a session from the composer', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ source: null }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('header', { name: /^Current work\./ }));
    expect(await screen.findByRole('header', { name: 'Session details' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /automation that started this session$/ })).toBeNull();
  });
});

describe('quick actions', () => {
  const chips = () => screen.getByLabelText('Quick actions');
  it('adds the pull request to the merge queue through the client', async () => {
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Add to merge queue' }));
    await waitFor(() => expect(mockActive.api.pullRequests.setMergeQueue).toHaveBeenCalledWith('pr-one', true));
    expect(await screen.findByText('Added #42 to the merge queue.')).toBeVisible();
  });
  const accent = { backgroundColor: palettes.light.primaryAction };
  it('keeps the queue chip quiet when it is the only chip', async () => {
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByRole('button', { name: 'Add to merge queue' })).not.toHaveStyle(accent);
  });
  it('fills the next step and keeps the queue quiet beside it', async () => {
    withRow(summary({ mergeable: 'MERGEABLE', ciStatus: 'passing', blockingReason: 'mergeable' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByRole('button', { name: 'Merge' })).toHaveStyle(accent);
    expect(screen.getByRole('button', { name: 'Add to merge queue' })).not.toHaveStyle(accent);
  });
  it('leaves Wake to the menu', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ sandboxState: 'suspended' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await screen.findByRole('button', { name: 'Add to merge queue' });
    expect(screen.queryByRole('button', { name: 'Wake' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Session actions' }));
    expect(screen.getByRole('button', { name: 'Wake sandbox' })).toBeVisible();
  });
  it('shows the queue state once queued and opens the PR from it', async () => {
    withRow({ mergeQueued: true, mergeQueue: { position: 2, status: 'queued' } as never });
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Queued #2' }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/attention/[id]', params: { id: 'pr-one' } });
    expect(mockActive.api.pullRequests.setMergeQueue).not.toHaveBeenCalled();
  });
  it('merges only after a confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    withRow(summary({ mergeable: 'MERGEABLE', ciStatus: 'passing', blockingReason: 'mergeable' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Merge' }));
    expect(alert.mock.calls[0][0]).toBe('Merge #42?');
    expect(mockActive.api.pullRequests.merge).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0][2] as Array<{ text: string; onPress?(): void }>;
    await act(async () => buttons.find((button) => button.text === 'Merge')?.onPress?.());
    expect(mockActive.api.pullRequests.merge).toHaveBeenCalledWith('pr-one');
    expect(await screen.findByText('Merged #42.')).toBeVisible();
  });
  it.each([
    ['Resolve conflicts', 'resolve_conflicts', { mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' }],
    ['Fix checks', 'fix_checks', { mergeable: 'MERGEABLE', ciStatus: 'failing_required', blockingReason: 'checks_failed' }],
  ] as const)('%s sends the action to the session chat', async (label, action, summaryPatch) => {
    withRow(summary(summaryPatch as never));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(mockActive.api.workbenches.action).toHaveBeenCalledWith('session-one', action, 'chat-one'));
    expect(await screen.findByText('Sent to the agent.')).toBeVisible();
  });
  it('leaves Stop to the composer, not the row', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ chats: [chat({ status: 'running' })] }));
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByRole('button', { name: 'Stop the agent' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
  it('disables every action offline and says why', async () => {
    mockNetwork = 'offline';
    await mockActive.store.load('workbench', 'session-one');
    await mockActive.store.load('pr', 'pr-one');
    await render(<WorkbenchDetailScreen kind="session" />);
    const queue = await screen.findByRole('button', { name: 'Add to merge queue' });
    expect(queue).toBeDisabled();
    expect(queue.props.accessibilityHint).toBe('You are offline.');
    expect(chips()).toBeVisible();
  });
  it('lists the PR cycle and the queue in the menu', async () => {
    withRow(summary({ mergeable: 'MERGEABLE', ciStatus: 'passing', blockingReason: 'mergeable' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await screen.findByRole('button', { name: 'Merge' });
    await fireEvent.press(screen.getByRole('button', { name: 'Session actions' }));
    const labels = screen.getAllByRole('button').map((item) => item.props.accessibilityLabel);
    expect(labels).toEqual(expect.arrayContaining(['Details', 'Changes', 'Pull request', 'Merge', 'Add to merge queue', 'Rename']));
    // The chip comes first in the tree; the menu's own entry is the last one.
    expect(labels.indexOf('Details')).toBeLessThan(labels.lastIndexOf('Merge'));
    expect(labels.lastIndexOf('Merge')).toBeLessThan(labels.indexOf('Rename'));
  });
});

describe('changes', () => {
  it('lists the changed files and opens a diff with numbered, read-only lines', async () => {
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Changes');
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
    await openView('Changes');
    expect(await screen.findByText('Sandbox is asleep. Talyn has no stored copy of its changes yet.')).toBeVisible();
    expect(api().changes).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Wake the sandbox' }));
    await waitFor(() => expect(api().changes).toHaveBeenLastCalledWith('session-one', { live: true }));
    expect(await screen.findByRole('button', { name: /src\/app\.ts/ })).toBeVisible();
  });
  it('says the list is a stored copy and refreshes from the sandbox on request', async () => {
    api().changes.mockResolvedValue({ ...changes, snapshotAt: new Date(Date.now() - 5 * 60_000).toISOString(), source: 'stored', storedReason: 'asleep' });
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Changes');
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
    await openView('Changes');
    await fireEvent.press(await screen.findByRole('button', { name: /src\/app\.ts/ }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Wake the sandbox to see it' }));
    expect(await screen.findByLabelText('Added line 3: second')).toBeVisible();
    expect(api().diff).toHaveBeenLastCalledWith('session-one', 'src/app.ts', 'combined', { live: true });
  });
  it('shows a merged PR first and the branch diff only on request', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ pr: { number: 42, state: 'merged', url: 'https://github.com/example/project/pull/42' } as never }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Changes');
    expect(await screen.findByText('PR #42 merged. Its changes are in main.')).toBeVisible();
    expect(api().changes).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Show the branch diff anyway' }));
    await waitFor(() => expect(api().changes).toHaveBeenCalled());
  });
  it('explains a local session instead of reading it', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ runtime: 'local' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Changes');
    expect(await screen.findByText('This session runs on a computer with the Talyn desktop app. Open it there.')).toBeVisible();
    expect(api().changes).not.toHaveBeenCalled();
  });
});

describe('pull request view', () => {
  it('opens the PR screen from the menu when one is linked', async () => {
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Pull request');
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/attention/[id]', params: { id: 'pr-one' } });
  });
  it('creates a PR through the chat from the row, like web', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(noPr());
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Create PR' }));
    await waitFor(() => expect(mockActive.api.workbenches.sendMessage).toHaveBeenCalledWith('chat-one',
      { text: 'Create a pull request', intent: 'create_pr', planMode: false }));
    expect(await screen.findByText('Sent to the agent. It opens the pull request when its turn ends.')).toBeVisible();
  });
  it('shows the plan alert when the box gate refuses Create PR', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockActive.api.workbenches.get.mockResolvedValue(noPr());
    mockActive.api.workbenches.sendMessage.mockRejectedValueOnce({ status: 402, code: 'usage_exhausted', details: { notice: { message: 'No box-hours left.' } } });
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Create PR' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Out of box-hours', 'No box-hours left.', expect.any(Array)));
  });
  it('creates a PR from the pull request sheet and closes it', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(noPr());
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Pull request');
    await fireEvent.press(await screen.findByRole('button', { name: 'Create pull request' }));
    expect(await screen.findByText('Sent to the agent. It opens the pull request when its turn ends.')).toBeVisible();
    expect(screen.queryByRole('header', { name: 'Pull request' })).toBeNull();
  });
  it('links an existing PR from the open ones', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(noPr());
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Pull request');
    await fireEvent.press(await screen.findByRole('button', { name: 'Link an existing pull request' }));
    await fireEvent.press(await screen.findByRole('button', { name: '#7 Earlier work' }));
    await waitFor(() => expect(api().linkPullRequest).toHaveBeenCalledWith('session-one', 7));
  });
  it('removes a link that needs a local checkout and says where to do it', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockActive.api.workbenches.get.mockResolvedValue(noPr());
    api().linkPullRequest.mockResolvedValue({ workbench: session(), needsCheckout: { branch: 'x', remoteRef: 'refs/heads/x' } });
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Pull request');
    await fireEvent.press(await screen.findByRole('button', { name: 'Link an existing pull request' }));
    await fireEvent.press(await screen.findByRole('button', { name: '#7 Earlier work' }));
    await waitFor(() => expect(api().unlinkPullRequest).toHaveBeenCalledWith('session-one'));
    expect(alert).toHaveBeenCalledWith('Could not link the pull request', expect.stringContaining('desktop app'));
  });
});

describe('jobs view', () => {
  it('stops a running job after a confirmation and shows its output', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    api().background.mockResolvedValue(background([job()]));
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Background jobs');
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
    await screen.findByRole('header', { name: /^Current work\./ });
    await fireEvent.press(screen.getByRole('button', { name: 'Session actions' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Background jobs' }).props.accessibilityHint).toBe('1 running'));
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => handlers.forEach((handler) => handler(background([job({ status: 'exited', exitCode: 0 })]))));
    await fireEvent.press(screen.getByRole('button', { name: 'Session actions' }));
    expect(screen.getByRole('button', { name: 'Background jobs' }).props.accessibilityHint).toBeUndefined();
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


describe('parent and child sessions', () => {
  it.each([false, true])('shows parent controls only with the flag enabled: %s', async (enabled) => {
    mockActive.api.features.get.mockResolvedValue({ workbenches: true, sessionSubagents: enabled });
    mockActive.api.workbenches.get.mockResolvedValue(session({ parentId: 'parent-one' }));
    mockActive.api.workbenches.threadSessions.mockResolvedValue([session({ id: 'child-one', parentId: 'session-one', title: 'Child work' })]);
    await render(<WorkbenchDetailScreen kind="session" />);
    if (enabled) {
      const parent = await screen.findByText('Open parent session');
      await fireEvent.press(parent);
      expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/sessions/[id]', params: { id: 'parent-one' } });
      expect(await screen.findByText('Sessions started (1)')).toBeTruthy();
    } else {
      await waitFor(() => expect(mockActive.api.features.get).toHaveBeenCalled());
      expect(screen.queryByText('Open parent session')).toBeNull();
      expect(screen.queryByText('Sessions started (1)')).toBeNull();
    }
  });
});
