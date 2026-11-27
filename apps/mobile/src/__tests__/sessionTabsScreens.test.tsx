import { ApiError } from '@talyn/client/native';
import type { RepositoryPreviewResponse, Workbench, WorkbenchBackground } from '@talyn/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Alert, Dimensions, Linking, Platform, StyleSheet } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { HistoryScreen } from '../features/history/HistoryScreen';
import { HeaderTitle } from '../features/sessions/DetailHeader';
import { WorkbenchDetailScreen } from '../features/sessions/WorkbenchDetailScreen';
import { palettes } from '../theme/tokens';
import { chat, fixture, pr, review, scope, session, thread } from './workflowFixtures';

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

describe('hosted sandbox previews', () => {
  const hostedUrl = 'https://sandbox-5173.preview.test/__talyn/auth?ticket=one-time';
  const waiting = { ready: false, running: true };
  const ready = { ready: true, running: false };
  const stopped = { ready: false, running: false };
  const withSignal = expect.objectContaining({ signal: expect.anything() });

  function enablePreview(settings: Partial<RepositoryPreviewResponse> = {}) {
    mockActive.api.features.get.mockResolvedValue({ workbenches: true, previewLinks: true });
    const get = jest.fn(async (): Promise<RepositoryPreviewResponse> => ({
      target: 'sandbox', ports: [{ port: 5173, label: 'App' }, { port: 4000, label: 'API' }],
      reasons: [], source: 'user', user: {}, detected: null, ...settings,
    }));
    Object.assign(mockActive.api.repositories, { preview: { get } });
    const previewStatus = jest.fn(async (_id: string, _port: number, _opts: { live?: boolean; signal: AbortSignal }) => ready);
    const runScript = jest.fn(async (_id: string, _name: string, _opts: { signal: AbortSignal }) => undefined);
    const previewLink = jest.fn(async (_id: string, _port: number, _opts: { signal: AbortSignal }) => ({ url: hostedUrl }));
    Object.assign(mockActive.api.workbenches, { previewStatus, runScript, previewLink });
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    return { get, previewStatus, runScript, previewLink, openURL };
  }

  async function answerPreviewPrompt(alert: jest.SpiedFunction<typeof Alert.alert>, answer: 'Cancel' | 'Open website') {
    expect(alert).toHaveBeenLastCalledWith('Open external website?', new URL(hostedUrl).origin, expect.any(Array));
    const buttons = alert.mock.lastCall?.[2];
    const button = buttons?.find(({ text }) => text === answer);
    expect(button).toBeDefined();
    await act(() => { button?.onPress?.(); });
  }

  it('opens the selected port through a new hosted ticket if the port is already responding', async () => {
    const { get, previewStatus, runScript, previewLink, openURL } = enablePreview();
    const alert = jest.spyOn(Alert, 'alert');
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(get).toHaveBeenCalledWith('repo-one');
    await openView('Preview');
    expect(screen.getByRole('button', { name: 'API' })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'App' }));
    expect(previewStatus).toHaveBeenCalledWith('session-one', 5173, withSignal);
    expect(runScript).not.toHaveBeenCalled();
    expect(previewLink).toHaveBeenCalledWith('session-one', 5173, withSignal);
    expect(openURL).not.toHaveBeenCalled();
    await answerPreviewPrompt(alert, 'Open website');
    expect(openURL).toHaveBeenCalledWith(hostedUrl);
  });

  it('keeps the browser closed when the person cancels confirmation', async () => {
    const { openURL } = enablePreview();
    const alert = jest.spyOn(Alert, 'alert');
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Preview');
    await fireEvent.press(screen.getByRole('button', { name: 'App' }));
    await answerPreviewPrompt(alert, 'Cancel');
    expect(openURL).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'App' })).toBeEnabled();
  });

  it.each([false, true])('waits for port 3000 after starting the run script (concurrent start %s)', async (concurrent) => {
    const { previewStatus, runScript, previewLink, openURL } = enablePreview({ ports: [] });
    const alert = jest.spyOn(Alert, 'alert');
    previewStatus.mockResolvedValueOnce(stopped).mockResolvedValueOnce(waiting);
    if (concurrent) runScript.mockRejectedValueOnce(new ApiError('Script already running.', 409, 'script_running'));
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Preview');
    await fireEvent.press(screen.getByRole('button', { name: 'Port 3000' }));
    expect(runScript).toHaveBeenCalledWith('session-one', 'run', withSignal);
    expect(screen.getByText('Waiting for the app to start…')).toBeVisible();
    expect(previewLink).not.toHaveBeenCalled();
    await waitFor(() => expect(previewLink).toHaveBeenCalledWith('session-one', 3000, withSignal), { timeout: 3000 });
    await answerPreviewPrompt(alert, 'Open website');
    expect(openURL).toHaveBeenCalledWith(hostedUrl);
  });

  it('opens a detached server after the run script stops', async () => {
    const { previewStatus, runScript, previewLink, openURL } = enablePreview();
    const alert = jest.spyOn(Alert, 'alert');
    previewStatus.mockResolvedValueOnce(stopped).mockResolvedValueOnce(stopped);
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Preview');
    jest.useFakeTimers();
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'App' }));
      expect(runScript).toHaveBeenCalledWith('session-one', 'run', withSignal);
      expect(previewLink).not.toHaveBeenCalled();
      await act(async () => { await jest.advanceTimersByTimeAsync(1500); });
      await answerPreviewPrompt(alert, 'Open website');
      expect(openURL).toHaveBeenCalledWith(hostedUrl);
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows an unsupported preview error even if the run script is still running', async () => {
    const { previewStatus, runScript, previewLink } = enablePreview();
    previewStatus.mockResolvedValueOnce(waiting)
      .mockRejectedValueOnce(new ApiError('This sandbox does not support previews.', 409, 'preview_unsupported'));
    const alert = jest.spyOn(Alert, 'alert');
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Preview');
    await fireEvent.press(screen.getByRole('button', { name: 'App' }));
    expect(alert).toHaveBeenCalledWith('Could not open the preview', 'This sandbox does not support previews.');
    expect(previewStatus).toHaveBeenCalledTimes(2);
    expect(runScript).not.toHaveBeenCalled();
    expect(previewLink).not.toHaveBeenCalled();
  });

  it('reports a stopped script after the grace period without opening the browser', async () => {
    const { previewStatus, previewLink, openURL } = enablePreview();
    previewStatus.mockResolvedValue(stopped);
    const alert = jest.spyOn(Alert, 'alert');
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Preview');
    jest.useFakeTimers();
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'App' }));
      expect(alert).not.toHaveBeenCalled();
      await act(async () => { await jest.advanceTimersByTimeAsync(10_500); });
      expect(alert).toHaveBeenCalledWith('Could not open the preview', 'The run script stopped before the app answered.');
      expect(previewLink).not.toHaveBeenCalled();
      expect(openURL).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['initial check', 'run start', 'live check', 'ticket'] as const)('aborts a stalled %s at the startup deadline', async (phase) => {
    const { previewStatus, runScript, previewLink, openURL } = enablePreview();
    const alert = jest.spyOn(Alert, 'alert');
    const stalled = new Promise<never>(() => {});
    if (phase === 'initial check') previewStatus.mockReturnValueOnce(stalled);
    if (phase === 'run start') {
      previewStatus.mockResolvedValueOnce(stopped);
      runScript.mockReturnValueOnce(stalled);
    }
    if (phase === 'live check') previewStatus.mockResolvedValueOnce(waiting).mockReturnValueOnce(stalled);
    if (phase === 'ticket') previewLink.mockReturnValueOnce(stalled);
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Preview');
    jest.useFakeTimers();
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'App' }));
      const signal = previewStatus.mock.calls[0][2].signal;
      const lastRequest = phase === 'run start' ? runScript : phase === 'ticket' ? previewLink : previewStatus;
      expect(lastRequest.mock.lastCall?.[2].signal).toBe(signal);
      expect(signal.aborted).toBe(false);
      await act(async () => { await jest.advanceTimersByTimeAsync(600_000); });
      expect(signal.aborted).toBe(true);
      expect(openURL).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledWith('Could not open the preview', 'Talyn could not prepare the preview on port 5173 within 10 minutes.');
      expect(screen.getByRole('button', { name: 'App' })).toBeEnabled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not open the browser if the preview sheet closes during startup', async () => {
    const { previewStatus, previewLink, openURL } = enablePreview();
    let finishProbe!: (status: typeof ready) => void;
    previewStatus.mockImplementationOnce(() => new Promise((resolve) => { finishProbe = resolve; }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Preview');
    await fireEvent.press(screen.getByRole('button', { name: 'App' }));
    await fireEvent.press(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(previewStatus.mock.calls[0][2].signal.aborted).toBe(true);
    await act(() => { finishProbe(ready); });
    expect(previewLink).not.toHaveBeenCalled();
    expect(openURL).not.toHaveBeenCalled();
  });

  it.each(['off', 'coder'] as const)('hides the entry when the repository target is %s', async (target) => {
    const { get } = enablePreview({ target });
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(get).toHaveBeenCalledWith('repo-one');
    await fireEvent.press(await screen.findByRole('button', { name: 'Session actions' }));
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
  });

  it.each([
    ['local', { runtime: 'local' }],
    ['archived', { status: 'archived' }],
    ['shared', { workspaceId: 'another-workspace' }],
  ] as [string, Partial<Workbench>][])('hides the entry for a %s session', async (_label, patch_) => {
    const { get } = enablePreview();
    const item = noPr(patch_);
    mockActive.store.setScope({ ...scope, workspace: item.workspaceId });
    mockActive.api.workbenches.get.mockResolvedValue(item);
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Session actions' }));
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('session agent switch', () => {
  it.each([['claude', 'Codex', 'codex'], ['codex', 'Claude', 'claude']] as const)(
    'switches a %s chat without sending a message or overriding its model tier', async (agent, label, alternate) => {
      mockActive.api.workbenches.get.mockResolvedValue(session({ sandboxId: 'box', agent, chats: [chat({ agent })],
        settings: { sandboxAgents: { box: ['claude', 'codex'] } } as Workbench['settings'] }));
      await render(<WorkbenchDetailScreen kind="session" />);
      await openView(`Switch to ${label}`);
      expect(mockActive.api.workbenches.updateChat).toHaveBeenCalledWith('chat-one', { agent: alternate });
      expect(mockActive.api.workbenches.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('does not offer an agent that is not installed in the sandbox', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ sandboxId: 'box' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Session actions' }));
    expect(screen.queryByRole('button', { name: 'Switch to Claude' })).toBeNull();
  });
});

describe('mobile session header', () => {
  it('pairs one action with its status and keeps other controls in the menu', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ diffStat: { added: 123456, removed: 78901, files: 200 } }));
    withRow({ codeReview: review(), ...summary({ mergeable: 'MERGEABLE', ciStatus: 'failing_required', blockingReason: 'checks_failed',
      checks: { total: 8, passed: 6, failed: 2, inProgress: 0, skipped: 0 } }) });
    await render(<WorkbenchDetailScreen kind="session" />);
    const navigation = within(await screen.findByTestId('navigation-header'));
    expect(navigation.getAllByRole('button').map((button) => button.props.accessibilityLabel)).toEqual(['Session actions']);
    expect(await navigation.findByText('example/project')).toBeVisible();
    const next = within(await screen.findByLabelText('Next action'));
    expect(next.getAllByRole('button').map((button) => button.props.accessibilityLabel))
      .toEqual(['PR #42. 2 of 8 checks failing.', 'Fix checks']);
    expect(screen.queryByRole('button', { name: 'Code review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Find in transcript' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to merge queue' })).toBeNull();
    await fireEvent.press(navigation.getByRole('button', { name: 'Session actions' }));
    expect(screen.getByRole('button', { name: 'Code review' })).toHaveProp('accessibilityHint', '2 findings');
    expect(screen.getByRole('button', { name: 'Changes' })).toHaveProp('accessibilityHint', '200 files, +123456 −78901');
    expect(screen.getByRole('button', { name: 'Find in transcript' })).toBeVisible();
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
    const title = 'A long session title that must leave room for the session menu';
    const onPress = jest.fn();
    await render(<SafeAreaInsetsContext.Provider value={{ top: 0, bottom: 0, left: inset, right: inset }}>
      <HeaderTitle item={session({ title })} row={null} onPress={onPress} />
    </SafeAreaInsetsContext.Provider>);
    const heading = screen.getByRole('header', { name: new RegExp(`^${title}`) });
    const maxWidth = StyleSheet.flatten(heading.props.style).maxWidth;
    expect(maxWidth).toBeGreaterThan(0);
    expect(maxWidth + (os === 'ios' ? 112 : 144)).toBe(width - 2 * inset);
    expect(screen.getByText(title).props.numberOfLines).toBe(1);
    await fireEvent.press(heading);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
  it('opens the pull request from the next action context', async () => {
    withRow(summary({ mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'PR #42. Merge conflicts.' }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/attention/[id]', params: { id: 'pr-one' } });
  });
  it('opens Changes from the Create PR context', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(noPr());
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Changes. 2 files changed.' }));
    expect(await screen.findByRole('button', { name: 'Modified: src/app.ts. 2 added, 1 removed.' })).toBeVisible();
  });
  it('pairs Retry with the sandbox failure and opens its details', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ status: 'error', error: 'The sandbox did not start.' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(retry).toHaveProp('accessibilityHint', 'The sandbox did not start.');
    await fireEvent.press(screen.getByRole('button', { name: 'Sandbox. Failed to start.' }));
    expect(await screen.findByRole('header', { name: 'Session details' })).toBeVisible();
  });
  it('keeps a thread to its title and menu, with no PR marks or actions', async () => {
    mockParams = { id: 'thread-one' };
    await render(<WorkbenchDetailScreen kind="thread" />);
    expect(await screen.findByRole('header', { name: /^Planning work\./ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Thread actions' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Find in transcript' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Pull request|^Changes:/ })).toBeNull();
    expect(screen.queryByLabelText('Quick actions')).toBeNull();
  });
  it('hides the action row when there is nothing to do', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(noPr({ diffStat: null }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await screen.findByRole('header', { name: /^Current work\./ });
    expect(screen.queryByLabelText('Next action')).toBeNull();
  });
  it('offers Restore only in the menu for an archived session', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ archivedAt: '2026-11-09T10:00:00Z' }));
    withRow({ state: 'merged' });
    await render(<WorkbenchDetailScreen kind="session" />);
    const actions = await screen.findByRole('button', { name: 'Session actions' });
    expect(screen.queryByLabelText('Next action')).toBeNull();
    await fireEvent.press(actions);
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeVisible();
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

describe('next action and menu', () => {
  it('adds the pull request to the merge queue from the menu', async () => {
    await render(<WorkbenchDetailScreen kind="session" />);
    await openView('Add to merge queue');
    await waitFor(() => expect(mockActive.api.pullRequests.setMergeQueue).toHaveBeenCalledWith('pr-one', true));
    expect(await screen.findByText('Added #42 to the merge queue.')).toBeVisible();
  });
  it('keeps the row hidden when checks are pending', async () => {
    withRow(summary({ mergeable: 'MERGEABLE', ciStatus: 'running' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await screen.findByRole('button', { name: 'Session actions' });
    expect(screen.queryByLabelText('Next action')).toBeNull();
  });
  it('fills the primary action and leaves the queue in the menu', async () => {
    withRow(summary({ mergeable: 'MERGEABLE', ciStatus: 'passing', blockingReason: 'mergeable' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByRole('button', { name: 'Merge' })).toHaveStyle({ backgroundColor: palettes.light.primaryAction });
    expect(screen.queryByRole('button', { name: 'Add to merge queue' })).toBeNull();
  });
  it('leaves Wake in the menu', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ sandboxState: 'suspended' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(screen.queryByRole('button', { name: 'Wake sandbox' })).toBeNull();
    await fireEvent.press(await screen.findByRole('button', { name: 'Session actions' }));
    expect(screen.getByRole('button', { name: 'Wake sandbox' })).toBeVisible();
  });
  it('shows the queue position in the menu and opens the PR', async () => {
    withRow({ ...summary({ mergeable: 'MERGEABLE', ciStatus: 'passing' }), mergeQueued: true,
      mergeQueue: { position: 2, status: 'queued' } as never });
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Session actions' }));
    expect(screen.queryByLabelText('Next action')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove from merge queue' })).toHaveProp('accessibilityHint', 'Queued #2');
    const pullRequest = screen.getByRole('button', { name: 'Pull request' });
    expect(pullRequest).toHaveProp('accessibilityHint', 'Queued #2');
    await fireEvent.press(pullRequest);
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
  it('disables the next action and queue controls offline', async () => {
    mockNetwork = 'offline';
    withRow(summary({ mergeable: 'MERGEABLE', ciStatus: 'passing' }));
    await mockActive.store.load('workbench', 'session-one');
    await mockActive.store.load('pr', 'pr-one');
    await render(<WorkbenchDetailScreen kind="session" />);
    const merge = await screen.findByRole('button', { name: 'Merge' });
    expect(merge).toBeDisabled();
    expect(merge).toHaveProp('accessibilityHint', 'You are offline.');
    await fireEvent.press(screen.getByRole('button', { name: 'Session actions' }));
    const queue = screen.getByRole('button', { name: 'Add to merge queue' });
    expect(queue).toBeDisabled();
    expect(queue).toHaveProp('accessibilityHint', 'You are offline.');
  });
  it('lists the PR cycle and the queue in the menu', async () => {
    withRow(summary({ mergeable: 'MERGEABLE', ciStatus: 'passing', blockingReason: 'mergeable' }));
    await render(<WorkbenchDetailScreen kind="session" />);
    await screen.findByRole('button', { name: 'Merge' });
    await fireEvent.press(screen.getByRole('button', { name: 'Session actions' }));
    const labels = screen.getAllByRole('button').map((item) => item.props.accessibilityLabel);
    expect(labels).toEqual(expect.arrayContaining(['Details', 'Changes', 'Pull request', 'Merge', 'Add to merge queue', 'Rename']));
    // The primary action comes first in the tree; the menu's own entry is the last one.
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
