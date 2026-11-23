import { StrictMode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App';

const mocks = vi.hoisted(() => ({ authProvider: vi.fn(), analytics: vi.fn() }));
vi.mock('../components/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => {
    mocks.authProvider();
    return children;
  },
}));
vi.mock('../components/Analytics', () => ({ Analytics: mocks.analytics }));
vi.mock('../components/auth/LoginScreen', () => ({ LoginScreen: () => null }));
vi.mock('../components/layout/AppShell', () => ({ AppShell: () => null }));
vi.mock('../components/onboarding/OnboardingWizard', () => ({ OnboardingWizard: () => null }));
vi.mock('../components/ui/toaster', () => ({ Toaster: () => null }));
vi.mock('../hooks/useClosePopupAfterGithub', () => ({ useClosePopupAfterGithub: vi.fn() }));
vi.mock('../routes/AuthCallback', () => ({ AuthCallback: () => null }));

beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('shows the mobile callback without signing in and removes the query', () => {
  window.history.replaceState({}, '', '/callback?code=abc');
  const replaceState = vi.spyOn(window.history, 'replaceState');

  const { container } = render(<StrictMode><App /></StrictMode>);

  expect(screen.getByRole('heading', { name: 'Return to the Talyn app' })).toBeTruthy();
  expect(screen.getByText('This page finishes signing in to the Talyn mobile app. Open Talyn on your phone to continue. If you are on a computer, sign in to the web app instead.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open the Talyn web app' }).getAttribute('href')).toBe('/');
  expect(container.textContent).not.toContain('abc');
  expect(replaceState).toHaveBeenCalledWith(window.history.state, '', '/callback');
  expect(window.location.search).toBe('');
  expect(mocks.authProvider).not.toHaveBeenCalled();
  expect(mocks.analytics).not.toHaveBeenCalled();
});
