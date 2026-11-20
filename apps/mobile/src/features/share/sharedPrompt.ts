import { transcriptQuotePrompt } from '@talyn/shared';

/** What another app's share sheet hands to Talyn: `expo-share-intent`'s `ShareIntent`, only the fields used here. */
export type SharedItem = {
  text?: string | null;
  webUrl?: string | null;
  meta?: { title?: string | null } | null;
};

/**
 * The new-session composer text for an item shared into Talyn. A link shows as
 * the page title (when the app sends one) and the link. Other text shows as a
 * Markdown quote, like "New session from copied text". Both end with a blank
 * line for the task. Null when the item has no text and no link.
 */
export function sharedPrompt(item: SharedItem): string | null {
  const text = item.text?.trim() ?? '';
  const url = item.webUrl?.trim() ?? '';
  if (!text || text === url) {
    if (!url) return null;
    const title = item.meta?.title?.trim();
    return `${title && title !== url ? `${title}\n` : ''}${url}\n\n`;
  }
  const quoted = transcriptQuotePrompt(text);
  if (!quoted) return url ? `${url}\n\n` : null;
  return url && !text.includes(url) ? `${quoted}${url}\n\n` : quoted;
}

/** The analytics kind of a shared item. Analytics gets the kind and the length, never the text. */
export function sharedKind(item: SharedItem): 'link' | 'text' {
  const text = item.text?.trim() ?? '';
  const url = item.webUrl?.trim() ?? '';
  return url && (!text || text === url) ? 'link' : 'text';
}
