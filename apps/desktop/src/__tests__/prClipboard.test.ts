import { escapeHtml, prMarkdownLink } from '../renderer/lib/prClipboard';

describe('escapeHtml', () => {
  it.each<[string, string]>([
    ['plain', 'plain'],
    ['a & b', 'a &amp; b'],
    ['<script>', '&lt;script&gt;'],
    ['say "hi"', 'say &quot;hi&quot;'],
    ['a<b>&"c', 'a&lt;b&gt;&amp;&quot;c'],
  ])('escapes %j → %j', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  it('escapes & before introducing new entities (no double-escaping)', () => {
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });
});

describe('prMarkdownLink', () => {
  it('builds a markdown link and a rich anchor', () => {
    expect(prMarkdownLink('Fix the thing', 'https://github.com/o/r/pull/1')).toEqual({
      markdown: '[Fix the thing](https://github.com/o/r/pull/1)',
      html: '<a href="https://github.com/o/r/pull/1">Fix the thing</a>',
    });
  });

  it.each<[string, string]>([
    ['', '(no title)'],
    [undefined as unknown as string, '(no title)'],
  ])('falls back to "(no title)" for empty title (%j)', (title, shown) => {
    const { markdown, html } = prMarkdownLink(title, 'https://x/1');
    expect(markdown).toBe(`[${shown}](https://x/1)`);
    expect(html).toBe(`<a href="https://x/1">${shown}</a>`);
  });

  it('escapes HTML-significant chars in the rich anchor only', () => {
    const { markdown, html } = prMarkdownLink('A & B <tag>', 'https://x/?a=1&b=2');
    // Markdown keeps the raw title/url (Markdown is not HTML).
    expect(markdown).toBe('[A & B <tag>](https://x/?a=1&b=2)');
    // HTML escapes both the title text and the href.
    expect(html).toBe('<a href="https://x/?a=1&amp;b=2">A &amp; B &lt;tag&gt;</a>');
  });
});
