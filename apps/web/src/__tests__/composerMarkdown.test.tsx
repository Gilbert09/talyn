import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { composerMarkdown, type ComposerLine } from '@talyn/shared';
import { MarkdownTextarea } from '../components/workbench/MarkdownTextarea';

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
