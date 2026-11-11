import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { SlackChannelPicker, type SlackChannelsState } from '../renderer/components/panels/workflows/slackFields';
import { startSlackInstall } from '../renderer/lib/slackInstall';

jest.mock('../renderer/lib/slackInstall', () => ({ startSlackInstall: jest.fn().mockResolvedValue(undefined) }));

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
});
afterEach(() => { cleanup(); jest.clearAllMocks(); });

const channels = [
  { id: 'C1', name: 'general', isPrivate: false },
  { id: 'C2', name: 'secret', isPrivate: true },
];

function renderPicker(state: SlackChannelsState, over: Partial<React.ComponentProps<typeof SlackChannelPicker>> = {}) {
  const onChange = jest.fn();
  const onRefresh = jest.fn();
  render(<SlackChannelPicker value={[]} onChange={onChange} state={state} onRefresh={onRefresh} hasTeam botName="talyn" {...over} />);
  return { onChange, onRefresh };
}

describe('SlackChannelPicker', () => {
  it('shows a spinner while loading', () => {
    renderPicker({ status: 'loading' });
    expect(screen.getByRole('status').textContent).toContain('Loading channels');
    expect(screen.queryByRole('button', { name: 'Add channels' })).toBeNull();
  });

  it('shows the error and retries', () => {
    const { onRefresh } = renderPicker({ status: 'error', message: 'boom' });
    expect(screen.getByRole('alert').textContent).toContain('Could not load channels. boom');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('asks for a reinstall when the scope is missing', () => {
    renderPicker({ status: 'ready', data: { channels: [], needsScope: 'channels:read' } });
    expect(screen.getByText('Reinstall Slack so Talyn can list channels')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reinstall Slack' }));
    expect(startSlackInstall).toHaveBeenCalled();
  });

  it('explains how to invite the bot when there are no channels', () => {
    const { onRefresh } = renderPicker({ status: 'ready', data: { channels: [] } });
    expect(screen.getByText(/Talyn isn't in any channels yet\. In Slack, open a channel and run \/invite @talyn, then refresh\./)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Refresh' })[0]!);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('asks for a Slack workspace first', () => {
    renderPicker({ status: 'loading' }, { hasTeam: false });
    expect(screen.getByText('Pick a Slack workspace first.')).toBeTruthy();
  });

  it('selects a channel from the search list and offers a refresh link', async () => {
    const { onChange, onRefresh } = renderPicker({ status: 'ready', data: { channels } });
    fireEvent.click(screen.getByRole('button', { name: 'Add channels' }));
    fireEvent.change(await screen.findByPlaceholderText('Search channels'), { target: { value: 'sec' } });
    expect(screen.queryByText('#general')).toBeNull();
    fireEvent.click(await screen.findByText('#secret'));
    expect(onChange).toHaveBeenCalledWith(['C2']);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('renders chips for selected channels and removes one', () => {
    const { onChange } = renderPicker({ status: 'ready', data: { channels } }, { value: ['C1', 'C2', 'C9'] });
    const chips = screen.getByRole('list', { name: 'Selected channels' });
    expect(chips.textContent).toContain('#general');
    expect(chips.textContent).toContain('#secret');
    expect(chips.textContent).toContain('(private)');
    expect(chips.textContent).toContain('C9');
    fireEvent.click(screen.getByRole('button', { name: 'Remove #secret' }));
    expect(onChange).toHaveBeenCalledWith(['C1', 'C9']);
  });
});
