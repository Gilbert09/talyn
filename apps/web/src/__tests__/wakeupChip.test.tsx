import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../lib/api', () => ({ api: { workbenches: { cancelWakeup: vi.fn() } } }));
vi.mock('../stores/toast', () => ({ toast: { error: vi.fn() } }));

import { api } from '../lib/api';
import { useSessionBackgroundStore } from '../stores/sessionBackground';
import type { WorkbenchWakeup } from '@talyn/shared';
import { WakeupChips } from '../components/workbench/WakeupChips';

const wakeup: WorkbenchWakeup = {
  id: 'wake-1', workbenchId: 'wb-1', chatId: 'chat-1', wakeAt: '2026-11-08T10:12:00Z',
  reason: 'Check build status', status: 'scheduled', failureDetail: null, createdBy: 'user',
  sourceJobId: null, createdAt: '2026-11-08T10:00:00Z', firedAt: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T10:00:00Z'));
  useSessionBackgroundStore.getState().applyBackground({ workbenchId: 'wb-1', jobs: [], wakeups: [wakeup] });
  vi.mocked(api.workbenches.cancelWakeup).mockResolvedValue(wakeup);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('updates the countdown every 15 seconds', () => {
  render(<WakeupChips workbenchId="wb-1" chatId="chat-1" />);
  expect(screen.getByTestId('wakeup-chip')).toHaveTextContent('Wakes in 12 min');
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(screen.getByTestId('wakeup-chip')).toHaveTextContent('Wakes in 11 min');
});

it('cancels a wake-up in the current chat', () => {
  render(<WakeupChips workbenchId="wb-1" chatId="chat-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel wake-up: Check build status' }));
  expect(api.workbenches.cancelWakeup).toHaveBeenCalledWith('wb-1', 'wake-1');
});

it('draws nothing when the chat is absent', () => {
  const { container } = render(<WakeupChips workbenchId="wb-1" chatId={null} />);
  expect(container).toBeEmptyDOMElement();
});
