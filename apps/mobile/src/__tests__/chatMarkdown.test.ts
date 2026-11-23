import {
  chunkInlines, chunkRanges, chunkText, decodeEntities, inlineText, MARKDOWN_TEXT_LIMIT, parseMarkdown, safeImageUrl, stripHtml,
  TEXT_CHUNK_CHARS, TEXT_CHUNK_LINES, type MdBlock, type MdInline,
} from '../lib/markdown';

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
    ['an image', '![Diagram](https://example.com/a.png)', { type: 'image', src: 'https://example.com/a.png', alt: 'Diagram' }],
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

describe('markdown images', () => {
  const SHOT = 'https://github.com/user-attachments/assets/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
  const blocks = (text: string) => parseMarkdown(text).blocks;
  const para = (text: string): MdBlock => ({ type: 'paragraph', children: [{ type: 'text', text }] });

  it.each<[string, string, MdBlock[]]>([
    ['a markdown image with no alt text', `![](${SHOT})`, [{ type: 'image', src: SHOT, alt: '' }]],
    ['a GitHub screenshot tag', `<img width="1096" height="1280" alt="Screenshot 2026-11-19" src="${SHOT}" />`,
      [{ type: 'image', src: SHOT, alt: 'Screenshot 2026-11-19', width: 1096, height: 1280 }]],
    ['single quotes and entities', `<img alt='a &amp; b' src='${SHOT}?x=1&amp;y=2' width='300px' height='50%'>`,
      [{ type: 'image', src: `${SHOT}?x=1&y=2`, alt: 'a & b', width: 300 }]],
    ['an unquoted source', `<img src=${SHOT}>`, [{ type: 'image', src: SHOT, alt: '' }]],
    ['a centred paragraph', `<p align="center"><img src="${SHOT}" alt="Centred" /></p>`, [{ type: 'image', src: SHOT, alt: 'Centred' }]],
    ['a centred paragraph with a linked image', `<p align="center">\n  <a href="https://example.com"><img src="${SHOT}" alt="Logo"></a>\n</p>`,
      [{ type: 'image', src: SHOT, alt: 'Logo' }]],
    ['two tags with text between', `<img src="${SHOT}" alt="Before">\nthen\n<img src="${SHOT}" alt="After">`,
      [{ type: 'image', src: SHOT, alt: 'Before' }, para('then'), { type: 'image', src: SHOT, alt: 'After' }]],
    ['an inline tag in a paragraph', `Before <img src="${SHOT}" alt="Shot"> after`,
      [para('Before'), { type: 'image', src: SHOT, alt: 'Shot' }, para('after')]],
    ['a markdown image between lines', `Before\n![Shot](${SHOT})\nAfter`, [para('Before'), { type: 'image', src: SHOT, alt: 'Shot' }, para('After')]],
    ['an image in a link', `[![Shot](${SHOT})](https://example.com/full)`, [{ type: 'image', src: SHOT, alt: 'Shot' }]],
    ['an image tag in a link', `<a href="https://example.com/full"><img src="${SHOT}" alt="Shot"></a>`, [{ type: 'image', src: SHOT, alt: 'Shot' }]],
    ['an image in a link with text', `[See ![Shot](${SHOT})](https://example.com/full)`, [
      { type: 'paragraph', children: [{ type: 'link', href: 'https://example.com/full', children: [{ type: 'text', text: 'See' }] }] },
      { type: 'image', src: SHOT, alt: 'Shot' }]],
    ['an image in bold text', `**Look ![Shot](${SHOT})**`, [
      { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', text: 'Look' }] }] }, { type: 'image', src: SHOT, alt: 'Shot' }]],
    ['two images in one paragraph', `![One](${SHOT}) ![Two](${SHOT})`, [{ type: 'image', src: SHOT, alt: 'One' }, { type: 'image', src: SHOT, alt: 'Two' }]],
    ['a javascript source, keeping the alt text', '![Bad](javascript:alert(1))', [para('Bad')]],
    ['a data source', '<img src="data:image/png;base64,AAAA" alt="Inline data">', [para('Inline data')]],
    ['a relative source', 'See ![Local](./shot.png) here', [para('See Local here')]],
    ['a source with credentials', `<img src="https://user:secret@example.com/a.png" alt="Secret">`, [para('Secret')]],
    ['a source with no alt text that is dropped', '<img src="file:///etc/passwd">', []],
    ['an SVG badge, which stays a link', '![CI](https://img.shields.io/badge/ci-passing-green.svg)', [{ type: 'paragraph', children: [
      { type: 'link', href: 'https://img.shields.io/badge/ci-passing-green.svg', children: [{ type: 'text', text: 'CI' }] }] }]],
  ])('maps %s', (_name, source, expected) => expect(blocks(source)).toEqual(expected));

  it('keeps an image in a list item as a block of the item', () => {
    const [list] = blocks(`- Before\n  ![Shot](${SHOT})`);
    if (list.type !== 'list') throw new Error('not a list');
    expect(list.items[0].children).toEqual([para('Before'), { type: 'image', src: SHOT, alt: 'Shot' }]);
  });

  it.each([
    ['a markdown image', `![Shot](${SHOT})`],
    ['an image tag', `<img src="${SHOT}" alt="Shot">`],
  ])('keeps %s in a table cell as a link', (_name, image) => {
    const table = blocks(`| Before | After |\n| --- | --- |\n| ${image} | text |`)[0];
    if (table.type !== 'table') throw new Error('not a table');
    expect(table.rows[0][0]).toEqual([{ type: 'link', href: SHOT, children: [{ type: 'text', text: 'Shot' }] }]);
  });

  it('keeps an image in a table cell with an unsafe source as its alt text', () => {
    const table = blocks('| A |\n| --- |\n| ![Bad](javascript:x) |')[0];
    if (table.type !== 'table') throw new Error('not a table');
    expect(table.rows[0][0]).toEqual([{ type: 'text', text: 'Bad' }]);
  });

  it('keeps an image in a heading as a link', () => {
    expect(blocks(`## Result ![Shot](${SHOT})`)).toEqual([{ type: 'heading', depth: 2, children: [
      { type: 'text', text: 'Result ' }, { type: 'link', href: SHOT, children: [{ type: 'text', text: 'Shot' }] }] }]);
  });

  it('keeps the summary line bold and the images of a details block in order', () => {
    expect(blocks(`<details><summary>Screenshots</summary>\n<img src="${SHOT}" alt="One">\nNotes\n</details>`)).toEqual([
      { type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', text: 'Screenshots' }] }] },
      { type: 'image', src: SHOT, alt: 'One' }, para('Notes')]);
  });

  it.each([
    ['https://example.com/a.png', 'https://example.com/a.png'],
    ['http://example.com/a.png', 'http://example.com/a.png'],
    ['javascript:alert(1)', null],
    ['data:image/png;base64,AAAA', null],
    ['https://user:pass@example.com/a.png', null],
    ['https://example.com/a b.png', null],
    [`https://example.com/${'a'.repeat(4100)}`, null],
    ['not a url', null],
  ])('accepts only safe image sources: %s', (source, expected) => expect(safeImageUrl(source)).toBe(expected));
});

describe('long text in chunks for native Text views', () => {
  /** The text again from its chunks: each cut drops one newline or space, unless it is a hard cut. */
  const joined = (text: string, ranges: Array<[number, number]>) => ranges.map(([start, end], index) =>
    text.slice(start, end) + (index < ranges.length - 1 ? text.slice(end, ranges[index + 1][0]) : '')).join('');
  const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(' ');
  const lines = (count: number, line = 'a line of text') => Array.from({ length: count }, (_, index) => `${index}: ${line}`).join('\n');

  it.each([
    ['empty text', ''],
    ['short text', 'Hello world'],
    ['text at the character limit', 'x'.repeat(TEXT_CHUNK_CHARS)],
    ['text at the line limit', lines(TEXT_CHUNK_LINES)],
  ])('keeps %s as one chunk', (_name, text) => {
    expect(chunkRanges(text)).toEqual([[0, text.length]]);
    expect(chunkText(text)).toEqual([text]);
  });

  it.each([
    ['many short lines', lines(500)],
    ['few long lines', lines(30, words(80))],
    ['one long line of words', words(3000)],
    ['one long word', 'x'.repeat(10000)],
    ['blank lines', `${'para\n\n'.repeat(300)}end`],
    ['a brief with headings and bullets', Array.from({ length: 80 }, (_, index) => `## Step ${index}\n- ${words(20)}\n- ${words(15)}`).join('\n')],
  ])('cuts %s into chunks under the limits and loses nothing', (_name, text) => {
    const ranges = chunkRanges(text);
    expect(ranges.length).toBeGreaterThan(1);
    for (const [start, end] of ranges) {
      expect(end).toBeGreaterThan(start);
      expect(end - start).toBeLessThanOrEqual(TEXT_CHUNK_CHARS);
      expect(text.slice(start, end).split('\n').length).toBeLessThanOrEqual(TEXT_CHUNK_LINES);
    }
    expect(joined(text, ranges)).toBe(text);
  });

  it('cuts at a newline before a space, and drops the newline', () => {
    const text = `${words(150)}\n${words(150)}`;
    expect(chunkText(text)).toEqual([words(150), words(150)]);
  });

  it('cuts at a space when a line is longer than the limit', () => {
    const chunks = chunkText(words(1000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toBe(words(1000));
    for (const chunk of chunks) expect(chunk).toMatch(/^word\d+( word\d+)*$/);
  });

  it('does not cut code at a space', () => {
    const line = `const value = ${'1 + '.repeat(600)}1;`;
    const chunks = chunkText(line, { chars: 1000, wrap: false });
    expect(chunks.map((chunk) => chunk.length)).toEqual([1000, 1000, line.length - 2000]);
    expect(chunks.join('')).toBe(line);
  });

  it('honours the line limit for code', () => {
    const code = lines(130, 'x');
    const chunks = chunkText(code, { lines: 60, wrap: false });
    expect(chunks.map((chunk) => chunk.split('\n').length)).toEqual([60, 60, 10]);
    expect(chunks.join('\n')).toBe(code);
  });

  it('does not split a surrogate pair at a hard cut', () => {
    const text = `${'x'.repeat(9)}😀${'y'.repeat(20)}`;
    const chunks = chunkText(text, { chars: 10 });
    expect(chunks.join('')).toBe(text);
    expect(chunks[0]).toBe('x'.repeat(9));
    expect(chunks[1].startsWith('😀')).toBe(true);
  });

  it('gives back the same nodes for a short paragraph', () => {
    const nodes: MdInline[] = [{ type: 'text', text: 'short' }];
    expect(chunkInlines(nodes)).toEqual([nodes]);
    expect(chunkInlines(nodes)[0]).toBe(nodes);
  });

  it('keeps bold, links and code on each part of a long paragraph', () => {
    const nodes: MdInline[] = [
      { type: 'text', text: 'Start ' },
      { type: 'strong', children: [{ type: 'text', text: 'bold one two three four five six' }] },
      { type: 'text', text: ' then ' },
      { type: 'link', href: 'https://example.com', children: [{ type: 'text', text: 'a link with words' }] },
      { type: 'br' },
      { type: 'code', text: 'npm test' },
      { type: 'text', text: ' end' },
    ];
    const chunks = chunkInlines(nodes, { chars: 20 });
    expect(chunks.length).toBeGreaterThan(2);
    const text = inlineText(nodes);
    expect(joined(text, chunkRanges(text, { chars: 20 }))).toBe(text);
    expect(chunks.map(inlineText)).toEqual(chunkText(text, { chars: 20 }));
    // The bold text is cut in the middle: both parts stay bold.
    const bold = chunks.flatMap((chunk) => chunk.filter((node) => node.type === 'strong')).map((node) => inlineText([node]));
    expect(bold.length).toBeGreaterThan(1);
    expect(bold.join(' ')).toBe('bold one two three four five six');
    // The link and the code keep their type and target.
    const flat = chunks.flat();
    expect(flat.filter((node) => node.type === 'link').every((node) => node.type === 'link' && node.href === 'https://example.com')).toBe(true);
    expect(flat).toContainEqual({ type: 'code', text: 'npm test' });
  });

  it('cuts a long paragraph from a real brief, with single newlines only', () => {
    const brief = Array.from({ length: 120 }, (_, index) => `- Point ${index}: ${words(12)}`).join('\n');
    const paragraph = parseMarkdown(`Intro line\n${brief}`.replace(/^- /gm, '')).blocks;
    expect(paragraph).toHaveLength(1);
    if (paragraph[0].type !== 'paragraph') throw new Error('not a paragraph');
    const chunks = chunkInlines(paragraph[0].children);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map(inlineText).join('\n')).toBe(inlineText(paragraph[0].children));
  });
});
