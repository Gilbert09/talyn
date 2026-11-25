import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentEvent, Workbench, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import { api, type PRRow } from '../lib/api';
import { trackEvent } from '../lib/analytics';
import type { WorkbenchOps } from '../lib/workbenchOps';
import { CodeCompleteReviewCard } from '../components/workbench/CodeCompleteReviewCard';
import { WorkbenchTranscript } from '../components/workbench/WorkbenchTranscript';
import { usePullRequestStore } from '../stores/pullRequests';
import { useSessionBackgroundStore } from '../stores/sessionBackground';
import { useWorkbenchStore } from '../stores/workbenches';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));
vi.mock('../stores/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../lib/api', () => ({
  api: {
    pullRequests: {
      startCodeReview: vi.fn(),
      get: vi.fn(() => new Promise(() => {})),
    },
  },
}));

const startCodeReview = api.pullRequests.startCodeReview as unknown as ReturnType<typeof vi.fn>;

const WB = {
  id: 'wb1',
  workspaceId: 'ws1',
  repositoryId: 'r1',
  repoFullName: 'acme/app',
  name: 'lisbon',
  branch: 'lisbon',
  baseBranch: 'main',
  runtime: 'sandbox',
  agent: 'claude',
  deviceId: null,
  localPath: null,
  sandboxId: 'sb1',
  sandboxState: 'running',
  status: 'ready',
  pullRequestId: 'pr1',
  settings: {},
  diffStat: { added: 4, removed: 1, files: 1 },
  uncommittedStats: { added: 0, removed: 0, files: 0 },
  unpushedCommits: 0,
  archivedAt: null,
  createdAt: '2026-11-20T00:00:00Z',
  updatedAt: '2026-11-20T00:00:00Z',
} as Workbench;

const IDLE = { id: 'c1', workbenchId: 'wb1', status: 'idle', queuedMessages: [] } as unknown as WorkbenchChat;

const COUNTS = { blocker: 0, major: 0, minor: 0, nit: 0 };

function review(over: Record<string, unknown> = {}): NonNullable<PRRow['codeReview']> {
  return {
    id: 'rev1',
    preset: 'standard',
    phase: 'ready',
    phasePlan: [],
    runsDone: 0,
    runsTotal: 0,
    lensesRun: [],
    chunkTotal: 1,
    headSha: 'abc',
    headShaShort: 'abc',
    reviewedHeadSha: 'abc',
    staleForHead: false,
    counts: COUNTS,
    openCount: 0,
    dismissedCount: 0,
    funnel: { raised: 0, kept: 0, rejected: 0 },
    failureReason: null,
    deferredSince: null,
    fixTaskId: null,
    lastFix: null,
    startedAt: null,
    finishedAt: null,
    sessionReport: null,
    ...over,
  } as unknown as NonNullable<PRRow['codeReview']>;
}

function prRow(over: Partial<PRRow> = {}): PRRow {
  return {
    id: 'pr1',
    number: 42,
    state: 'open',
    mergeQueued: false,
    codeReview: null,
    summary: {
      title: 'Add a thing',
      url: 'https://github.com/acme/app/pull/42',
      baseBranch: 'main',
      headBranch: 'lisbon',
      draft: false,
      mergeable: 'MERGEABLE',
      ciStatus: 'passing',
    },
    ...over,
  } as PRRow;
}

/** A code-complete session; `over` changes one fact. */
function arrange(
  over: {
    pr?: Partial<PRRow>;
    workbench?: Partial<Workbench>;
    chats?: WorkbenchChat[];
    jobs?: number;
    scripts?: boolean;
  } = {},
) {
  usePullRequestStore.setState({ rows: [prRow(over.pr)] });
  useWorkbenchStore.setState({
    chats: { wb1: over.chats ?? [IDLE] },
    scriptOutput: over.scripts ? ({ wb1: { dev: { running: true } } } as never) : {},
  });
  useSessionBackgroundStore.setState({
    byWorkbench: over.jobs
      ? ({ wb1: { workbenchId: 'wb1', jobs: Array.from({ length: over.jobs }, (_, i) => ({ id: `j${i}`, status: 'running' })), wakeups: [] } } as never)
      : {},
  });
  return { ...WB, ...over.workbench } as Workbench;
}

const card = () => screen.queryByTestId('code-complete-review-card');

beforeEach(() => {
  useWorkbenchStore.setState({ prDetailId: null, prDetailTab: 'overview', outgoingMessages: {}, chatEvents: {} });
});

afterEach(() => {
  cleanup();
  usePullRequestStore.setState({ rows: [] });
  useWorkbenchStore.setState({ chats: {}, scriptOutput: {} });
  useSessionBackgroundStore.setState({ byWorkbench: {} });
  vi.clearAllMocks();
});

describe('CodeCompleteReviewCard states', () => {
  it.each([
    {
      name: 'no review',
      codeReview: null,
      state: 'none',
      texts: ['Ready for review', 'The work is pushed and the pull request is open.'],
      buttons: ['Run code review'],
    },
    {
      name: 'a review of an older commit',
      codeReview: review({ staleForHead: true, openCount: 2, counts: { ...COUNTS, major: 2 } }),
      state: 'none',
      texts: ['Ready for review'],
      buttons: ['Run code review'],
    },
    {
      name: 'a cancelled review',
      codeReview: review({ phase: 'cancelled' }),
      state: 'none',
      texts: ['Ready for review'],
      buttons: ['Run code review'],
    },
    {
      name: 'a running review',
      codeReview: review({ phase: 'reviewing', phasePlan: ['preparing', 'reviewing', 'validating'], runsDone: 1, runsTotal: 3 }),
      state: 'running',
      texts: ['Code review running'],
      buttons: [],
    },
    {
      name: 'a review that waits for a runner',
      codeReview: review({ phase: 'queued', deferredSince: '2026-11-20T00:00:00Z' }),
      state: 'waiting',
      texts: ['Code review is waiting for a runner'],
      buttons: [],
    },
    {
      name: 'a failed review',
      codeReview: review({ phase: 'failed', failureReason: 'The runner stopped.' }),
      state: 'failed',
      texts: ['The code review did not finish.', 'The runner stopped.'],
      buttons: ['Run again', 'View findings'],
    },
    {
      name: 'a done review with findings',
      codeReview: review({ openCount: 3, counts: { blocker: 1, major: 2, minor: 0, nit: 0 } }),
      state: 'done',
      texts: ['Code review done', '1 must fix', '2 should fix'],
      buttons: ['View findings'],
    },
    {
      name: 'a clean done review',
      codeReview: review({}),
      state: 'done',
      texts: ['Code review done', 'No open findings'],
      buttons: ['View findings'],
    },
  ])('shows $name', ({ codeReview, state, texts, buttons }) => {
    render(<CodeCompleteReviewCard workbench={arrange({ pr: { codeReview } })} />);
    expect(card()).toHaveAttribute('data-state', state);
    for (const text of texts) expect(card()).toHaveTextContent(text);
    for (const name of ['Run code review', 'Run again', 'View findings']) {
      if (buttons.includes(name)) expect(screen.getByRole('button', { name })).toBeInTheDocument();
      else expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByTestId('code-complete-review-sent')).not.toBeInTheDocument();
  });

  it.each([
    { name: 'this session', workbenchId: 'wb1' },
    { name: 'another session', workbenchId: 'wb2' },
  ])('shows a review done when $name fixed or dismissed each sent finding and pushed', ({ workbenchId }) => {
    const codeReview = review({
      staleForHead: true,
      openCount: 0,
      sessionReport: { workbenchId, sentAt: new Date().toISOString(), findingCount: 1 },
    });
    render(<CodeCompleteReviewCard workbench={arrange({ pr: { codeReview } })} />);
    expect(card()).toHaveAttribute('data-state', 'done');
    expect(card()).toHaveTextContent('Code review done');
    expect(card()).toHaveTextContent('No open findings. The session fixed or dismissed each finding.');
    expect(screen.getByTestId('code-complete-review-sent')).toHaveTextContent(/^Talyn sent 1 finding to/);
    expect(screen.getByRole('button', { name: 'Review again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View findings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run code review' })).not.toBeInTheDocument();
  });

  it('offers a new review when a sent finding is still open on an older commit', () => {
    const codeReview = review({
      staleForHead: true,
      openCount: 1,
      counts: { ...COUNTS, minor: 1 },
      sessionReport: { workbenchId: 'wb1', sentAt: new Date().toISOString(), findingCount: 1 },
    });
    render(<CodeCompleteReviewCard workbench={arrange({ pr: { codeReview } })} />);
    expect(card()).toHaveAttribute('data-state', 'none');
    expect(screen.getByRole('button', { name: 'Run code review' })).toBeInTheDocument();
  });

  it('shows no failure reason when the review has none', () => {
    render(<CodeCompleteReviewCard workbench={arrange({ pr: { codeReview: review({ phase: 'failed' }) } })} />);
    expect(card()).toHaveTextContent('The code review did not finish.');
    expect(screen.queryByTestId('code-complete-review-reason')).not.toBeInTheDocument();
  });

  it.each([
    { name: 'this session', workbenchId: 'wb1', text: /^Talyn sent 2 findings to this session/ },
    { name: 'another session', workbenchId: 'wb2', text: 'Talyn sent 2 findings to another session.' },
  ])('says the findings went to $name', ({ workbenchId, text }) => {
    const codeReview = review({
      openCount: 2,
      counts: { ...COUNTS, major: 2 },
      sessionReport: { workbenchId, sentAt: new Date().toISOString(), findingCount: 2 },
    });
    render(<CodeCompleteReviewCard workbench={arrange({ pr: { codeReview } })} />);
    expect(screen.getByTestId('code-complete-review-sent')).toHaveTextContent(text);
  });

  it.each([
    { name: 'failed', codeReview: review({ phase: 'failed' }) },
    { name: 'done', codeReview: review({ openCount: 1, counts: { ...COUNTS, blocker: 1 } }) },
  ])('View findings on a $name review opens the findings tab', ({ codeReview }) => {
    render(<CodeCompleteReviewCard workbench={arrange({ pr: { codeReview } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'View findings' }));
    expect(useWorkbenchStore.getState()).toMatchObject({ prDetailId: 'pr1', prDetailTab: 'findings' });
  });
});

describe('CodeCompleteReviewCard runs a review', () => {
  it.each([
    { name: 'Run code review', codeReview: null },
    { name: 'Run again', codeReview: review({ phase: 'failed' }) },
    {
      name: 'Review again',
      codeReview: review({
        staleForHead: true,
        openCount: 0,
        sessionReport: { workbenchId: 'wb1', sentAt: new Date().toISOString(), findingCount: 1 },
      }),
    },
  ])('$name starts a review and shows it running', async ({ name, codeReview }) => {
    let resolve: (value: unknown) => void = () => {};
    startCodeReview.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<CodeCompleteReviewCard workbench={arrange({ pr: { codeReview } })} />);
    const button = screen.getByRole('button', { name });
    fireEvent.click(button);
    expect(startCodeReview).toHaveBeenCalledWith('pr1');
    expect(button).toBeDisabled();
    await act(async () => resolve(review({ phase: 'preparing', phasePlan: ['preparing', 'reviewing'] })));
    await waitFor(() => expect(card()).toHaveAttribute('data-state', 'running'));
    expect(trackEvent).toHaveBeenCalledWith('code_review_started', { preset: 'standard', depth: 'standard' });
  });
});

describe('CodeCompleteReviewCard is hidden when the session is not code complete', () => {
  it.each([
    { name: 'a turn runs', over: { chats: [{ ...IDLE, status: 'running' } as WorkbenchChat] } },
    { name: 'a message is queued', over: { chats: [{ ...IDLE, queuedMessages: [{ id: 'q1' }] } as unknown as WorkbenchChat] } },
    { name: 'a chat failed', over: { chats: [{ ...IDLE, status: 'error' } as WorkbenchChat] } },
    { name: 'there is no chat', over: { chats: [] } },
    { name: 'the PR is closed', over: { pr: { state: 'closed' as const } } },
    { name: 'the PR is merged', over: { pr: { state: 'merged' as const } } },
    { name: 'there is no PR', over: { workbench: { pullRequestId: null } } },
    { name: 'a background job runs', over: { jobs: 1 } },
    { name: 'a session script runs', over: { scripts: true } },
    { name: 'files are uncommitted', over: { workbench: { uncommittedStats: { added: 3, removed: 0, files: 2 } } } },
    { name: 'commits are not pushed', over: { workbench: { unpushedCommits: 1 } } },
    { name: 'the session is archived', over: { workbench: { archivedAt: '2026-11-21T00:00:00Z' } } },
    { name: 'it is a thread', over: { workbench: { kind: 'thread' as const } } },
  ])('$name', ({ over }) => {
    render(<CodeCompleteReviewCard workbench={arrange(over as Parameters<typeof arrange>[0])} />);
    expect(card()).not.toBeInTheDocument();
  });

  it.each([
    { name: 'unknown uncommitted files', workbench: { uncommittedStats: undefined } },
    { name: 'unknown unpushed commits', workbench: { unpushedCommits: null } },
    { name: 'a local session', workbench: { runtime: 'local' as const, sandboxId: null } },
  ])('shows with $name', ({ workbench }) => {
    render(<CodeCompleteReviewCard workbench={arrange({ workbench })} />);
    expect(card()).toBeInTheDocument();
  });
});

describe('CodeCompleteReviewCard shows a review when the session is not code complete', () => {
  const notComplete = [
    { name: 'a session script runs', over: { scripts: true } },
    { name: 'a background job runs', over: { jobs: 1 } },
    { name: 'files are uncommitted', over: { workbench: { uncommittedStats: { added: 3, removed: 0, files: 2 } } } },
    { name: 'commits are not pushed', over: { workbench: { unpushedCommits: 1 } } },
    { name: 'a message is queued', over: { chats: [{ ...IDLE, queuedMessages: [{ id: 'q1' }] } as unknown as WorkbenchChat] } },
  ];
  const reviews = [
    { state: 'running', codeReview: review({ phase: 'reviewing', phasePlan: ['preparing', 'reviewing'], runsDone: 1, runsTotal: 3 }) },
    { state: 'waiting', codeReview: review({ phase: 'queued', deferredSince: '2026-11-20T00:00:00Z' }) },
    { state: 'failed', codeReview: review({ phase: 'failed' }) },
    { state: 'done', codeReview: review({ openCount: 1, counts: { ...COUNTS, major: 1 } }) },
    {
      state: 'done',
      codeReview: review({
        staleForHead: true,
        openCount: 0,
        sessionReport: { workbenchId: 'wb1', sentAt: new Date().toISOString(), findingCount: 1 },
      }),
    },
  ];

  it.each(notComplete.flatMap(({ name, over }) => reviews.map((r) => ({ name, over, ...r }))))(
    'shows a $state review when $name, with no start button',
    ({ over, state, codeReview }) => {
      const base = over as Parameters<typeof arrange>[0];
      render(<CodeCompleteReviewCard workbench={arrange({ ...base, pr: { codeReview } })} />);
      expect(card()).toHaveAttribute('data-state', state);
      for (const name of ['Run code review', 'Run again', 'Review again']) {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      }
    },
  );

  it.each([
    { name: 'a turn runs', over: { chats: [{ ...IDLE, status: 'running' } as WorkbenchChat] } },
    { name: 'the PR is closed', over: { pr: { state: 'closed' as const } } },
    { name: 'the session is archived', over: { workbench: { archivedAt: '2026-11-21T00:00:00Z' } } },
    { name: 'it is a thread', over: { workbench: { kind: 'thread' as const } } },
    { name: 'there is no chat', over: { chats: [] } },
  ])('hides a running review when $name', ({ over }) => {
    const base = over as Parameters<typeof arrange>[0];
    const codeReview = review({ phase: 'reviewing', phasePlan: ['preparing', 'reviewing'], runsDone: 1, runsTotal: 3 });
    render(<CodeCompleteReviewCard workbench={arrange({ ...base, pr: { ...base?.pr, codeReview } })} />);
    expect(card()).not.toBeInTheDocument();
  });
});

describe('the transcript shows the card after the last turn', () => {
  const ops = { unavailable: null } as unknown as WorkbenchOps;
  const events: WorkbenchEvent[] = [1, 2].map((n) => ({
    chatId: 'c1',
    seq: n,
    turn: n,
    event: { seq: n, type: 'user', message: { role: 'user', content: [{ type: 'text', text: `message ${n}` }] } } as AgentEvent,
  }));
  const transcript = (workbench: Workbench | undefined, chat: WorkbenchChat) => (
    <WorkbenchTranscript workbench={workbench} chat={chat} events={events} loading={false} error={null} ops={ops} />
  );

  it('puts the card below the last message', () => {
    render(transcript(arrange(), IDLE));
    const shown = card();
    expect(shown).toBeInTheDocument();
    expect(shown?.parentElement?.lastElementChild).toBe(shown);
    expect(screen.getByText('message 2').compareDocumentPosition(shown as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    { name: 'the shown chat runs', chat: { ...IDLE, status: 'running' } as WorkbenchChat, workbench: true },
    { name: 'the transcript has no session', chat: IDLE, workbench: false },
  ])('has no card when $name', ({ chat, workbench }) => {
    const wb = arrange();
    render(transcript(workbench ? wb : undefined, chat));
    expect(card()).not.toBeInTheDocument();
  });
});
