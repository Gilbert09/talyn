import { act, render, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';
import { AuthProvider } from '../renderer/components/auth/AuthProvider';
import { toast } from '../renderer/stores/toast';

const setToken = jest.fn();
const unsubscribe = jest.fn();
let onChange: (_event: string, session: Session | null) => void;

jest.mock('../renderer/lib/workbenchBridge', () => ({
  getWorkbenchBridge: () => ({ preview: { setToken: (...args: unknown[]) => setToken(...args) } }),
}));
jest.mock('../renderer/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: () => ({ auth: {
    getSession: async () => ({ data: { session: { access_token: 'initial-token' } } }),
    onAuthStateChange: (callback: typeof onChange) => {
      onChange = callback;
      return { data: { subscription: { unsubscribe } } };
    },
  } }),
}));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn() } }));

beforeEach(() => {
  jest.clearAllMocks();
  setToken.mockReset().mockResolvedValue(undefined);
});

it('pushes the initial token, refreshed token and sign-out to the main process', async () => {
  const { unmount } = render(<AuthProvider><div /></AuthProvider>);
  await waitFor(() => expect(setToken).toHaveBeenCalledWith('initial-token'));
  act(() => onChange('TOKEN_REFRESHED', { access_token: 'refreshed-token' } as Session));
  await waitFor(() => expect(setToken).toHaveBeenCalledWith('refreshed-token'));
  act(() => onChange('SIGNED_OUT', null));
  await waitFor(() => expect(setToken).toHaveBeenCalledWith(null));
  unmount();
  expect(unsubscribe).toHaveBeenCalled();
});

it('reports a token update failure without including token details', async () => {
  setToken.mockRejectedValue(new Error('IPC failed'));
  render(<AuthProvider><div /></AuthProvider>);
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not update preview access'));
});
