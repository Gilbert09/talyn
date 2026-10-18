import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { pullRequestOutcomeEvent, type AgentEvent, type Workbench, type WorkbenchChat, type WorkbenchEvent } from '@talyn/shared';
import { AgentBlocks } from '../renderer/components/terminal/AgentConversation';
import { toastPullRequestFailures } from '../renderer/lib/workbenchNotify';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { toast } from '../renderer/stores/toast';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

/** The `talyn_pr` event a Create PR turn ends with, in the thread and as a toast. */

const at = (seq: number, event: Record<string, unknown>): AgentEvent => ({ seq, ...event }) as AgentEvent;

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('the Create PR outcome in the transcript', () => {
  it('links the PR it opened', () => {
    render(
      <AgentBlocks
        events={[at(3, pullRequestOutcomeEvent({ ok: true, number: 12, url: 'https://github.com/acme/app/pull/12', existing: false }))]}
      />
    );
    const link = screen.getByRole('link', { name: 'Opened pull request #12' });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/app/pull/12');
    expect(screen.getByTestId('pull-request-outcome')).not.toHaveClass('text-destructive');
  });

  it('says when it linked a PR that was already open', () => {
    render(<AgentBlocks events={[at(3, pullRequestOutcomeEvent({ ok: true, number: 9, url: 'u', existing: true }))]} />);
    expect(screen.getByRole('link', { name: 'Linked the open pull request #9' })).toBeInTheDocument();
  });

  it('shows the error, with no link', () => {
    const message = 'GitHub refused the push. The Talyn GitHub App needs Contents: Read & write on acme/app.';
    render(<AgentBlocks events={[at(3, pullRequestOutcomeEvent({ ok: false, message }))]} />);
    expect(screen.getByTestId('pull-request-outcome')).toHaveTextContent(message);
    expect(screen.getByTestId('pull-request-outcome')).toHaveClass('text-destructive');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('toastPullRequestFailures', () => {
  const initial = useWorkbenchStore.getState();

  function withChat(runtime: Workbench['runtime']) {
    useWorkbenchStore.setState(initial, true);
    const store = useWorkbenchStore.getState();
    store.upsertWorkbench({ id: 'wb1', workspaceId: 'ws1', runtime } as Workbench);
    store.upsertChat({ id: 'c1', workbenchId: 'wb1', status: 'idle', queuedMessages: [] } as unknown as WorkbenchChat);
  }

  const events = (...items: Array<Record<string, unknown>>): WorkbenchEvent[] =>
    items.map((event, i) => ({ chatId: 'c1', seq: i + 1, turn: 1, event: at(i + 1, event) }));

  it.each<[string, Workbench['runtime'], WorkbenchEvent[], boolean]>([
    ['a sandbox failure', 'sandbox', events(pullRequestOutcomeEvent({ ok: false, message: 'Could not push the branch.' })), true],
    ['a sandbox success', 'sandbox', events(pullRequestOutcomeEvent({ ok: true, number: 1, url: 'u', existing: false })), false],
    ['a local failure (its controller toasts)', 'local', events(pullRequestOutcomeEvent({ ok: false, message: 'x' })), false],
    ['other events', 'sandbox', events({ type: 'assistant' }), false],
  ])('%s', (_name, runtime, list, toasts) => {
    withChat(runtime);
    toastPullRequestFailures('c1', list);
    if (toasts) expect(toast.error).toHaveBeenCalledWith('Could not open the pull request', 'Could not push the branch.');
    else expect(toast.error).not.toHaveBeenCalled();
  });

  it('ignores a chat it does not know', () => {
    withChat('sandbox');
    toastPullRequestFailures('other', events(pullRequestOutcomeEvent({ ok: false, message: 'x' })));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
