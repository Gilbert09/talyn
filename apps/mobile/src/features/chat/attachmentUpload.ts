import { workbenchAttachmentMaxBytes, type WorkbenchAttachment } from '@talyn/shared';
import { getApiBaseUrl } from '@talyn/client/native';

import { oversizeReason } from './attachments';

/**
 * Uploads one image or video into the session, like web's `uploadAttachment`. The
 * mobile client entry has no such call, so this sends the same request: the
 * raw bytes with the file type, and the name in `X-Attachment-Name`.
 */
export async function uploadAttachment(
  workbenchId: string,
  file: { uri: string; name: string; mimeType: string },
  getToken: () => Promise<string | null>,
): Promise<WorkbenchAttachment> {
  const blob = await (await fetch(file.uri)).blob();
  if (blob.size > workbenchAttachmentMaxBytes(file.mimeType)) throw new Error(oversizeReason(file.mimeType));
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
