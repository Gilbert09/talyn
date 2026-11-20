/**
 * "New session from selection": the person selects part of a transcript and
 * starts a new session with that text quoted in the composer. They type the
 * task under the quote. One format, so desktop, web and mobile quote the same.
 */

/** The longest selection that is quoted in full. A longer one is cut and ends with an ellipsis. */
export const TRANSCRIPT_QUOTE_MAX_CHARS = 8000;

/** The selection as clean text: no carriage returns, no blank lines at the ends, no runs of blank lines. */
export function cleanTranscriptSelection(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/**
 * The composer text for a new session from a selection: the text as a
 * Markdown quote, then a blank line for the task. Empty when the selection has
 * no text.
 */
export function transcriptQuotePrompt(selection: string): string {
  let text = cleanTranscriptSelection(selection);
  if (!text.trim()) return '';
  if (text.length > TRANSCRIPT_QUOTE_MAX_CHARS) text = `${text.slice(0, TRANSCRIPT_QUOTE_MAX_CHARS).trimEnd()}…`;
  const quoted = text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  return `${quoted}\n\n`;
}
