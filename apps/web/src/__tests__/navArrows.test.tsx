import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HistoryButtons } from '../components/layout/AppSidebar';
import { buildAppShortcuts } from '../components/layout/appShortcuts';
import { clearShortcuts, dispatchKeydown, registerShortcuts } from '../lib/shortcuts';
import { HISTORY_LIMIT, useNavigationStore } from '../stores/navigation';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../components/auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));

const press = (key: string, target: EventTarget = document.body) => {
  const e = new KeyboardEvent('keydown', { key, code: key, metaKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'target', { value: target });
  return dispatchKeydown(e, { menuOwnsChords: false, mac: true });
};

beforeEach(() => {
  clearShortcuts();
  registerShortcuts(buildAppShortcuts());
  useNavigationStore.setState({
    route: { view: 'home' },
    replace: false,
    backStack: [],
    forwardStack: [],
    lastWorkbenchId: null,
  });
});

afterEach(() => {
  cleanup();
  clearShortcuts();
});

describe('navigation history', () => {
  it('moves through routes and clears forward history after a new route', () => {
    const nav = useNavigationStore.getState();
    nav.navigate({ view: 'history' });
    nav.navigate({ view: 'prs', tab: 'reviews' });
    nav.back();
    expect(useNavigationStore.getState()).toMatchObject({
      route: { view: 'history' },
      backStack: [{ view: 'home' }],
      forwardStack: [{ view: 'prs', tab: 'reviews' }],
    });
    nav.forward();
    expect(useNavigationStore.getState().route).toEqual({ view: 'prs', tab: 'reviews' });
    nav.back();
    nav.navigate({ view: 'automations', tab: 'loops' });
    expect(useNavigationStore.getState().forwardStack).toEqual([]);
  });

  it('keeps history for replace and same-route navigation', () => {
    const nav = useNavigationStore.getState();
    nav.navigate({ view: 'history' });
    nav.back();
    nav.navigate({ view: 'home' });
    expect(useNavigationStore.getState().forwardStack).toEqual([{ view: 'history' }]);
    nav.navigate({ view: 'prs', tab: 'reviews' }, { replace: true });
    expect(useNavigationStore.getState().backStack).toEqual([]);
    expect(useNavigationStore.getState().forwardStack).toEqual([{ view: 'history' }]);
  });

  it('limits the back stack', () => {
    const nav = useNavigationStore.getState();
    for (let i = 0; i <= HISTORY_LIMIT; i++) nav.navigate({ view: 'workbench', id: `session-${i}` });
    expect(useNavigationStore.getState().backStack).toHaveLength(HISTORY_LIMIT);
    expect(useNavigationStore.getState().backStack[0]).toEqual({ view: 'workbench', id: 'session-0' });
  });
});

describe('navigation keys', () => {
  it.each([
    ['ArrowLeft', 'ArrowRight'],
    ['[', ']'],
  ])('moves back with %s and forward with %s', (back, forward) => {
    useNavigationStore.getState().navigate({ view: 'history' });
    expect(press(back)).toBe(true);
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
    expect(press(forward)).toBe(true);
    expect(useNavigationStore.getState().route).toEqual({ view: 'history' });
  });

  it.each(['ArrowLeft', 'ArrowRight', '[', ']'])('leaves %s unhandled without history', (key) => {
    expect(press(key)).toBe(false);
  });

  it.each(['ArrowLeft', '['])('ignores %s in a textarea', (key) => {
    useNavigationStore.getState().navigate({ view: 'history' });
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    expect(press(key, input)).toBe(false);
    expect(useNavigationStore.getState().route).toEqual({ view: 'history' });
    input.remove();
  });
});

describe('history buttons', () => {
  it('shows History before Back and marks the history route', () => {
    render(<HistoryButtons showHistory />);
    const history = screen.getByRole('button', { name: 'History' });
    expect(history.nextElementSibling).toBe(screen.getByRole('button', { name: 'Back' }));
    expect(history).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(history);
    expect(useNavigationStore.getState().route).toEqual({ view: 'history' });
    expect(history).toHaveAttribute('aria-pressed', 'true');
  });

  it('disables empty directions and moves through history', () => {
    render(<HistoryButtons />);
    const back = () => screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement;
    const forward = () => screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement;
    expect([back().disabled, forward().disabled]).toEqual([true, true]);
    act(() => useNavigationStore.getState().navigate({ view: 'history' }));
    expect(back().disabled).toBe(false);
    fireEvent.click(back());
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
    expect(forward().disabled).toBe(false);
    fireEvent.click(forward());
    expect(useNavigationStore.getState().route).toEqual({ view: 'history' });
  });
});
