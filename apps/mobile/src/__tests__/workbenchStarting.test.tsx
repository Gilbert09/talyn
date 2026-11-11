import type { Workbench, WorkbenchStartProgress } from '@talyn/shared';
import { act, render, screen } from '@testing-library/react-native';

import { WorkbenchDetailScreen } from '../features/sessions/WorkbenchDetailScreen';
import { isStarting, START_PROGRESS_TICK_MS, StartingHint, startQueueText } from '../features/sessions/Starting';
import { chat, fixture, session } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'session-one' }),
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  Stack: { Screen: () => null },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store }), useNetwork: () => 'online',
  useWorkspace: () => ({ selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] }),
}));
jest.mock('../features/chat/actions', () => ({ chatActions: { stop: jest.fn(), approvePlan: jest.fn(), setPlanMode: jest.fn() } }));
beforeEach(() => { mockActive.store.dispose(); mockActive = fixture(); });
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

const wb = (over: Partial<Workbench> = {}) => session({ status: 'provisioning', sandboxState: 'creating', statusMessage: null, ...over });

describe('isStarting', () => {
  it.each<[string, Partial<Workbench>, boolean]>([
    ['provisioning', { status: 'provisioning', sandboxState: 'creating' }, true],
    ['ready but the box is still creating', { status: 'ready', sandboxState: 'creating' }, true],
    ['ready', { status: 'ready', sandboxState: 'running' }, false],
    ['lost', { status: 'provisioning', sandboxState: 'lost' }, true],
    ['lost while ready', { status: 'ready', sandboxState: 'lost' }, true],
    ['failed while the box says creating', { status: 'error', sandboxState: 'creating' }, false],
    ['provisioning with a failed box', { status: 'provisioning', sandboxState: 'error' }, false],
    ['suspended', { status: 'ready', sandboxState: 'suspended' }, false],
  ])('%s → %s', (_name, over, expected) => {
    expect(isStarting(wb(over))).toBe(expected);
  });
});

describe('startQueueText', () => {
  it.each<[number, string]>([
    [0, 'You can write your first message now. It is sent when the sandbox is ready.'],
    [1, 'Your message is queued. It is sent when the sandbox is ready.'],
    [2, '2 messages are queued. They are sent in order when the sandbox is ready.'],
    [5, '5 messages are queued. They are sent in order when the sandbox is ready.'],
  ])('%i queued', (queued, text) => {
    expect(startQueueText(queued)).toBe(text);
  });
});

describe('StartingHint', () => {
  it('says what the sandbox is doing, with a moving bar and no step list before progress arrives', async () => {
    await render(<StartingHint workbench={wb({ statusMessage: 'Cloning the repository' })} queued={0} />);
    expect(screen.getByRole('header', { name: 'Starting the sandbox' })).toBeVisible();
    expect(screen.getByText('Cloning the repository')).toBeVisible();
    expect(screen.getByText(/write your first message now/)).toBeVisible();
    expect(screen.getByTestId('start-progress-sweep')).toBeTruthy();
    expect(screen.queryByLabelText(/, in progress$/)).toBeNull();
  });

  it('names a lost sandbox', async () => {
    await render(<StartingHint workbench={wb({ sandboxState: 'lost' })} queued={0} />);
    expect(screen.getByRole('header', { name: 'Starting a new sandbox' })).toBeVisible();
  });

  it('leaves out the queue copy when there is no chat to write in', async () => {
    await render(<StartingHint workbench={wb()} queued={0} canWrite={false} />);
    expect(screen.queryByText(/write your first message/)).toBeNull();
  });
});

describe('StartingHint with start progress', () => {
  const NOW = new Date('2099-01-01T12:00:00.000Z');
  const progress = (over: Partial<WorkbenchStartProgress> = {}): WorkbenchStartProgress => ({
    step: 'code', stepIndex: 1, stepCount: 3, stepStartedAt: NOW.toISOString(), expectedMs: 60_000, percent: null, detail: null, ...over,
  });
  const fill = () => screen.getByRole('progressbar').props.accessibilityValue?.now as number | undefined;

  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); });
  afterEach(() => { jest.useRealTimers(); });

  it.each<[string, Partial<WorkbenchStartProgress>, string[], string, string[]]>([
    ['the box', { step: 'sandbox', stepIndex: 0 }, [], 'Starting the sandbox', ['Getting the code', 'Running the setup script']],
    ['the code', {}, ['Starting the sandbox'], 'Getting the code', ['Running the setup script']],
    ['the setup', { step: 'setup', stepIndex: 2 }, ['Starting the sandbox', 'Getting the code'], 'Running the setup script', []],
  ])('marks the steps: %s', async (_name, over, done, current, next) => {
    await render(<StartingHint workbench={wb({ startProgress: progress(over) })} queued={1} />);
    for (const label of done) expect(screen.getByLabelText(`${label}, done`)).toBeVisible();
    expect(screen.getByLabelText(`${current}, in progress`)).toBeVisible();
    for (const label of next) expect(screen.getByLabelText(`${label}, not started`)).toBeVisible();
    expect(screen.getByText(/^Your message is queued/)).toBeVisible();
  });

  it('shows one step line for a thread', async () => {
    await render(<StartingHint workbench={wb({ kind: 'thread', startProgress: progress({ step: 'sandbox', stepIndex: 0, stepCount: 1 }) })} queued={0} />);
    expect(screen.getByRole('header', { name: 'Starting the sandbox' })).toBeVisible();
    expect(screen.queryByLabelText(/, in progress$/)).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'Starting the sandbox' })).toBeTruthy();
  });

  it("shows git's percentage and fills the bar from it", async () => {
    await render(<StartingHint workbench={wb({ startProgress: progress({ percent: 42, detail: 'Receiving objects' }) })} queued={0} />);
    expect(screen.getByText('Receiving objects · 42%')).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'Step 2 of 3 · Getting the code. Receiving objects · 42%' })).toBeTruthy();
    expect(fill()).toBe(Math.round(((1 + 0.42) / 3) * 100));
  });

  it('moves the estimate with the clock and caps it below the end of the step', async () => {
    await render(<StartingHint workbench={wb({ startProgress: progress({ step: 'sandbox', stepIndex: 0 }) })} queued={0} />);
    expect(fill()).toBe(0);
    await act(async () => { jest.advanceTimersByTime(60_000 - (60_000 % START_PROGRESS_TICK_MS) + START_PROGRESS_TICK_MS); });
    expect(fill()).toBe(Math.round((0.8 / 3) * 100));
    await act(async () => { jest.advanceTimersByTime(10 * 60_000); });
    expect(fill()).toBe(Math.round((0.95 / 3) * 100));
  });

  it('is indeterminate with no history for the step', async () => {
    await render(<StartingHint workbench={wb({ startProgress: progress({ expectedMs: null }) })} queued={0} />);
    expect(fill()).toBeUndefined();
    expect(screen.getByTestId('start-progress-sweep')).toBeTruthy();
  });

  it('never moves backwards when a broadcast drops the git percentage', async () => {
    const view = await render(<StartingHint workbench={wb({ startProgress: progress({ percent: 90 }) })} queued={0} />);
    expect(fill()).toBe(Math.round((1.9 / 3) * 100));
    await view.rerender(<StartingHint workbench={wb({ startProgress: progress({ percent: null }) })} queued={0} />);
    expect(fill()).toBe(Math.round((1.9 / 3) * 100));
  });
});

describe('the session screen while the sandbox starts', () => {
  const starting = (over: Partial<Workbench> = {}) => session({ status: 'provisioning', sandboxState: 'creating', statusMessage: 'Cloning the repository',
    startProgress: { step: 'code', stepIndex: 1, stepCount: 3, stepStartedAt: new Date().toISOString(), expectedMs: null, percent: null, detail: null }, ...over });

  it('shows the starting view in place of the empty conversation', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(starting());
    mockActive.api.workbenches.events.mockResolvedValue({ events: [], cursor: 0, oldestSeq: 0, hasOlder: false });
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByTestId('workbench-starting')).toBeTruthy();
    expect(screen.getByLabelText('Getting the code, in progress')).toBeVisible();
    expect(screen.getByText('Cloning the repository')).toBeVisible();
    expect(screen.queryByText('No messages yet.')).toBeNull();
    expect(screen.getByPlaceholderText('The sandbox is starting. A message now is queued.')).toBeTruthy();
  });

  it('keeps a short starting line under a queued message', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(starting({ chats: [chat({ queuedMessages: [
      { id: 'q1', text: 'Fix the build', origin: 'user', queuedAt: '2026-11-08T11:00:00Z' } as never] })] }));
    mockActive.api.workbenches.events.mockResolvedValue({ events: [], cursor: 0, oldestSeq: 0, hasOlder: false });
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByTestId('workbench-starting-line')).toBeTruthy();
    expect(screen.getByText('Starting the sandbox · Step 2 of 3 · Getting the code')).toBeVisible();
    expect(screen.queryByTestId('workbench-starting')).toBeNull();
  });

  it('shows the starting view for a session with no chat yet', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(starting({ chats: [] }));
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByTestId('workbench-starting')).toBeTruthy();
    expect(screen.queryByText('No conversation is available for this item.')).toBeNull();
    expect(screen.queryByText(/write your first message/)).toBeNull();
  });

  it('shows the conversation once the sandbox is ready', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session());
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByLabelText(/Agent said: Agent response 1/)).toBeVisible();
    expect(screen.queryByTestId('workbench-starting')).toBeNull();
    expect(screen.queryByTestId('workbench-starting-line')).toBeNull();
  });
});
