import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { pullRequestOutcomeEvent, type AgentEvent } from '@talyn/shared';
import { AgentBlocks } from '../components/workbench/AgentBlocks';
import { openExternal } from '../lib/openExternal';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/openExternal', () => ({ openExternal: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const at = (seq: number, event: Record<string, unknown>): AgentEvent => ({ seq, ...event }) as AgentEvent;
const reply = 'Done.\n\n```talyn-pr\n{"title":"feat: done","body":"Body","commitMessage":"feat: done","draft":false}\n```';
const replyEvent = at(1, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] } });
const url = 'https://github.com/acme/app/pull/12';

describe('the pull request card', () => {
  it('hides the PR block and draws no card before the PR exists', () => {
    render(<AgentBlocks events={[replyEvent]} />);
    expect(screen.getByText('Done.')).toBeInTheDocument();
    expect(screen.queryByText(/commitMessage/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('pull-request-card')).not.toBeInTheDocument();
  });

  it('shows the title, number and Open button once the PR opens', () => {
    render(<AgentBlocks events={[replyEvent, at(3, pullRequestOutcomeEvent({ ok: true, number: 12, url, existing: false }))]} />);
    const card = screen.getByTestId('pull-request-card');
    expect(card).toHaveTextContent('feat: done');
    expect(card).toHaveTextContent('#12 · Opened');
    fireEvent.click(screen.getByRole('button', { name: 'Open pull request #12' }));
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it('falls back to the number when the reply had no details', () => {
    render(<AgentBlocks events={[at(3, pullRequestOutcomeEvent({ ok: true, number: 12, url, existing: false }))]} />);
    expect(screen.getByTestId('pull-request-card')).toHaveTextContent('Pull request #12');
  });

  it('says when it linked a PR that was already open', () => {
    render(<AgentBlocks events={[at(3, pullRequestOutcomeEvent({ ok: true, number: 9, url, existing: true }))]} />);
    expect(screen.getByTestId('pull-request-card')).toHaveTextContent('#9 · Linked');
  });

  it('keeps the error as a row with no card', () => {
    render(<AgentBlocks events={[at(3, pullRequestOutcomeEvent({ ok: false, message: 'Could not push.' }))]} />);
    expect(screen.getByTestId('pull-request-outcome')).toHaveTextContent('Could not push.');
    expect(screen.queryByTestId('pull-request-card')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
