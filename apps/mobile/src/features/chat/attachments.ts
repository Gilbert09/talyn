import type { SendWorkbenchMessageInput, WorkbenchAttachment } from '@talyn/shared';

/** The types the upload route accepts (`workbenchAttachments.ts` in the backend). */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
/** The upload route's own limit. Web has no smaller one. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface PickedImage { uri: string; fileName?: string | null; mimeType?: string | null; fileSize?: number | null }

/** One image in the composer. `attachment` is what the server returned, and is what gets sent. */
export interface ImageDraft {
  id: string;
  uri: string;
  name: string;
  mimeType: string;
  status: 'uploading' | 'ready' | 'error';
  attachment?: WorkbenchAttachment;
  error?: string;
}

const EXTENSIONS: Record<string, (typeof IMAGE_TYPES)[number]> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const FILE_EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export function imageMimeType(image: Pick<PickedImage, 'uri' | 'fileName' | 'mimeType'>): string | null {
  const declared = image.mimeType?.toLowerCase().replace('image/jpg', 'image/jpeg');
  if (declared && (IMAGE_TYPES as readonly string[]).includes(declared)) return declared;
  if (declared && declared !== 'application/octet-stream') return null;
  const extension = (image.fileName ?? image.uri).split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return EXTENSIONS[extension] ?? null;
}

/** A name the server keeps: the picker's own, or "photo-N" with the right extension. */
export function imageName(image: Pick<PickedImage, 'fileName'>, mimeType: string, index: number): string {
  const name = image.fileName?.trim();
  return name ? name : `photo-${index + 1}.${FILE_EXTENSION[mimeType] ?? 'jpg'}`;
}

export type ImageCheck = { ok: true; name: string; mimeType: string } | { ok: false; name: string; reason: string };

/** Checks one picked image against the server's types and size before any upload starts. */
export function checkImage(image: PickedImage, index: number): ImageCheck {
  const mimeType = imageMimeType(image);
  const name = imageName(image, mimeType ?? 'image/jpeg', index);
  if (!mimeType) return { ok: false, name, reason: 'Only PNG, JPEG, WebP and GIF images can be attached.' };
  if (typeof image.fileSize === 'number' && image.fileSize > MAX_IMAGE_BYTES) return { ok: false, name, reason: 'The image is larger than 10 MB.' };
  return { ok: true, name, mimeType };
}

export const imageErrorMessage = (name: string, reason: string) => `${name}: ${reason}`;

/** Same shape as web: the text, plus the uploaded attachments when there are any. */
export function buildMessageInput(text: string, drafts: ImageDraft[]): SendWorkbenchMessageInput {
  const attachments = drafts.flatMap((draft) => draft.status === 'ready' && draft.attachment ? [draft.attachment] : []);
  return attachments.length ? { text, attachments } : { text };
}

export interface SendGate { text: string; drafts: ImageDraft[] }
/** The server rejects a message with no text, so images alone cannot be sent. */
export function sendBlock({ text, drafts }: SendGate): string | null {
  if (drafts.some((draft) => draft.status === 'uploading')) return 'Waiting for the images to upload.';
  if (drafts.some((draft) => draft.status === 'error')) return 'Remove the images that failed, or try them again.';
  if (drafts.length > 0 && !text.trim()) return 'Add a message to send with the images.';
  return null;
}

export function attachmentUrl(baseUrl: string, workbenchId: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/workbenches/${encodeURIComponent(workbenchId)}/attachments/raw?path=${encodeURIComponent(path)}`;
}

export interface MessageImage { name: string; mimeType: string; path?: string }
/** The attachments a user message event records, in order. */
export function eventAttachments(raw: unknown): MessageImage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const item = value as Partial<MessageImage> | null;
    return item && typeof item.name === 'string' && typeof item.mimeType === 'string'
      ? [{ name: item.name, mimeType: item.mimeType, ...(typeof item.path === 'string' ? { path: item.path } : {}) }] : [];
  });
}
export const isImage = (attachment: MessageImage) => attachment.mimeType.startsWith('image/');
