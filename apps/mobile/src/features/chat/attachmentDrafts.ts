import { useCallback, useState } from 'react';

import type { ImageDraft } from './attachments';

/**
 * Images waiting in a composer, kept for the app session so leaving a chat
 * and coming back does not lose them. The workflow store's local state is
 * text only, so they live here, keyed by chat.
 */
const drafts = new Map<string, ImageDraft[]>();

export const readImageDrafts = (chatId: string): ImageDraft[] => drafts.get(chatId) ?? [];
export function writeImageDrafts(chatId: string, next: ImageDraft[]) {
  if (next.length) drafts.set(chatId, next); else drafts.delete(chatId);
}
export const resetImageDrafts = () => drafts.clear();

export function useImageDrafts(chatId: string) {
  const [items, setItems] = useState(() => readImageDrafts(chatId));
  const [owner, setOwner] = useState(chatId);
  if (owner !== chatId) { setOwner(chatId); setItems(readImageDrafts(chatId)); }
  const update = useCallback((change: (current: ImageDraft[]) => ImageDraft[]) => {
    // Written outside the state updater so a late upload still lands after the composer unmounts.
    const next = change(readImageDrafts(chatId));
    writeImageDrafts(chatId, next);
    setItems(next);
  }, [chatId]);
  return [items, update] as const;
}
