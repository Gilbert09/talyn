import { decodeEntities, inlineText, MARKDOWN_TEXT_LIMIT, parseMarkdown, stripHtml, type MdBlock } from '../lib/markdown';

const first = (text: string) => parseMarkdown(text).blocks[0];

describe('markdown to native nodes', () => {
  it.each<[string, string, MdBlock]>([
    ['a paragraph', 'Hello world', { type: 'paragraph', children: [{ type: 'text', text: 'Hello world' }] }],
    ['bold and italic', '**bold** and _it_', { type: 'paragraph', children: [
      { type: 'strong', children: [{ type: 'text', text: 'bold' }] }, { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'it' }] }] }],
    ['strikethrough', '~~gone~~', { type: 'paragraph', children: [{ type: 'del', children: [{ type: 'text', text: 'gone' }] }] }],
    ['inline code', 'run `npm test` now', { type: 'paragraph', children: [
      { type: 'text', text: 'run ' }, { type: 'code', text: 'npm test' }, { type: 'text', text: ' now' }] }],
    ['inline code keeps angle brackets', '`a < b`', { type: 'paragraph', children: [{ type: 'code', text: 'a < b' }] }],
    ['a link', '[Docs](https://example.com/docs)', { type: 'paragraph', children: [
      { type: 'link', href: 'https://example.com/docs', children: [{ type: 'text', text: 'Docs' }] }] }],
    ['a bare URL', 'see https://example.com', { type: 'paragraph', children: [
      { type: 'text', text: 'see ' }, { type: 'link', href: 'https://example.com', children: [{ type: 'text', text: 'https://example.com' }] }] }],
    ['an image as a link', '![Diagram](https://example.com/a.png)', { type: 'paragraph', children: [
      { type: 'link', href: 'https://example.com/a.png', children: [{ type: 'text', text: 'Diagram' }] }] }],
    ['a heading', '## Summary', { type: 'heading', depth: 2, children: [{ type: 'text', text: 'Summary' }] }],
    ['a fenced code block', '```ts\nconst a = 1;\n```', { type: 'code', lang: 'ts', text: 'const a = 1;' }],
    ['a code block without a language', '```\nplain\n```', { type: 'code', lang: '', text: 'plain' }],
    ['a rule', '---', { type: 'hr' }],
    ['a blockquote', '> quoted', { type: 'blockquote', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'quoted' }] }] }],
    ['entities', 'a &amp; b &lt;c&gt;', { type: 'paragraph', children: [{ type: 'text', text: 'a & b <c>' }] }],
    ['a hard break', 'one  \ntwo', { type: 'paragraph', children: [{ type: 'text', text: 'one' }, { type: 'br' }, { type: 'text', text: 'two' }] }],
  ])('maps %s', (_name, source, expected) => expect(first(source)).toEqual(expected));

  it.each([
    ['bullets', '- one\n- two', false, 1, ['one', 'two']],
    ['numbers from a start', '3. three\n4. four', true, 3, ['three', 'four']],
  ] as const)('maps a list of %s', (_name, source, ordered, start, texts) => {
    const block = first(source);
    expect(block).toMatchObject({ type: 'list', ordered, start });
    if (block.type !== 'list') throw new Error('not a list');
    expect(block.items.map((item) => item.children[0].type === 'paragraph' ? inlineText(item.children[0].children) : '')).toEqual(texts);
  });

  it('nests lists and keeps task state', () => {
    const block = first('- [x] done\n  - child\n- [ ] todo');
    if (block.type !== 'list') throw new Error('not a list');
    expect(block.items.map((item) => item.checked)).toEqual([true, false]);
    expect(block.items[0].children[1]).toMatchObject({ type: 'list', items: [{ checked: null }] });
  });

  it('maps a table with alignment', () => {
    expect(first('| Name | Count |\n|:--|--:|\n| a | 1 |\n| b | 2 |')).toEqual({
      type: 'table', align: ['left', 'right'],
      header: [[{ type: 'text', text: 'Name' }], [{ type: 'text', text: 'Count' }]],
      rows: [[[{ type: 'text', text: 'a' }], [{ type: 'text', text: '1' }]], [[{ type: 'text', text: 'b' }], [{ type: 'text', text: '2' }]]],
    });
  });

  it.each([
    ['a details block', '<details><summary>More</summary>\n\nHidden text\n</details>', ['More', 'Hidden text']],
    ['a script tag', '<script>alert(1)</script>', ['alert(1)']],
    ['a comment', 'Before <!-- note --> after', ['Before  after']],
    ['an inline tag', 'Press <kbd>Enter</kbd>', ['Press Enter']],
  ])('strips HTML from %s and keeps its text', (_name, source, texts) => {
    const words = parseMarkdown(source).blocks.map((block) => block.type === 'paragraph' ? inlineText(block.children) : '');
    expect(words).toEqual(texts);
  });

  it('bolds a summary line', () => {
    expect(first('<details><summary>More</summary>')).toEqual({ type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', text: 'More' }] }] });
  });

  it.each([['', 0], ['\n\n   \n', 0]])('returns no blocks for blank text %#', (source, count) => expect(parseMarkdown(source).blocks).toHaveLength(count));

  it('caps very long text and says so', () => {
    const doc = parseMarkdown('word '.repeat(MARKDOWN_TEXT_LIMIT));
    expect(doc.truncated).toBe(true);
    expect(inlineText(doc.blocks[0].type === 'paragraph' ? doc.blocks[0].children : []).length).toBeLessThanOrEqual(MARKDOWN_TEXT_LIMIT);
  });

  it('bounds deep nesting', () => {
    expect(() => parseMarkdown(`${'> '.repeat(200)}deep`)).not.toThrow();
    expect(() => parseMarkdown(`${Array.from({ length: 60 }, (_, index) => `${'  '.repeat(index)}- level`).join('\n')}`)).not.toThrow();
  });

  it.each([
    ['&amp;&lt;&gt;&quot;&#39;', '&<>"\''],
    ['&#x41;&#66;', 'AB'],
    ['&unknown;', '&unknown;'],
  ])('decodes %s', (source, expected) => expect(decodeEntities(source)).toBe(expected));

  it.each([
    ['<b>bold</b>', 'bold'],
    ['line<br>next', 'line\nnext'],
    ['<a href="x">link</a>', 'link'],
  ])('strips %s', (source, expected) => expect(stripHtml(source)).toBe(expected));
});
