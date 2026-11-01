import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { HistoryButtons } from '../renderer/components/layout/AppSidebar';
import { buildAppShortcuts } from '../renderer/components/layout/appShortcuts';
import { clearShortcuts, dispatchKeydown, registerShortcuts } from '../renderer/lib/shortcuts';
import { useNavigationStore } from '../renderer/stores/navigation';

const press = (key: string, target: EventTarget = document.body) => {
  const e = new KeyboardEvent('keydown', { key, code: key, metaKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'target', { value: target });
  return dispatchKeydown(e, { menuOwnsChords: true, mac: true });
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

  it.each([
    ['ArrowLeft', { view: 'home' }],
    ['ArrowRight', { view: 'history' }],
  ] as const)('navigates with %s in an empty composer', (key, expected) => {
    useNavigationStore.getState().navigate({ view: 'history' });
    if (key === 'ArrowRight') useNavigationStore.getState().back();
    const composer = document.createElement('textarea');
    composer.setAttribute('data-session-composer', '');
    document.body.appendChild(composer);
    expect(press(key, composer)).toBe(true);
    expect(useNavigationStore.getState().route).toEqual(expected);
    composer.remove();
  });

  it.each(['ArrowLeft', 'ArrowRight'])('leaves %s to a composer with text', (key) => {
    useNavigationStore.getState().navigate({ view: 'history' });
    if (key === 'ArrowRight') useNavigationStore.getState().back();
    const route = useNavigationStore.getState().route;
    const composer = document.createElement('textarea');
    composer.setAttribute('data-session-composer', '');
    composer.value = 'draft';
    document.body.appendChild(composer);
    expect(press(key, composer)).toBe(false);
    expect(useNavigationStore.getState().route).toEqual(route);
    composer.remove();
  });

  it.each(['ArrowLeft', 'ArrowRight'])('leaves %s to another text field or the terminal', (key) => {
    useNavigationStore.getState().navigate({ view: 'history' });
    if (key === 'ArrowRight') useNavigationStore.getState().back();
    const route = useNavigationStore.getState().route;
    const input = document.createElement('input');
    const terminal = document.createElement('div');
    terminal.className = 'xterm';
    document.body.append(input, terminal);
    expect(press(key, input)).toBe(false);
    expect(press(key, terminal)).toBe(false);
    expect(useNavigationStore.getState().route).toEqual(route);
    input.remove();
    terminal.remove();
  });

  it('keeps the bracket chords as hidden aliases', () => {
    useNavigationStore.getState().navigate({ view: 'history' });
    expect(press('[')).toBe(true);
    expect(press(']')).toBe(true);
    expect(useNavigationStore.getState().route).toEqual({ view: 'history' });
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
