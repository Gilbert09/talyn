import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Features } from '@talyn/shared';
import { SettingsPanel } from '../components/panels/SettingsPanel';
import { useWorkspaceStore } from '../stores/workspace';

vi.mock('../components/settings/MemorySection', () => ({
  MemorySection: () => <div>Memory section</div>,
}));

afterEach(cleanup);

it('shows Memory after Instructions and opens the Memory page', () => {
  useWorkspaceStore.setState({ features: { workbenches: true } as Features, settingsSection: 'instructions' });
  render(<SettingsPanel />);
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
  render(<SettingsPanel />);
  expect(within(screen.getByRole('navigation')).queryByRole('button', { name: 'Memory' })).toBeNull();
});
