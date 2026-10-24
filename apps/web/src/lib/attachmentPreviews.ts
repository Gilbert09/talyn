const LIMIT = 50;
const previews = new Map<string, { url: string; objectUrl: boolean }>();

function remember(path: string, url: string, objectUrl: boolean): void {
  const previous = previews.get(path);
  if (previous?.objectUrl && previous.url !== url) URL.revokeObjectURL(previous.url);
  previews.delete(path);
  previews.set(path, { url, objectUrl });
  while (previews.size > LIMIT) {
    const oldest = previews.keys().next().value;
    if (oldest === undefined) break;
    const evicted = previews.get(oldest);
    if (evicted?.objectUrl) URL.revokeObjectURL(evicted.url);
    previews.delete(oldest);
  }
}

export function rememberAttachmentPreview(path: string, dataUrl: string): void {
  remember(path, dataUrl, false);
}

export function rememberAttachmentBlob(path: string, blob: Blob): string {
  const url = URL.createObjectURL(blob);
  remember(path, url, true);
  return url;
}

export function attachmentPreview(path: string): string | null {
  const entry = previews.get(path);
  if (!entry) return null;
  previews.delete(path);
  previews.set(path, entry);
  return entry.url;
}

/**
 * Fetch an attachment's bytes and keep a preview URL for them. Null on any
 * failure, so the caller shows the file name as plain text instead of a broken
 * image. Production can answer 404 here: the raw attachment route is newer
 * than the rest of the sessions API.
 */
export async function loadAttachmentPreview(
  fetchBlob: (path: string, mimeType: string) => Promise<Blob>,
  path: string,
  mimeType: string
): Promise<string | null> {
  const cached = attachmentPreview(path);
  if (cached) return cached;
  try {
    const blob = await fetchBlob(path, mimeType);
    if (!blob || blob.size === 0) return null;
    return rememberAttachmentBlob(path, blob);
  } catch {
    return null;
  }
}
