import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { HistoryButtons } from '../renderer/components/layout/AppSidebar';
import { buildAppShortcuts } from '../renderer/components/layout/appShortcuts';
import { clearShortcuts, dispatchKeydown, registerShortcuts } from '../renderer/lib/shortcuts';
import { useNavigationStore } from '../renderer/stores/navigation';

const press = (key: string, target: EventTarget = document.body) => {
  const e = new KeyboardEvent('keydown', { key, code: key, metaKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'target', { value: target });
  return dispatchKeydown(e, { menuOwnsChords: false, mac: true });
};

beforeEach(() => {
  clearShortcuts();
  registerShortcuts(buildAppShortcuts());
  useNavigationStore.setState({ route: { view: 'home' }, backStack: [], forwardStack: [] });
});

describe('⌘← and ⌘→', () => {
  it('go back and forward', () => {
    useNavigationStore.getState().navigate({ view: 'history' });
    expect(press('ArrowLeft')).toBe(true);
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
    expect(press('ArrowRight')).toBe(true);
    expect(useNavigationStore.getState().route).toEqual({ view: 'history' });
  });

  it('do nothing with no history, so the key reaches the page', () => {
    expect(press('ArrowLeft')).toBe(false);
    expect(press('ArrowRight')).toBe(false);
  });

  it('leave a text field alone, where they move the cursor', () => {
    useNavigationStore.getState().navigate({ view: 'history' });
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    expect(press('ArrowLeft', input)).toBe(false);
    expect(useNavigationStore.getState().route).toEqual({ view: 'history' });
    input.remove();
  });
});

describe('the back and forward buttons', () => {
  it('shows History before Back and marks the history route', () => {
    render(<HistoryButtons showHistory />);
    const history = screen.getByRole('button', { name: 'History' });
    expect(history.nextElementSibling).toBe(screen.getByRole('button', { name: 'Back' }));
    expect(history).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(history);
    expect(useNavigationStore.getState().route).toEqual({ view: 'history' });
    expect(history).toHaveAttribute('aria-pressed', 'true');
  });

  it('are off with no history, and move through it', () => {
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
