import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Markdown } from '../lib/markdown';

const SRC = 'https://private-user-images.githubusercontent.com/1/2-shot.png?jwt=a.b.c';

afterEach(cleanup);

describe('markdown image preview', () => {
  it.each([
    ['a markdown image', `![Before change](${SRC})`, 'Before change'],
    ['a raw <img> tag', `<img width="100" alt="Before change" src="${SRC}" />`, 'Before change'],
    ['an image with no alt text', `![](${SRC})`, 'Image'],
  ])('opens %s full size on click', (_label, text, label) => {
    render(<Markdown text={text} variant="surface" />);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: `Open image: ${label}` }));

    const dialog = screen.getByRole('dialog', { name: `Image: ${label}` });
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(SRC);
    expect(screen.getByRole('link', { name: /Open original/ }).getAttribute('href')).toBe(SRC);
  });

  it('opens the preview instead of following a link that wraps the image', () => {
    render(<Markdown text={`[![shot](${SRC})](https://github.com/acme/widgets)`} variant="surface" />);
    const button = screen.getByRole('button', { name: 'Open image: shot' });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      button.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it.each([
    ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close image' }))],
    ['the backdrop', () => fireEvent.click(screen.getByRole('dialog'))],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
  ])('closes on %s', (_label, close) => {
    render(<Markdown text={`![shot](${SRC})`} variant="surface" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open image: shot' }));
    close();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays open when the image itself is clicked', () => {
    render(<Markdown text={`![shot](${SRC})`} variant="surface" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open image: shot' }));
    fireEvent.click(screen.getByRole('dialog').querySelector('img')!);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps Escape from reaching the panel under the preview', () => {
    const panelEscape = vi.fn();
    document.addEventListener('keydown', panelEscape);
    try {
      render(<Markdown text={`![shot](${SRC})`} variant="surface" />);
      fireEvent.click(screen.getByRole('button', { name: 'Open image: shot' }));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(panelEscape).not.toHaveBeenCalled();

      // With the preview closed, Escape reaches the panel again.
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(panelEscape).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', panelEscape);
    }
  });

  it('shows a link to the image when it does not load', () => {
    render(<Markdown text={`![shot](${SRC})`} variant="surface" />);
    fireEvent.error(screen.getByRole('img', { name: 'shot' }));
    expect(screen.queryByRole('button', { name: 'Open image: shot' })).toBeNull();
    const link = screen.getByRole('link', { name: /shot · Image unavailable/ });
    expect(link.getAttribute('href')).toBe(SRC);
  });
});
