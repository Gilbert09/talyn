import { pullRequestOutcomeEvent, type Workbench, type WorkbenchChat, type WorkbenchEvent } from '@talyn/shared';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  installWorkbenchNotifications,
  notificationSummary,
  notificationText,
  openFromNotification,
  toastPullRequestFailures,
} from '../lib/workbenchNotify';
import { setWorkbenchNavigator } from '../lib/workbenchNavigation';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';
import { toast } from '../stores/toast';

type Status = WorkbenchChat['status'];

function event(turn: number, value: Record<string, unknown>, seq = turn): WorkbenchEvent {
  return { chatId: 'chat1', turn, seq, event: { seq, ...value } as WorkbenchEvent['event'] };
}

function assistant(text: string): Record<string, unknown> {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

describe('notification text', () => {
  it.each<[Status, string, string]>([
    ['idle', 'Done: Fix session settings', 'The agent finished.'],
    ['awaiting_input', 'Needs your reply: Fix session settings', 'The agent is waiting for your answer.'],
    ['error', 'Failed: Fix session settings', 'The agent stopped with an error.'],
  ])('uses the session name and %s status', (status, title, body) => {
    expect(notificationText({ status }, { name: 'internal-branch', title: 'Fix session settings' })).toEqual({ title, body });
  });

  it.each([
    [{ name: 'internal-branch' }, 'Done: internal-branch'],
    [undefined, 'Done: Session'],
  ] as const)('uses the available session name', (workbench, title) => {
    expect(notificationText({ status: 'idle' }, workbench).title).toBe(title);
  });

  it('trims a long title to 80 characters', () => {
    const title = notificationText({ status: 'idle' }, { name: 'x'.repeat(100) }).title;
    expect(title).toHaveLength(80);
    expect(title).toMatch(/…$/);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['opened', pullRequestOutcomeEvent({ ok: true, number: 42, url: 'u', existing: false }), 'Opened PR #42'],
    ['adopted', pullRequestOutcomeEvent({ ok: true, number: 7, url: 'u', existing: true, adopted: true }), 'Linked PR #7'],
  ])('reports a %s pull request', (_name, pr, expected) => {
    expect(notificationSummary({ status: 'idle' }, [event(1, assistant('Other work finished.')), event(1, pr, 2)])).toBe(expected);
  });

  it('uses the last AskUserQuestion input', () => {
    const question = event(2, {
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Which database should I use?' }] } },
      ] },
    });
    expect(notificationSummary({ status: 'awaiting_input' }, [event(1, assistant('Earlier answer.')), question]))
      .toBe('Which database should I use?');
  });

  it.each<[string, WorkbenchEvent[], string]>([
    ['assistant text', [event(1, assistant('I need the database name.'))], 'I need the database name.'],
    ['no events', [], 'The agent is waiting for your answer.'],
  ])('uses %s when the question is absent', (_name, events, expected) => {
    expect(notificationText({ status: 'awaiting_input' }, { name: 'Session' }, events).body).toBe(expected);
  });

  it.each<[string, WorkbenchEvent[], string | null, string]>([
    ['result', [event(1, { type: 'result', is_error: true, result: 'The build failed.' })], null, 'The build failed.'],
    ['errors', [event(1, { type: 'result', is_error: true, errors: ['Could not connect.'] })], null, 'Could not connect.'],
    ['chat error', [], 'The sandbox stopped.', 'The sandbox stopped.'],
    ['fallback', [], null, 'The agent stopped with an error.'],
    ['blank error', [], '', 'The agent stopped with an error.'],
  ])('uses the %s error', (_name, events, error, expected) => {
    expect(notificationText({ status: 'error', error }, { name: 'Session' }, events).body).toBe(expected);
  });

  it.each<[string, string, string]>([
    ['Markdown', '## **Updated** [login](https://example.com) with `OAuth`\n- Added tests', 'Updated login with OAuth Added tests'],
    ['sentence', 'Updated the login flow. Tests now pass.', 'Updated the login flow.'],
    ['short sentence', 'Done. Updated the login flow.', 'Done. Updated the login flow.'],
  ])('cleans %s assistant text', (_name, input, expected) => {
    expect(notificationSummary({ status: 'idle' }, [event(1, assistant(input))])).toBe(expected);
  });

  it('trims a long summary to 140 characters', () => {
    const body = notificationSummary({ status: 'idle' }, [event(1, assistant('x'.repeat(180)))]);
    expect(body).toHaveLength(140);
    expect(body).toMatch(/…$/);
  });

  it('ignores a pull request from an earlier turn and nested assistant text', () => {
    const events = [
      event(1, pullRequestOutcomeEvent({ ok: true, number: 10, url: 'u', existing: false })),
      event(2, { ...assistant('Nested task finished.'), parent_tool_use_id: 'tool1' }, 2),
      event(2, assistant('Updated the settings page.'), 3),
    ];
    expect(notificationSummary({ status: 'idle' }, events)).toBe('Updated the settings page.');
  });

  it('reads the current chat events when the notification fires', () => {
    const initial = useWorkbenchStore.getState();
    const originalNotification = globalThis.Notification;
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const shown = vi.fn();
    const MockNotification = vi.fn().mockImplementation((_title: string, options: NotificationOptions) => {
      shown(options.body);
      return { onclick: null };
    });
    Object.defineProperty(MockNotification, 'permission', { value: 'granted' });
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: MockNotification });
    try {
      useWorkbenchStore.setState({
        ...initial,
        workbenches: { wb1: { id: 'wb1', name: 'internal-branch', title: 'Fix settings' } as Workbench },
        chats: { wb1: [{ id: 'chat1', workbenchId: 'wb1', status: 'running' } as WorkbenchChat] },
        chatEvents: { chat1: { events: [event(1, assistant('Updated the settings page.'))], loaded: true, loading: false, error: null, hasOlder: false, oldestSeq: 1, loadingOlder: false, olderError: null } },
      }, true);
      const uninstall = installWorkbenchNotifications();
      try {
        useWorkbenchStore.getState().upsertChat({ id: 'chat1', workbenchId: 'wb1', status: 'idle' } as WorkbenchChat);
        expect(MockNotification).toHaveBeenCalledWith('Done: Fix settings', expect.objectContaining({ body: 'Updated the settings page.' }));
        expect(shown).toHaveBeenCalledWith('Updated the settings page.');
      } finally {
        uninstall();
      }
    } finally {
      useWorkbenchStore.setState(initial, true);
      Object.defineProperty(globalThis, 'Notification', { configurable: true, value: originalNotification });
      hasFocus.mockRestore();
    }
  });
});

describe('openFromNotification', () => {
  afterEach(() => {
    setWorkbenchNavigator(null);
    vi.restoreAllMocks();
  });

  it('focuses the tab, opens the session through the installed navigator and marks the chat read', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const navigate = vi.fn();
    setWorkbenchNavigator(navigate);
    useWorkbenchStore.setState({ unread: { chat1: true } });
    openFromNotification({ id: 'chat1', workbenchId: 'wb1' });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('wb1');
    expect(useWorkbenchStore.getState().selectedChatByWorkbench.wb1).toBe('chat1');
    expect(useWorkbenchStore.getState().unread.chat1).toBeUndefined();
  });

  it('without a navigator, selects the session and shows the sessions panel', () => {
    vi.spyOn(window, 'focus').mockImplementation(() => {});
    openFromNotification({ id: 'chat2', workbenchId: 'wb2' });
    expect(useWorkbenchStore.getState().selectedWorkbenchId).toBe('wb2');
    expect(useWorkspaceStore.getState().activePanel).toBe('workbenches');
  });

  it('still opens the session when focus throws', () => {
    vi.spyOn(window, 'focus').mockImplementation(() => {
      throw new Error('blocked');
    });
    const navigate = vi.fn();
    setWorkbenchNavigator(navigate);
    openFromNotification({ id: 'chat3', workbenchId: 'wb3' });
    expect(navigate).toHaveBeenCalledWith('wb3');
  });
});

describe('toastPullRequestFailures', () => {
  afterEach(() => vi.restoreAllMocks());

  function seed(runtime: Workbench['runtime']) {
    useWorkbenchStore.setState({
      workbenches: { wb1: { id: 'wb1', runtime } as Workbench },
      chats: { wb1: [{ id: 'chat1', workbenchId: 'wb1', status: 'idle' } as WorkbenchChat] },
    });
  }
  const failed = event(1, { type: 'talyn_pr', ok: false, message: 'No commits' });
  const opened = event(1, pullRequestOutcomeEvent({ ok: true, number: 4, url: 'u', existing: false }), 2);

  it.each<[string, Workbench['runtime'], WorkbenchEvent[], number]>([
    ['a failed sandbox PR', 'sandbox', [failed], 1],
    ['an opened PR', 'sandbox', [opened], 0],
    ['a failed local PR', 'local', [failed], 0],
  ])('%s → %i toasts', (_n, runtime, events, count) => {
    const error = vi.spyOn(toast, 'error').mockReturnValue('t');
    seed(runtime);
    toastPullRequestFailures('chat1', events);
    expect(error).toHaveBeenCalledTimes(count);
    if (count) expect(error).toHaveBeenCalledWith('Could not open the pull request', 'No commits');
  });
});
