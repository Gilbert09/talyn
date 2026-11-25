import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  codeReviewTranscriptEvent,
  type AgentEvent,
  type CodeReviewTranscriptEvent,
  type CodeReviewTranscriptFinding,
  type Workbench,
} from '@talyn/shared';
import type { PRRow } from '../renderer/lib/api';
import { AgentBlocks } from '../renderer/components/terminal/AgentConversation';
import { CodeReviewTranscriptCard } from '../renderer/components/workbench/CodeReviewTranscriptCard';
import { usePullRequestStore } from '../renderer/stores/pullRequests';
import { useWorkbenchStore } from '../renderer/stores/workbenches';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

const base = { reviewId: 'rev1', pullRequestId: 'pr1', prNumber: 12, cycle: 1, headSha: 'abcdef1234567' };

const started: CodeReviewTranscriptEvent = { ...base, action: 'started', fileCount: 3, reviewerCount: 2 };
const clean: CodeReviewTranscriptEvent = { ...base, action: 'finished', findingCount: 0, findings: [], sentToAgent: false };
const failed: CodeReviewTranscriptEvent = { ...base, action: 'failed', message: 'The runner stopped.' };

function finding(id: string, severity: CodeReviewTranscriptFinding['severity'], over: Partial<CodeReviewTranscriptFinding> = {}): CodeReviewTranscriptFinding {
  return {
    id,
    severity,
    title: `Title ${id}`,
    summary: `Summary ${id}.`,
    filePath: `src/${id}.ts`,
    lineStart: 12,
    lineEnd: 14,
    ...over,
  };
}

function finished(findings: CodeReviewTranscriptFinding[], findingCount = findings.length): CodeReviewTranscriptEvent {
  return { ...base, action: 'finished', findingCount, findings, sentToAgent: true };
}

const initialWorkbenches = useWorkbenchStore.getState();
const initialPrs = usePullRequestStore.getState();

beforeEach(() => {
  useWorkbenchStore.setState({ ...initialWorkbenches, workbenches: {}, prDetailId: null, prDetailTab: 'overview' }, true);
  usePullRequestStore.setState({ ...initialPrs, rows: [] }, true);
});

afterEach(cleanup);

const card = () => screen.getByTestId('code-review-card');
const rowSeverities = () => within(screen.getByTestId('code-review-card-findings')).getAllByRole('listitem').map((li) => li.getAttribute('data-severity'));

function knowSessionPr() {
  useWorkbenchStore.setState({ workbenches: { wb1: { id: 'wb1', pullRequestId: 'pr1' } as Workbench } });
}

describe('CodeReviewTranscriptCard', () => {
  it.each([
    ['started', started, 'Code review started', '3 changed files · 2 reviewers at abcdef1'],
    ['finished with no findings', clean, 'Code review finished with no findings', 'Reviewed at abcdef1.'],
    ['failed', failed, 'Code review failed', 'The runner stopped.'],
    ['stopped', { ...base, action: 'cancelled' } as CodeReviewTranscriptEvent, 'Code review stopped', 'Stopped before it finished at abcdef1.'],
  ])('shows the title and detail when %s', (_n, event, title, detail) => {
    render(<CodeReviewTranscriptCard event={event} />);
    expect(card()).toHaveTextContent(title);
    expect(card()).toHaveTextContent(detail);
    expect(card()).toHaveTextContent('#12');
    expect(screen.queryByTestId('code-review-card-findings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('code-review-severity-counts')).not.toBeInTheDocument();
  });

  it('marks a failed review as an error', () => {
    render(<CodeReviewTranscriptCard event={failed} />);
    expect(card()).toHaveClass('border-destructive/40');
    expect(card()).toHaveAttribute('data-action', 'failed');
  });

  it('does not mark a stopped review as an error', () => {
    render(<CodeReviewTranscriptCard event={{ ...base, action: 'cancelled' }} />);
    expect(card()).not.toHaveClass('border-destructive/40');
    expect(card()).toHaveAttribute('data-action', 'cancelled');
  });

  it('leaves out the number when Talyn did not know it', () => {
    render(<CodeReviewTranscriptCard event={{ ...started, prNumber: null }} />);
    expect(card()).not.toHaveTextContent('#');
  });

  it('lists the findings most serious first, with pills, counts and locations', () => {
    render(
      <CodeReviewTranscriptCard
        event={finished([
          finding('a', 'nit'),
          finding('b', 'blocker'),
          finding('c', 'minor', { filePath: null }),
          finding('d', 'major', { lineEnd: 12 }),
        ])}
      />
    );
    expect(card()).toHaveTextContent('Code review finished with 4 findings');
    expect(card()).toHaveTextContent('Reviewed at abcdef1. Talyn sent the findings to the agent.');
    expect(rowSeverities()).toEqual(['blocker', 'major', 'minor', 'nit']);
    expect(screen.getByTestId('code-review-severity-counts')).toHaveTextContent('1 must fix');
    const rows = within(screen.getByTestId('code-review-card-findings')).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Must fix');
    expect(rows[0]).toHaveTextContent('Title b');
    expect(within(rows[0]).getByTitle('src/b.ts:12-14')).toHaveTextContent('src/b.ts:12-14');
    expect(within(rows[1]).getByTitle('src/d.ts:12')).toBeInTheDocument();
    expect(rows[2]).not.toHaveTextContent('src/');
    expect(rows[3]).toHaveTextContent('Nitpick');
  });

  it('clamps a summary until the row is clicked', () => {
    render(<CodeReviewTranscriptCard event={finished([finding('a', 'major')])} />);
    const row = screen.getByRole('button', { name: /Title a/ });
    const summary = screen.getByTestId('code-review-card-summary');
    expect(summary).toHaveClass('line-clamp-2');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(summary).not.toHaveClass('line-clamp-2');
    fireEvent.click(row);
    expect(summary).toHaveClass('line-clamp-2');
  });

  it('leaves out an empty summary', () => {
    render(<CodeReviewTranscriptCard event={finished([finding('a', 'major', { summary: '' })])} />);
    expect(screen.queryByTestId('code-review-card-summary')).not.toBeInTheDocument();
  });

  it.each([
    [5, false],
    [6, true],
  ])('with %i findings, shows "Show more": %s', (count, toggles) => {
    const findings = Array.from({ length: count }, (_, i) => finding(`f${i}`, 'minor'));
    render(<CodeReviewTranscriptCard event={finished(findings)} />);
    expect(rowSeverities()).toHaveLength(5);
    expect(screen.queryByRole('button', { name: /^Show \d+ more$/ }) !== null).toBe(toggles);
  });

  it('shows the rest of the findings on "Show N more" and hides them again', () => {
    const findings = Array.from({ length: 8 }, (_, i) => finding(`f${i}`, 'minor'));
    render(<CodeReviewTranscriptCard event={finished(findings)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more' }));
    expect(rowSeverities()).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(rowSeverities()).toHaveLength(5);
  });

  it.each([
    [2, 2, null],
    [2, 7, '5 more in the findings list'],
  ])('with %i findings in the card and %i in all, says %s', (inCard, total, note) => {
    const findings = Array.from({ length: inCard }, (_, i) => finding(`f${i}`, 'major'));
    render(<CodeReviewTranscriptCard event={finished(findings, total)} />);
    expect(card()).toHaveTextContent(`Code review finished with ${total} findings`);
    if (note) expect(card()).toHaveTextContent(note);
    else expect(card()).not.toHaveTextContent('in the findings list');
  });

  it.each([
    ['started', started, 'Details', 'Open the code review of pull request #12'],
    ['finished with no findings', clean, 'Details', 'Open the code review of pull request #12'],
    ['finished with findings', finished([finding('a', 'major')]), 'View findings', 'View the findings of pull request #12'],
    ['failed', failed, 'Details', 'Open the code review of pull request #12'],
  ])('opens the findings tab when %s and the session knows the PR', (_n, event, text, name) => {
    knowSessionPr();
    render(<CodeReviewTranscriptCard event={event} />);
    const button = screen.getByRole('button', { name });
    expect(button).toHaveTextContent(text);
    fireEvent.click(button);
    expect(useWorkbenchStore.getState().prDetailId).toBe('pr1');
    expect(useWorkbenchStore.getState().prDetailTab).toBe('findings');
  });

  it('opens the findings tab when the PR list knows the PR', () => {
    usePullRequestStore.setState({ rows: [{ id: 'pr1', number: 12, repo: 'acme/app' } as PRRow] });
    render(<CodeReviewTranscriptCard event={started} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the code review of pull request #12' }));
    expect(useWorkbenchStore.getState().prDetailId).toBe('pr1');
  });

  it.each([
    ['nothing knows the PR', () => {}],
    ['another session has another PR', () => useWorkbenchStore.setState({ workbenches: { wb2: { id: 'wb2', pullRequestId: 'pr2' } as Workbench } })],
    ['the PR list has another PR', () => usePullRequestStore.setState({ rows: [{ id: 'pr2', number: 13 } as PRRow] })],
  ])('draws no button when %s', (_n, setup) => {
    setup();
    render(<CodeReviewTranscriptCard event={finished([finding('a', 'major')])} />);
    expect(screen.queryByRole('button', { name: /findings of|code review of/ })).not.toBeInTheDocument();
  });

  it('uses "the pull request" in the button label when the number is unknown', () => {
    knowSessionPr();
    render(<CodeReviewTranscriptCard event={{ ...started, prNumber: null }} />);
    expect(screen.getByRole('button', { name: 'Open the code review of the pull request' })).toBeInTheDocument();
  });
});

describe('the code review card in a transcript', () => {
  const at = (seq: number, event: Record<string, unknown>): AgentEvent => ({ seq, ...event }) as AgentEvent;

  it.each([
    ['started', started, 'Code review started'],
    ['finished', finished([finding('a', 'blocker')]), 'Code review finished with 1 finding'],
    ['failed', failed, 'Code review failed'],
  ])('draws a %s event as a card', (_n, event, title) => {
    render(<AgentBlocks events={[at(1, codeReviewTranscriptEvent(event))]} />);
    expect(card()).toHaveTextContent(title);
  });

  it('draws nothing for a malformed event', () => {
    render(<AgentBlocks events={[at(1, { type: 'talyn_code_review', action: 'started' })]} />);
    expect(screen.queryByTestId('code-review-card')).not.toBeInTheDocument();
  });
});
