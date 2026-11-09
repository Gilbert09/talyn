import type { WorkbenchAttachment } from '@talyn/shared';
import { getApiBaseUrl } from '@talyn/client/native';

import { MAX_IMAGE_BYTES } from './attachments';

/**
 * Uploads one image into the session, like web's `uploadAttachment`. The
 * mobile client entry has no such call, so this sends the same request: the
 * raw bytes with the image type, and the name in `X-Attachment-Name`.
 */
export async function uploadImage(
  workbenchId: string,
  file: { uri: string; name: string; mimeType: string },
  getToken: () => Promise<string | null>,
): Promise<WorkbenchAttachment> {
  const blob = await (await fetch(file.uri)).blob();
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('The image is larger than 10 MB.');
  const token = await getToken();
  const response = await fetch(`${getApiBaseUrl().replace(/\/+$/, '')}/api/v1/workbenches/${encodeURIComponent(workbenchId)}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': file.mimeType, 'X-Attachment-Name': encodeURIComponent(file.name), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: blob,
  });
  const body = await response.json().catch(() => null) as { success?: boolean; data?: WorkbenchAttachment; error?: string } | null;
  if (!response.ok || !body?.success || !body.data) throw new Error(body?.error ?? 'The upload failed.');
  return body.data;
}
