import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Analytics } from '../components/Analytics';
import { api } from '../lib/api';

const privacy = vi.hoisted(() => ({ optedOut: false }));
vi.mock('../components/auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user', email: 'user@example.test' } }), takePendingLogin: () => false,
}));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: object) => unknown) => selector({ currentWorkspaceId: 'ws', activePanel: 'settings' }),
}));
vi.mock('../lib/analytics', () => ({
  getAnalyticsOptOut: () => privacy.optedOut,
  identifyAnalyticsUser: vi.fn(), registerSuperProperties: vi.fn(), resetAnalyticsUser: vi.fn(), trackEvent: vi.fn(),
}));

beforeEach(() => { vi.useFakeTimers(); privacy.optedOut = false; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('sends opt-out from Settings and retries an explicit opt-in after a connection failure', async () => {
  const send = vi.spyOn(api.workspaces, 'recordRankingEvents').mockResolvedValue({ accepted: 0 });
  render(<Analytics />);
  expect(send).not.toHaveBeenCalled();
  privacy.optedOut = true;
  await act(async () => { window.dispatchEvent(new Event('talyn-analytics-preference-changed')); });
  expect(send).toHaveBeenLastCalledWith('ws', { enabled: false, resume: false, events: [] });
  send.mockRejectedValueOnce(new Error('offline'));
  privacy.optedOut = false;
  await act(async () => { window.dispatchEvent(new Event('talyn-analytics-preference-changed')); });
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(send).toHaveBeenCalledTimes(3);
  expect(send).toHaveBeenLastCalledWith('ws', { enabled: true, resume: true, events: [] });
});

it('applies the latest preference after an older request finishes', async () => {
  let settle!: (value: { accepted: number }) => void;
  const send = vi.spyOn(api.workspaces, 'recordRankingEvents')
    .mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }))
    .mockResolvedValue({ accepted: 0 });
  privacy.optedOut = true;
  render(<Analytics />);
  privacy.optedOut = false;
  await act(async () => { window.dispatchEvent(new Event('talyn-analytics-preference-changed')); });
  await act(async () => { settle({ accepted: 0 }); });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith('ws', { enabled: true, resume: true, events: [] });
});
