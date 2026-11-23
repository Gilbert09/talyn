import { useRef } from 'react';

import { attachmentName, type ImageDraft, type PickedImage } from '../chat/attachments';
import { useImageDrafts } from '../chat/attachmentDrafts';
import { inlineImage, inlineSize, jpegName, MAX_INLINE_BASE64 } from '../chat/inlineImage';

/** Why images stop a start, or null. A draft is `uploading` while it is made smaller. */
export function inlineBlock(drafts: ImageDraft[]): string | null {
  if (drafts.some((draft) => draft.status === 'uploading')) return 'Preparing the images.';
  if (drafts.some((draft) => draft.status === 'error')) return 'Remove the images that failed, or try them again.';
  if (inlineSize(drafts) > MAX_INLINE_BASE64) return 'The images are too large to send together. Remove one.';
  return null;
}

/**
 * Images in the new-work composer. Each one is made smaller on the phone and
 * goes inline with the first message, like web, because a new session has no
 * sandbox to upload into yet. They stay for the app session, keyed like the draft.
 */
export function useInlineImages(key: string) {
  const [drafts, update] = useImageDrafts(key);
  const picked = useRef(0);

  const prepare = async (draft: ImageDraft) => {
    update((current) => current.map((value) => value.id === draft.id ? { ...value, status: 'uploading', error: undefined } : value));
    try {
      const attachment = await inlineImage(draft.uri, draft.name);
      update((current) => current.map((value) => value.id === draft.id ? { ...value, status: 'ready', attachment } : value));
    } catch {
      update((current) => current.map((value) => value.id === draft.id
        ? { ...value, status: 'error', error: 'The image could not be prepared.' } : value));
    }
  };
  const add = (assets: PickedImage[]) => {
    const added: ImageDraft[] = assets.map((asset) => {
      const index = picked.current++;
      return { id: `${Date.now()}-${index}`, uri: asset.uri, name: jpegName(attachmentName(asset, 'image/jpeg', index)), mimeType: 'image/jpeg', status: 'uploading' };
    });
    if (!added.length) return;
    update((current) => [...current, ...added]);
    added.forEach((draft) => { void prepare(draft); });
  };
  const retry = (id: string) => { const draft = drafts.find((value) => value.id === id); if (draft) void prepare(draft); };
  const remove = (id: string) => update((current) => current.filter((value) => value.id !== id));
  const clear = () => update(() => []);

  return { drafts, add, retry, remove, clear, block: inlineBlock(drafts) };
}
