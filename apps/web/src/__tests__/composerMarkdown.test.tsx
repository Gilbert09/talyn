import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  backspaceAfterCodeBlock,
  closeFenceOnNewline,
  composerMarkdown,
  endQuotesAtPlainLines,
  leaveCodeBlockOnNewline,
  stepOverClosingFence,
  type ComposerEdit,
  type ComposerLine,
} from '@talyn/shared';
import { MarkdownTextarea } from '../components/workbench/MarkdownTextarea';
import { renderMarkdownish } from '../lib/markdown';

/** Each line as `kind: text{marks}|text…`, so a case reads at a glance. */
function shape(lines: ComposerLine[]): string[] {
  return lines.map(
    (line) => `${line.kind}: ${line.spans.map((s) => (s.marks.length ? `${s.text}{${s.marks.join(',')}}` : s.text)).join('|')}`,
  );
}

describe('composerMarkdown', () => {
  it.each([
    ['plain text', 'Yeah this is an issue', ['text: Yeah this is an issue']],
    ['a quote', '> Batch #0 takes about 44 minutes', ['quote: > {marker}|Batch #0 takes about 44 minutes']],
    ['a nested quote', '>> deep', ['quote: >> {marker}|deep']],
    ['a heading', '## Plan', ['heading: ## {marker}|Plan{bold}']],
    ['a bullet', '- item', ['list: - {marker}|item']],
    ['a star bullet is not italic', '* item', ['list: * {marker}|item']],
    ['a numbered item', '12. twelve', ['list: 12. {marker}|twelve']],
    ['a task item', '- [x] done', ['list: - [x] {marker}|done']],
    ['an indented bullet', '  - sub', ['list:   |- {marker}|sub']],
    ['bold', 'a **b** c', ['text: a |**{marker}|b{bold}|**{marker}| c']],
    ['underscore bold', '__b__', ['text: __{marker}|b{bold}|__{marker}']],
    ['italic', '*i*', ['text: *{marker}|i{italic}|*{marker}']],
    ['underscore italic', 'an _i_ word', ['text: an |_{marker}|i{italic}|_{marker}| word']],
    ['italic inside bold', '**a _b_**', ['text: **{marker}|a {bold}|_{bold,marker}|b{bold,italic}|_{bold,marker}|**{marker}']],
    ['strike', '~~x~~', ['text: ~~{marker}|x{strike}|~~{marker}']],
    ['inline code', 'run `npm test`', ['text: run |`{code,marker}|npm test{code}|`{code,marker}']],
    ['nothing inside code is styled', '`**x**`', ['text: `{code,marker}|**x**{code}|`{code,marker}']],
    ['double backtick code', '``a ` b``', ['text: ``{code,marker}|a ` b{code}|``{code,marker}']],
    ['a link', '[docs](https://x.dev)', ['text: [{marker}|docs{link}|](https://x.dev){marker}']],
    ['a bare URL without its full stop', 'see https://x.dev/a.', ['text: see |https://x.dev/a{link}|.']],
    ['a file mention', 'fix @src/app.ts now', ['text: fix |@src/app.ts{mention}| now']],
    ['a slash command at the start', '/review this', ['text: /review{command}| this']],
    ['a slash command needs the start of the message', 'run /review', ['text: run /review']],
    ['snake_case stays plain', 'my_var_name', ['text: my_var_name']],
    ['an email stays plain', 'tom@example.com', ['text: tom@example.com']],
    ['a lone star stays plain', '2 * 3 * 4', ['text: 2 * 3 * 4']],
    ['unclosed markers stay plain', '**open `tick _under', ['text: **open `tick _under']],
    ['a rule is not a bullet', '---', ['text: ---']],
    [
      'a fenced block',
      '```ts\nconst a = `b`;\n```\nafter',
      ['fence: ```ts{marker}', 'code: const a = `b`;{code}', 'fence: ```{marker}', 'text: after'],
    ],
    ['an unclosed fence runs to the end', '```\n# not a heading', ['fence: ```{marker}', 'code: # not a heading{code}']],
    ['a shorter fence does not close', '````\n```\n````', ['fence: ````{marker}', 'code: ```{code}', 'fence: ````{marker}']],
    ['a tilde fence', '~~~\nx\n~~~', ['fence: ~~~{marker}', 'code: x{code}', 'fence: ~~~{marker}']],
    ['empty lines', '\n', ['text: ', 'text: ']],
  ])('%s', (_name, text, expected) => {
    expect(shape(composerMarkdown(text))).toEqual(expected);
  });

  it.each([
    '',
    '> Batch #0 takes about 44 minutes\nYeah this is an issue',
    '# T\n- a *b* **c** `d` ~~e~~ [f](g) @h /i\n```\nx\n```\n\n',
    '**_~~`[](`@/\n\t> > -  1) x',
    'trailing spaces   \n   ',
  ])('joins back to the exact input: %j', (text) => {
    const back = composerMarkdown(text)
      .map((line) => line.spans.map((s) => s.text).join(''))
      .join('\n');
    expect(back).toBe(text);
  });
});

describe('closeFenceOnNewline', () => {
  /** `|` marks the caret. */
  function at(draft: string) {
    const caret = draft.indexOf('|');
    return closeFenceOnNewline(draft.replace('|', ''), caret, caret);
  }

  it.each([
    ['a bare fence', '```|', { insert: '\n\n```', caret: 4 }],
    ['a fence with a language', '```json|', { insert: '\n\n```', caret: 8 }],
    ['a longer fence', '````|', { insert: '\n\n````', caret: 5 }],
    ['a tilde fence', '~~~|', { insert: '\n\n~~~', caret: 4 }],
    ['an indented fence', '  ```|', { insert: '\n\n  ```', caret: 6 }],
    ['trailing spaces after the caret', '```|  ', { insert: '\n\n```', caret: 4 }],
    ['after earlier text', 'see this:\n```|', { insert: '\n\n```', caret: 14 }],
    ['after a closed block', '```\na\n```\n```|', { insert: '\n\n```', caret: 14 }],
    ['before plain text below', '```|\nnext', { insert: '\n\n```', caret: 4 }],
  ])('closes %s', (_name, draft, expected) => {
    expect(at(draft)).toEqual(expected);
  });

  it.each([
    ['plain text', 'hello|'],
    ['inside the fence run', '``|`'],
    ['before the language', '```|ts'],
    ['a fence that is already closed', '```|\ncode\n```'],
    ['a closing fence', '```\ncode\n```|'],
    ['inside a code block', '```\ncode|'],
    ['two backticks', '``|'],
    ['a fence in a quote', '> ```|'],
    ['inline code', '`a`|'],
  ])('leaves %s alone', (_name, draft) => {
    expect(at(draft)).toBeNull();
  });

  it('leaves a selection alone', () => {
    expect(closeFenceOnNewline('```', 0, 3)).toBeNull();
  });
});

/** `|` marks the caret. Gives back the draft after the edit, with `|` at the new caret, or null. */
function edited(draft: string, edit: (text: string, caret: number) => ComposerEdit | null): string | null {
  const caret = draft.indexOf('|');
  const text = draft.replace('|', '');
  const change = edit(text, caret);
  if (!change) return null;
  const after = text.slice(0, change.from) + change.insert + text.slice(change.to);
  return `${after.slice(0, change.caret)}|${after.slice(change.caret)}`;
}

describe('stepOverClosingFence', () => {
  it.each([
    ['down to the line below', '```\ncode\n``|`\nafter', 'down', '```\ncode\n```\n|after'],
    ['down at the start of the fence', '```\ncode\n|```\nafter', 'down', '```\ncode\n```\n|after'],
    ['down to a new line at the end of the draft', '```\ncode\n`|``', 'down', '```\ncode\n```\n|'],
    ['down past a tilde fence', '~~~\ncode\n~|~~', 'down', '~~~\ncode\n~~~\n|'],
    ['down past a fence with a language', '```ts\ncode\n|```', 'down', '```ts\ncode\n```\n|'],
    ['up to the end of the last code line', 'a\n```\nfirst\nlast\n|```\nb', 'up', 'a\n```\nfirst\nlast|\n```\nb'],
  ] as const)('goes %s', (_name, draft, direction, expected) => {
    expect(edited(draft, (text, caret) => stepOverClosingFence(text, caret, direction))).toBe(expected);
  });

  it.each([
    ['a code line', '```\nco|de\n```', 'down'],
    ['an opening fence', '``|`\ncode\n```', 'down'],
    ['plain text', 'hel|lo', 'down'],
    ['a fence in an unclosed block', '```\ncode\n``|`ts', 'down'],
    ['up from an empty block', '```\n|```', 'up'],
  ] as const)('leaves %s alone', (_name, draft, direction) => {
    expect(edited(draft, (text, caret) => stepOverClosingFence(text, caret, direction))).toBeNull();
  });
});

describe('leaveCodeBlockOnNewline', () => {
  const newline = (text: string, caret: number) => leaveCodeBlockOnNewline(text, caret, caret);

  it.each([
    ['an empty last code line', '```\ncode\n|\n```', '```\ncode\n```\n|'],
    ['an empty last line with spaces', '```\ncode\n  |\n```', '```\ncode\n```\n|'],
    ['an empty last line above text', '```\ncode\n|\n```\nafter', '```\ncode\n```\n|\nafter'],
    ['an empty last line above an empty line', '```\ncode\n|\n```\n\nafter', '```\ncode\n```\n|\nafter'],
    ['the only code line', 'see:\n```\n|\n```', 'see:\n```\n```\n|'],
    ['a fence with a language', '```ts\nx\n|\n```', '```ts\nx\n```\n|'],
    ['a tilde block', '~~~\nx\n|\n~~~', '~~~\nx\n~~~\n|'],
    ['an unclosed block', '```\ncode\n|', '```\ncode\n```\n|'],
    ['an unclosed indented block', '  ````\ncode\n|', '  ````\ncode\n  ````\n|'],
    ['the start of a closing fence', '```\ncode\n|```', '```\ncode\n```\n|'],
    ['the end of a closing fence', '```\ncode\n```|\nafter', '```\ncode\n```\n|\nafter'],
  ])('leaves the block from %s', (_name, draft, expected) => {
    expect(edited(draft, newline)).toBe(expected);
  });

  it.each([
    ['the end of a code line', '```\ncode|\n```'],
    ['an empty code line in the middle', '```\na\n|\nb\n```'],
    ['an opening fence', '```|\ncode\n```'],
    ['plain text', 'hello|'],
    ['an empty plain line', 'hello\n|'],
    ['a quote', '> quote|'],
  ])('leaves %s alone', (_name, draft) => {
    expect(edited(draft, newline)).toBeNull();
  });

  it('leaves a selection alone', () => {
    expect(leaveCodeBlockOnNewline('```\ncode\n\n```', 0, 3)).toBeNull();
  });
});

describe('backspaceAfterCodeBlock', () => {
  const backspace = (text: string, caret: number) => backspaceAfterCodeBlock(text, caret, caret);

  it.each([
    ['an empty line', '```\ncode\n```\n|', '```\ncode|\n```'],
    ['an empty line above more text', '```\ncode\n```\n|\nmore', '```\ncode|\n```\nmore'],
    ['a line with text', '```\ncode\n```\n|after', '```\ncode|\n```\nafter'],
  ])('moves back into the block from %s', (_name, draft, expected) => {
    expect(edited(draft, backspace)).toBe(expected);
  });

  it.each([
    ['the middle of the line', '```\ncode\n```\naf|ter'],
    ['below an empty block', '```\n```\n|'],
    ['plain text', 'a\n|b'],
    ['the first line', '|a'],
    ['a code line', '```\na\n|b\n```'],
  ])('leaves %s alone', (_name, draft) => {
    expect(edited(draft, backspace)).toBeNull();
  });

  it('leaves a selection alone', () => {
    expect(backspaceAfterCodeBlock('```\ncode\n```\nx', 13, 14)).toBeNull();
  });
});

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
    const send = vi.fn((e: React.KeyboardEvent) => e.preventDefault());
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
    const send = vi.fn((e: React.KeyboardEvent) => e.preventDefault());
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

describe('endQuotesAtPlainLines', () => {
  it.each([
    ['no quote', 'a\nb', 'a\nb'],
    ['a plain line after a quote', '> quote\nreply', '> quote\n\nreply'],
    ['a quote between paragraphs', 'intro\n> quote\nreply', 'intro\n> quote\n\nreply'],
    ['a blank line already there', '> quote\n\nreply', '> quote\n\nreply'],
    ['a quote over many lines', '> one\n> two\nreply', '> one\n> two\n\nreply'],
    ['a nested quote', '>> deep\nreply', '>> deep\n\nreply'],
    ['an indented quote', '   > quote\nreply', '   > quote\n\nreply'],
    ['four spaces is not a quote', '    > code\nreply', '    > code\nreply'],
    ['a quote as the last line', 'reply\n> quote', 'reply\n> quote'],
    ['a fence after a quote', '> quote\n```\ncode\n```', '> quote\n\n```\ncode\n```'],
    ['a quote marker inside a fence', '```\n> not a quote\nline\n```', '```\n> not a quote\nline\n```'],
    ['a tilde fence', '~~~\n> x\ny\n~~~\n> q\nr', '~~~\n> x\ny\n~~~\n> q\n\nr'],
    ['a fence inside a quote', '> ```\n> code\n> ```\nreply', '> ```\n> code\n> ```\n\nreply'],
    ['two quotes', '> a\nb\n> c\nd', '> a\n\nb\n> c\n\nd'],
  ])('%s', (_name, input, expected) => {
    expect(endQuotesAtPlainLines(input)).toBe(expected);
  });

  it('keeps the reply out of the rendered quote', () => {
    const { container } = render(<>{renderMarkdownish(endQuotesAtPlainLines('> bkah blah blah\nmore content'), 'surface')}</>);
    const quote = container.querySelector('blockquote');
    expect(quote?.textContent?.trim()).toBe('bkah blah blah');
    expect(container.textContent).toContain('more content');
    expect(quote?.textContent).not.toContain('more content');
  });
});
