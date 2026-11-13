import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentEvent, WorkbenchMessageTrigger } from '@talyn/shared';
import { AgentBlocks } from '../components/workbench/AgentBlocks';
import { TriggerRow } from '../components/workbench/TriggerRow';

const wakeup: WorkbenchMessageTrigger = { kind: 'wakeup', wakeupId: 'w1', reason: 'Check the build', createdBy: 'user' };
const jobExit: WorkbenchMessageTrigger = { kind: 'job_exit', wakeupId: 'w2', reason: 'Finished', jobId: 'j1', jobName: 'build', exitCode: 3 };
const prRetry: WorkbenchMessageTrigger = { kind: 'pr_retry', attempt: 1, error: 'GitHub rejected the push: fetch first' };
const event = (text: string, trigger?: WorkbenchMessageTrigger): AgentEvent => ({
  seq: 1,
  type: 'user',
  talyn: { origin: 'talyn', ...(trigger ? { trigger } : {}) },
  message: { role: 'user', content: [{ type: 'text', text }] },
} as unknown as AgentEvent);

afterEach(cleanup);

describe('TriggerRow', () => {
  it('shows wake-up text without an output toggle', () => {
    render(<TriggerRow trigger={wakeup} text="Wake now" />);
    expect(screen.getByText('Woke up: Check the build')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows a job exit and expands its output', () => {
    render(<TriggerRow trigger={jobExit} text="last log line" />);
    expect(screen.getByText('Background job build exited with code 3')).toBeInTheDocument();
    expect(screen.queryByText('last log line')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show output' }));
    expect(screen.getByText('last log line')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide output' }));
    expect(screen.queryByText('last log line')).not.toBeInTheDocument();
  });

  it('shows a pull request retry and expands its error, not the message body', () => {
    render(<TriggerRow trigger={prRetry} text="Talyn could not open the pull request: long body" />);
    expect(screen.getByText('Talyn could not open the pull request. The agent tries to fix the cause.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show error' }));
    expect(screen.getByText('GitHub rejected the push: fetch first')).toBeInTheDocument();
    expect(screen.queryByText(/long body/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide error' }));
    expect(screen.queryByText('GitHub rejected the push: fetch first')).not.toBeInTheDocument();
  });

  it('uses the trigger row for history with a trigger', () => {
    render(<AgentBlocks events={[event('Wake now', wakeup)]} />);
    expect(screen.getByText('Woke up: Check the build')).toBeInTheDocument();
    expect(screen.queryByTestId('talyn-message')).not.toBeInTheDocument();
  });

  it('keeps the old card for Talyn messages without a trigger', () => {
    render(<AgentBlocks events={[event('Session finished')]} />);
    expect(screen.getByTestId('talyn-message')).toHaveTextContent('Session finished');
  });
});
