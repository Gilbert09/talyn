/**
 * PR link copy, as on web (`prTableShared.tsx`, `lib/prClipboard.ts`): the plain URL is the default, and
 * the Markdown link is the second choice. A phone clipboard holds plain text, so the Markdown is the text.
 */
export function prMarkdownLink(title: string, url: string): string {
  return `[${title || '(no title)'}](${url})`;
}

export type PrLinkActionKind = 'copy_link' | 'copy_markdown' | 'share' | 'open';

export const PR_LINK_ACTION_LABEL: Record<PrLinkActionKind, string> = {
  copy_link: 'Copy link',
  copy_markdown: 'Copy as Markdown link',
  share: 'Share',
  open: 'Open on GitHub',
};

/** The long-press menu on a PR, in order. No safe URL means no menu. */
export function prLinkActions(url: string | null): PrLinkActionKind[] {
  return url ? ['copy_link', 'copy_markdown', 'share', 'open'] : [];
}

/** What a copy writes, and the toast it shows. */
export function prCopyText(kind: 'copy_link' | 'copy_markdown', title: string, url: string): { text: string; done: string } {
  return kind === 'copy_link' ? { text: url, done: 'Link copied.' } : { text: prMarkdownLink(title, url), done: 'Markdown link copied.' };
}
