import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useSidebarWidth,
} from '../lib/sidebarWidth';

function Probe() {
  const { width, handleProps } = useSidebarWidth();
  return (
    <div>
      <span data-testid="width">{width}</span>
      <div {...handleProps} />
    </div>
  );
}

const width = () => Number(screen.getByTestId('width').textContent);
const handle = () => screen.getByRole('separator', { name: 'Resize the sidebar' });

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('sidebar width', () => {
  it.each([
    [100, SIDEBAR_MIN_WIDTH],
    [300.4, 300],
    [9999, SIDEBAR_MAX_WIDTH],
    [Number.NaN, SIDEBAR_DEFAULT_WIDTH],
  ])('clamps %p to %p', (input, expected) => {
    expect(clampSidebarWidth(input)).toBe(expected);
  });

  it('starts at the default, and at a remembered width after that', () => {
    const { unmount } = render(<Probe />);
    expect(width()).toBe(SIDEBAR_DEFAULT_WIDTH);
    unmount();
    localStorage.setItem('talyn-sidebar-width', '320');
    render(<Probe />);
    expect(width()).toBe(320);
  });

  it('follows a drag, keeps it in bounds, and remembers it', () => {
    render(<Probe />);
    // jsdom has no PointerEvent, so a MouseEvent carries the position.
    act(() => { handle().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 240 })); });
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 })); });
    expect(width()).toBe(300);
    act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX: 2000 })); });
    expect(width()).toBe(SIDEBAR_MAX_WIDTH);
    act(() => { window.dispatchEvent(new MouseEvent('pointerup')); });
    expect(localStorage.getItem('talyn-sidebar-width')).toBe(String(SIDEBAR_MAX_WIDTH));
  });

  it('moves with the arrow keys, and a double-click resets it', () => {
    render(<Probe />);
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(width()).toBe(SIDEBAR_DEFAULT_WIDTH + 16);
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(width()).toBe(SIDEBAR_DEFAULT_WIDTH - 16);
    fireEvent.doubleClick(handle());
    expect(width()).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(localStorage.getItem('talyn-sidebar-width')).toBe(String(SIDEBAR_DEFAULT_WIDTH));
  });
});
