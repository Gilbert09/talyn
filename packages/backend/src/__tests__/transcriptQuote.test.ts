import { describe, expect, it } from 'vitest';
import { cleanTranscriptSelection, TRANSCRIPT_QUOTE_MAX_CHARS, transcriptQuotePrompt } from '@talyn/shared';

describe('cleanTranscriptSelection', () => {
  it.each([
    ['plain text', 'hello', 'hello'],
    ['carriage returns', 'a\r\nb\rc', 'a\nb\nc'],
    ['non-breaking spaces', 'a\u00a0b', 'a b'],
    ['trailing spaces on lines', 'a  \nb\t', 'a\nb'],
    ['blank lines at the ends', '\n\n  \nhello\n\n', 'hello'],
    ['runs of blank lines', 'a\n\n\n\nb', 'a\n\nb'],
    ['leading indentation kept', '  code()\n    more()', '  code()\n    more()'],
    ['only whitespace', ' \n\t\n ', ''],
  ])('%s', (_name, input, expected) => {
    expect(cleanTranscriptSelection(input)).toBe(expected);
  });
});

describe('transcriptQuotePrompt', () => {
  it.each([
    ['one line', 'Fix the flaky test', '> Fix the flaky test\n\n'],
    ['several lines', 'one\ntwo', '> one\n> two\n\n'],
    ['a blank line inside', 'one\n\ntwo', '> one\n>\n> two\n\n'],
    ['surrounding whitespace', '\n  indented\n\n', '>   indented\n\n'],
    ['Windows line endings', 'one\r\ntwo\r\n', '> one\n> two\n\n'],
    ['empty', '', ''],
    ['only whitespace', '  \n \n', ''],
    ['a quote already', '> quoted', '> > quoted\n\n'],
  ])('%s', (_name, input, expected) => {
    expect(transcriptQuotePrompt(input)).toBe(expected);
  });

  it('keeps a selection at the limit whole', () => {
    const text = 'x'.repeat(TRANSCRIPT_QUOTE_MAX_CHARS);
    expect(transcriptQuotePrompt(text)).toBe(`> ${text}\n\n`);
  });

  it('cuts a longer selection and marks the cut', () => {
    const text = 'x'.repeat(TRANSCRIPT_QUOTE_MAX_CHARS + 50);
    const prompt = transcriptQuotePrompt(text);
    expect(prompt).toBe(`> ${'x'.repeat(TRANSCRIPT_QUOTE_MAX_CHARS)}…\n\n`);
  });

  it('does not leave trailing spaces before the ellipsis', () => {
    const text = `${'x'.repeat(TRANSCRIPT_QUOTE_MAX_CHARS - 2)}   tail`;
    expect(transcriptQuotePrompt(text)).toBe(`> ${'x'.repeat(TRANSCRIPT_QUOTE_MAX_CHARS - 2)}…\n\n`);
  });
});
