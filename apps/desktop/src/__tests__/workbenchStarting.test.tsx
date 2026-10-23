/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { isStarting, StartingHint } from '../renderer/components/workbench/WorkbenchStarting';


const wb = (over: Partial<Workbench> = {}) =>
  ({ id: 'wb1', runtime: 'sandbox', status: 'provisioning', sandboxState: 'creating', statusMessage: null, ...over }) as Workbench;

describe('isStarting', () => {
  it.each<[string, Partial<Workbench>, boolean]>([
    ['provisioning', { status: 'provisioning', sandboxState: 'creating' }, true],
    ['ready but the box is still creating', { status: 'ready', sandboxState: 'creating' }, true],
    ['ready', { status: 'ready', sandboxState: 'running' }, false],
    ['lost', { status: 'provisioning', sandboxState: 'lost' }, true],
    ['failed while the box says creating', { status: 'error', sandboxState: 'creating' }, false],
    ['provisioning with a failed box', { status: 'provisioning', sandboxState: 'error' }, false],
  ])('%s → %s', (_name, over, expected) => {
    expect(isStarting(wb(over))).toBe(expected);
  });
});

describe('StartingHint', () => {
  it('says what the sandbox is doing', () => {
    render(<StartingHint workbench={wb({ statusMessage: 'Cloning the repository' })} queued={0} />);
    expect(screen.getByText('Starting the sandbox')).toBeInTheDocument();
    expect(screen.getByText('Cloning the repository')).toBeInTheDocument();
    expect(screen.getByText(/write your first message now/)).toBeInTheDocument();
  });

  it.each<[number, RegExp]>([
    [1, /^Your message is queued\. It is sent when the sandbox is ready\.$/],
    [3, /^3 messages are queued\. They are sent in order when the sandbox is ready\.$/],
  ])('names %i queued message(s)', (queued, text) => {
    render(<StartingHint workbench={wb()} queued={queued} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('talks about the worktree for a local session', () => {
    render(<StartingHint workbench={wb({ runtime: 'local' })} queued={1} />);
    expect(screen.getByText('Creating the worktree')).toBeInTheDocument();
    expect(screen.getByText(/when the worktree is ready/)).toBeInTheDocument();
  });

  it('shows the recovery message', () => {
    render(<StartingHint workbench={wb({ status: 'provisioning', sandboxState: 'lost', statusMessage: 'The sandbox was lost. Talyn is starting a new one.' })} queued={0} />);
    expect(screen.getByText('Starting a new sandbox')).toBeInTheDocument();
    expect(screen.getByText('The sandbox was lost. Talyn is starting a new one.')).toBeInTheDocument();
  });
});
