import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MarkdownTextarea } from '../renderer/components/workbench/MarkdownTextarea';

// The tokenizer (@talyn/shared composerMarkdown) has its cases in the web suite.
describe('MarkdownTextarea', () => {
  afterEach(cleanup);

  function Harness({ initial }: { initial: string }) {
    const [value, setValue] = React.useState(initial);
    return (
      <MarkdownTextarea
        aria-label="Message"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        textClassName="px-3 py-2 text-sm"
        className="block w-full bg-transparent"
      />
    );
  }

  it('keeps a real textarea and paints a hidden styled copy behind it', () => {
    const { container } = render(<Harness initial="> quoted" />);
    const textarea = screen.getByRole('textbox', { name: 'Message' });
    expect(textarea.tagName).toBe('TEXTAREA');
    expect((textarea as HTMLTextAreaElement).value).toBe('> quoted');
    expect(textarea.className).toContain('text-transparent');
    const copy = container.querySelector('[data-attr="composer-formatting"]');
    expect(copy?.getAttribute('aria-hidden')).toBe('true');
    expect(copy?.textContent).toBe('> quoted');
  });

  it('restyles the copy as the text changes', () => {
    const { container } = render(<Harness initial="" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a **b**\n\nc' } });
    const copy = container.querySelector('[data-attr="composer-formatting"]')!;
    // One block per line; an empty line keeps its height with a zero-width space.
    expect(copy.children).toHaveLength(3);
    expect(copy.children[1].textContent).toBe('​');
    expect(Array.from(copy.querySelectorAll('span')).map((s) => s.textContent)).toEqual(['**', 'b', '**']);
  });

  function fenceRuns(container: HTMLElement) {
    return Array.from(container.querySelectorAll('[data-fence]')).map((line) => ({
      side: line.getAttribute('data-fence'),
      hidden: line.firstElementChild!.className.includes('text-transparent'),
    }));
  }

  it('adds the closing fence on a new line after an opening one', () => {
    render(<Harness initial="```json" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(7, 7);
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(textarea.value).toBe('```json\n\n```');
    expect(textarea.selectionStart).toBe(8);
    expect(textarea.selectionEnd).toBe(8);
  });

  it('leaves a new line alone once the fence is closed', () => {
    render(<Harness initial={'```\ncode\n```'} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(3, 3);
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(textarea.value).toBe('```\ncode\n```');
  });

  it('does not add a fence when the parent handles Enter', () => {
    const send = jest.fn((e: React.KeyboardEvent) => e.preventDefault());
    render(<MarkdownTextarea aria-label="Message" value="```" onChange={() => undefined} onKeyDown={send} textClassName="" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    textarea.setSelectionRange(3, 3);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('```');
  });

  it('hides closing backticks, and opening ones unless the caret is on their line', () => {
    const { container } = render(<Harness initial={'```json\nx\n```\nafter'} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(fenceRuns(container)).toEqual([
      { side: 'open', hidden: true },
      { side: 'close', hidden: true },
    ]);
    // The language stays as a label.
    expect(container.querySelector('[data-fence="open"]')!.textContent).toBe('```json');
    expect(container.querySelector('[data-fence="open"]')!.lastElementChild!.className).not.toContain('text-transparent');

    textarea.focus();
    textarea.setSelectionRange(2, 2);
    fireEvent.select(textarea);
    expect(fenceRuns(container).map((f) => f.hidden)).toEqual([false, true]);

    textarea.setSelectionRange(9, 9);
    fireEvent.select(textarea);
    expect(fenceRuns(container).map((f) => f.hidden)).toEqual([true, true]);

    // On the closing fence, its backticks still do not show.
    textarea.setSelectionRange(12, 12);
    fireEvent.select(textarea);
    expect(fenceRuns(container).map((f) => f.hidden)).toEqual([true, true]);

    textarea.setSelectionRange(0, 14);
    fireEvent.select(textarea);
    expect(fenceRuns(container).map((f) => f.hidden)).toEqual([false, true]);

    fireEvent.blur(textarea);
    expect(fenceRuns(container).map((f) => f.hidden)).toEqual([true, true]);
  });

  it.each([
    ['Shift+Enter on an empty last code line', '```\ncode\n\n```', 9, { key: 'Enter', shiftKey: true }, '```\ncode\n```\n', 13],
    ['Backspace below a block', '```\ncode\n```\n', 13, { key: 'Backspace' }, '```\ncode\n```', 8],
  ])('handles %s', (_name, initial, caret, key, value, after) => {
    render(<Harness initial={initial} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    fireEvent.keyDown(textarea, key);
    expect(textarea.value).toBe(value);
    expect(textarea.selectionStart).toBe(after);
    expect(textarea.selectionEnd).toBe(after);
  });

  it('does not leave the block when the parent handles the key', () => {
    const send = jest.fn((e: React.KeyboardEvent) => e.preventDefault());
    render(<MarkdownTextarea aria-label="Message" value={'```\ncode\n\n```'} onChange={() => undefined} onKeyDown={send} textClassName="" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    textarea.setSelectionRange(9, 9);
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(textarea.value).toBe('```\ncode\n\n```');
  });

  it.each([
    ['Down past the closing fence', 'ArrowDown', '```\ncode\n```', 10, '```\ncode\n```\n', 13],
    ['Up past the closing fence', 'ArrowUp', '```\ncode\n```\nafter', 9, '```\ncode\n```\nafter', 8],
    ['Down onto a code line', 'ArrowDown', '```\na\nb\n```', 6, '```\na\nb\n```', 6],
  ])('steps %s after the browser moves the caret', async (_name, key, initial, landed, value, after) => {
    render(<Harness initial={initial} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.keyDown(textarea, { key });
    // jsdom does not move the caret on arrow keys: put it where the browser would.
    textarea.setSelectionRange(landed, landed);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(textarea.value).toBe(value);
    expect(textarea.selectionStart).toBe(after);
  });

  it('does not step over the fence while Shift extends a selection', async () => {
    render(<Harness initial={'```\ncode\n```'} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'ArrowDown', shiftKey: true });
    textarea.setSelectionRange(10, 10);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(textarea.value).toBe('```\ncode\n```');
    expect(textarea.selectionStart).toBe(10);
  });

  it('passes the ref through to the textarea', () => {
    const ref = React.createRef<HTMLTextAreaElement>();
    render(<MarkdownTextarea ref={ref} value="x" onChange={() => undefined} textClassName="" />);
    expect(ref.current?.tagName).toBe('TEXTAREA');
  });
});
