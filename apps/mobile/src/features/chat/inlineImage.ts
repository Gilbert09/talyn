import type { WorkbenchAttachment } from '@talyn/shared';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import type { ImageDraft } from './attachments';

/** Web's `downscaleImage` size. A phone photo shrinks to a few hundred kilobytes. */
export const INLINE_MAX_SIDE = 1600;
/**
 * The server reads JSON bodies up to 2 MB. A new session sends its images in
 * the JSON of its first message, so all of them together stay under this.
 */
export const MAX_INLINE_BASE64 = 1_800_000;

export const jpegName = (name: string) => `${name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`;

/**
 * Makes one picked image into an inline attachment: no side longer than
 * 1600 px, saved as JPEG. A new session has no sandbox yet, so it cannot
 * take an upload.
 */
export async function inlineImage(uri: string, name: string): Promise<WorkbenchAttachment> {
  const context = ImageManipulator.manipulate(uri, { maxWidth: INLINE_MAX_SIDE, maxHeight: INLINE_MAX_SIDE });
  try {
    const image = await context.renderAsync();
    try {
      const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
      if (!saved.base64) throw new Error('The image could not be read.');
      return { name: jpegName(name), mimeType: 'image/jpeg', dataBase64: saved.base64 };
    } finally { image.release(); }
  } finally { context.release(); }
}

/** The Base64 size of the ready inline images. */
export const inlineSize = (drafts: ImageDraft[]) =>
  drafts.reduce((total, draft) => total + (draft.status === 'ready' ? draft.attachment?.dataBase64?.length ?? 0 : 0), 0);
