import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('passes the ref through to the textarea', () => {
    const ref = React.createRef<HTMLTextAreaElement>();
    render(<MarkdownTextarea ref={ref} value="x" onChange={() => undefined} textClassName="" />);
    expect(ref.current?.tagName).toBe('TEXTAREA');
  });
});
