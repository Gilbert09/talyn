import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  TITLE_TOOLTIP_OPEN_DELAY_MS,
  TITLE_TOOLTIP_SKIP_DELAY_MS,
  TitleTooltipLayer,
} from '../renderer/components/ui/title-tooltip';

function Icons({ archiveTitle = 'Archive all sessions' }: { archiveTitle?: string }) {
  return (
    <div data-testid="root">
      <TitleTooltipLayer />
      <button type="button" data-testid="archive" title={archiveTitle || undefined}>
        <svg data-testid="archive-icon" />
      </button>
      <button type="button" data-testid="cloud" title="Cloud sandbox">
        C
      </button>
      <button type="button" data-testid="plain">
        P
      </button>
      <button type="button" data-testid="empty" title="">
        E
      </button>
      <div data-testid="other-scroller" />
    </div>
  );
}

const tooltip = () => screen.queryByTestId('title-tooltip');

function hover(testId: string, init: Record<string, unknown> = {}) {
  fireEvent.pointerOver(screen.getByTestId(testId), init);
}

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe('TitleTooltipLayer', () => {
  it('shows the title after the short delay and hides the native one', () => {
    render(<Icons />);
    hover('archive');

    const archive = screen.getByTestId('archive');
    expect(archive.getAttribute('title')).toBeNull();
    expect(archive.getAttribute('data-title-tooltip')).toBe('Archive all sessions');
    expect(tooltip()).toBeNull();

    advance(TITLE_TOOLTIP_OPEN_DELAY_MS - 1);
    expect(tooltip()).toBeNull();
    advance(1);
    expect(tooltip()?.textContent).toBe('Archive all sessions');
    expect(tooltip()?.getAttribute('role')).toBe('tooltip');
  });

  it('shows the title when the pointer is over a child of the titled element', () => {
    render(<Icons />);
    hover('archive-icon');
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS);
    expect(tooltip()?.textContent).toBe('Archive all sessions');

    // Moving between the button and its icon keeps the same tooltip.
    hover('archive');
    expect(tooltip()?.textContent).toBe('Archive all sessions');
  });

  it.each(['plain', 'empty'])('restores the title when the pointer moves to %s', (next) => {
    render(<Icons />);
    hover('archive');
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS);
    hover(next);

    const archive = screen.getByTestId('archive');
    expect(archive.getAttribute('title')).toBe('Archive all sessions');
    expect(archive.hasAttribute('data-title-tooltip')).toBe(false);
    expect(tooltip()).toBeNull();
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS * 4);
    expect(tooltip()).toBeNull();
  });

  it('leaves an empty title alone', () => {
    render(<Icons />);
    hover('empty');
    expect(screen.getByTestId('empty').getAttribute('title')).toBe('');
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS * 4);
    expect(tooltip()).toBeNull();
  });

  it('opens the next tooltip at once right after one closes', () => {
    render(<Icons />);
    hover('archive');
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS);
    hover('cloud');
    expect(tooltip()?.textContent).toBe('Cloud sandbox');
  });

  it('waits again once the skip window has passed', () => {
    render(<Icons />);
    hover('archive');
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS);
    hover('plain');
    advance(TITLE_TOOLTIP_SKIP_DELAY_MS + 1);
    hover('cloud');
    expect(tooltip()).toBeNull();
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS);
    expect(tooltip()?.textContent).toBe('Cloud sandbox');
  });

  it('restores the title when the pointer leaves the window', () => {
    render(<Icons />);
    hover('archive');
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS);
    fireEvent.pointerOut(screen.getByTestId('archive'), { relatedTarget: null });
    expect(tooltip()).toBeNull();
    expect(screen.getByTestId('archive').getAttribute('title')).toBe('Archive all sessions');
  });

  it.each([
    ['a press', () => fireEvent.pointerDown(screen.getByTestId('archive'))],
    ['a key', () => fireEvent.keyDown(document.body, { key: 'Escape' })],
    ['a scroll of the page', () => fireEvent.scroll(document)],
    ['a scroll of an ancestor', () => fireEvent.scroll(screen.getByTestId('root'))],
  ])('closes on %s and stays closed on the same element', (_label, act_) => {
    render(<Icons />);
    hover('archive');
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS);
    act_();
    expect(tooltip()).toBeNull();

    hover('archive-icon');
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS * 4);
    expect(tooltip()).toBeNull();
    expect(screen.getByTestId('archive').getAttribute('title')).toBeNull();

    hover('plain');
    expect(screen.getByTestId('archive').getAttribute('title')).toBe('Archive all sessions');
  });

  it('cancels a pending tooltip on a press', () => {
    render(<Icons />);
    hover('archive');
    fireEvent.pointerDown(screen.getByTestId('archive'));
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS * 4);
    expect(tooltip()).toBeNull();
  });

  it('stays open when an unrelated element scrolls', () => {
    render(<Icons />);
    hover('archive');
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS);
    fireEvent.scroll(screen.getByTestId('other-scroller'));
    expect(tooltip()?.textContent).toBe('Archive all sessions');
  });

  it('ignores touch', () => {
    render(<Icons />);
    const archive = screen.getByTestId('archive');
    const event = new Event('pointerover', { bubbles: true });
    Object.defineProperty(event, 'pointerType', { value: 'touch' });
    fireEvent(archive, event);
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS * 4);
    expect(tooltip()).toBeNull();
    expect(archive.getAttribute('title')).toBe('Archive all sessions');
  });

  it('follows a title that React changes during the hover', async () => {
    const { rerender } = render(<Icons archiveTitle="Archive (3)" />);
    hover('archive');
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS);
    expect(tooltip()?.textContent).toBe('Archive (3)');

    rerender(<Icons archiveTitle="Archive (2)" />);
    // MutationObserver callbacks run as microtasks.
    await act(async () => {});
    const archive = screen.getByTestId('archive');
    expect(archive.getAttribute('title')).toBeNull();
    expect(tooltip()?.textContent).toBe('Archive (2)');

    hover('plain');
    expect(archive.getAttribute('title')).toBe('Archive (2)');
  });

  it('does not bring back a title that React removed during the hover', () => {
    const { rerender } = render(<Icons archiveTitle="Archive (1)" />);
    hover('archive');
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS);
    rerender(<Icons archiveTitle="" />);
    hover('plain');
    expect(screen.getByTestId('archive').hasAttribute('title')).toBe(false);
    expect(screen.getByTestId('archive').hasAttribute('data-title-tooltip')).toBe(false);
  });

  it('closes when the hovered element leaves the page', () => {
    function Removable({ show }: { show: boolean }) {
      return (
        <>
          <TitleTooltipLayer />
          {show && (
            <button type="button" data-testid="row" title="Archive session">
              R
            </button>
          )}
        </>
      );
    }
    const { rerender } = render(<Removable show />);
    hover('row');
    advance(TITLE_TOOLTIP_OPEN_DELAY_MS);
    expect(tooltip()).not.toBeNull();
    rerender(<Removable show={false} />);
    advance(300);
    expect(tooltip()).toBeNull();
  });

  it('puts the title back when the layer unmounts', () => {
    function Toggle({ layer }: { layer: boolean }) {
      return (
        <>
          {layer && <TitleTooltipLayer />}
          <button type="button" data-testid="btn" title="Open in browser">
            B
          </button>
        </>
      );
    }
    const { rerender } = render(<Toggle layer />);
    hover('btn');
    expect(screen.getByTestId('btn').getAttribute('title')).toBeNull();
    rerender(<Toggle layer={false} />);
    expect(screen.getByTestId('btn').getAttribute('title')).toBe('Open in browser');
  });
});
