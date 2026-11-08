import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Features } from '@talyn/shared';
import { SettingsShell } from '../renderer/components/settings/SettingsShell';
import { useWorkspaceStore } from '../renderer/stores/workspace';

jest.mock('../renderer/components/settings/MemorySection', () => ({
  MemorySection: () => <div>Memory section</div>,
}));

afterEach(cleanup);

it('shows Memory after Instructions and opens the Memory page', () => {
  useWorkspaceStore.setState({ features: { workbenches: true } as Features, settingsSection: 'instructions' });
  render(<SettingsShell />);
  const nav = screen.getByRole('navigation');
  const labels = within(nav).getAllByRole('button').map((button) => button.textContent);
  expect(labels.indexOf('Memory')).toBe(labels.indexOf('Instructions') + 1);
  expect(screen.queryByText('Memory section')).toBeNull();
  fireEvent.click(within(nav).getByRole('button', { name: 'Memory' }));
  expect(screen.getByRole('heading', { name: 'Memory' })).toBeInTheDocument();
  expect(screen.getByText('Notes that sessions save as they learn, and notes you add. Every session, task and review reads them.')).toBeInTheDocument();
  expect(screen.getByText('Memory section')).toBeInTheDocument();
});

it('hides Memory when sessions are not offered', () => {
  useWorkspaceStore.setState({ features: { workbenches: false } as Features, settingsSection: 'instructions' });
  render(<SettingsShell />);
  expect(within(screen.getByRole('navigation')).queryByRole('button', { name: 'Memory' })).toBeNull();
});

it('finds every settings section that matches a search term', () => {
  useWorkspaceStore.setState({
    features: { publicApi: true, workbenches: true } as Features,
    settingsSection: 'appearance',
  });
  render(<SettingsShell />);
  const nav = screen.getByRole('navigation', { name: 'Settings sections' });

  fireEvent.change(within(nav).getByRole('searchbox', { name: 'Search settings' }), {
    target: { value: 'notifications' },
  });

  expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual([
    'Sessions',
    'Pull requests',
  ]);
});

it('shows an empty result and clears search with Escape', () => {
  useWorkspaceStore.setState({ features: {} as Features, settingsSection: 'appearance' });
  render(<SettingsShell />);
  const nav = screen.getByRole('navigation', { name: 'Settings sections' });
  const search = within(nav).getByRole('searchbox', { name: 'Search settings' });

  fireEvent.change(search, { target: { value: 'not-a-setting' } });
  expect(within(nav).getByRole('status')).toHaveTextContent('No settings found.');
  fireEvent.keyDown(search, { key: 'Escape' });
  expect(within(nav).getByRole('button', { name: 'Appearance' })).toBeInTheDocument();
});
