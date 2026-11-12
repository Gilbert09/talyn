import type { SendWorkbenchMessageInput, WorkbenchAttachment } from '@talyn/shared';

import {
  WORKBENCH_ATTACHMENT_EXTENSIONS, WORKBENCH_ATTACHMENT_FILE_EXTENSION, WORKBENCH_IMAGE_TYPES, WORKBENCH_VIDEO_TYPES,
  isWorkbenchVideoType, workbenchAttachmentMaxBytes,
} from '@talyn/shared';

/** The types the upload route accepts (`workbenchAttachments.ts` in the backend). */
const ATTACHMENT_TYPES: readonly string[] = [...WORKBENCH_IMAGE_TYPES, ...WORKBENCH_VIDEO_TYPES];
/** Names some pickers use for the same type. */
const TYPE_ALIASES: Record<string, string> = { 'image/jpg': 'image/jpeg', 'video/mov': 'video/quicktime', 'video/x-quicktime': 'video/quicktime', 'video/x-m4v': 'video/mp4' };

export interface PickedImage { uri: string; fileName?: string | null; mimeType?: string | null; fileSize?: number | null }

/** One picked image or video in the composer. `attachment` is what the server returned, and is what gets sent. */
export interface ImageDraft {
  id: string;
  uri: string;
  name: string;
  mimeType: string;
  status: 'uploading' | 'ready' | 'error';
  attachment?: WorkbenchAttachment;
  error?: string;
}

export function attachmentMimeType(image: Pick<PickedImage, 'uri' | 'fileName' | 'mimeType'>): string | null {
  const lower = image.mimeType?.toLowerCase();
  const declared = lower && (TYPE_ALIASES[lower] ?? lower);
  if (declared && ATTACHMENT_TYPES.includes(declared)) return declared;
  if (declared && declared !== 'application/octet-stream') return null;
  const extension = (image.fileName ?? image.uri).split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  return WORKBENCH_ATTACHMENT_EXTENSIONS[extension] ?? null;
}

/** A name the server keeps: the picker's own, or "photo-N" / "video-N" with the right extension. */
export function attachmentName(image: Pick<PickedImage, 'fileName'>, mimeType: string, index: number): string {
  const name = image.fileName?.trim();
  if (name) return name;
  const video = isWorkbenchVideoType(mimeType);
  return `${video ? 'video' : 'photo'}-${index + 1}.${WORKBENCH_ATTACHMENT_FILE_EXTENSION[mimeType] ?? (video ? 'mp4' : 'jpg')}`;
}

export type AttachmentCheck = { ok: true; name: string; mimeType: string } | { ok: false; name: string; reason: string };

export const oversizeReason = (mimeType: string) => isWorkbenchVideoType(mimeType) ? 'The video is larger than 50 MB.' : 'The image is larger than 10 MB.';

/** Checks one picked image or video against the server's types and size before any upload starts. */
export function checkAttachment(image: PickedImage, index: number): AttachmentCheck {
  const mimeType = attachmentMimeType(image);
  const name = attachmentName(image, mimeType ?? 'image/jpeg', index);
  if (!mimeType) return { ok: false, name, reason: 'Only PNG, JPEG, WebP and GIF images and MP4, MOV and WebM videos can be attached.' };
  if (typeof image.fileSize === 'number' && image.fileSize > workbenchAttachmentMaxBytes(mimeType)) return { ok: false, name, reason: oversizeReason(mimeType) };
  return { ok: true, name, mimeType };
}

export const imageErrorMessage = (name: string, reason: string) => `${name}: ${reason}`;

/** Same shape as web: the text, plus the uploaded attachments when there are any. */
export function buildMessageInput(text: string, drafts: ImageDraft[]): SendWorkbenchMessageInput {
  const attachments = drafts.flatMap((draft) => draft.status === 'ready' && draft.attachment ? [draft.attachment] : []);
  return attachments.length ? { text, attachments } : { text };
}

export interface SendGate { text: string; drafts: ImageDraft[] }
/** The server rejects a message with no text, so attachments alone cannot be sent. */
export function sendBlock({ text, drafts }: SendGate): string | null {
  if (drafts.some((draft) => draft.status === 'uploading')) return 'Waiting for the attachments to upload.';
  if (drafts.some((draft) => draft.status === 'error')) return 'Remove the attachments that failed, or try them again.';
  if (drafts.length > 0 && !text.trim()) return 'Add a message to send with the attachments.';
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
export const isVideo = (attachment: MessageImage) => attachment.mimeType.startsWith('video/');
