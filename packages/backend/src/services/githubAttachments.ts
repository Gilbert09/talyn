/**
 * Images that people paste into a PR description or comment are stored as
 * GitHub attachments: `https://github.com/user-attachments/assets/<uuid>`
 * (and the older `https://github.com/<owner>/<repo>/assets/<id>/<uuid>`).
 * For a private repository those URLs answer 404 without a github.com browser
 * session, and the web app's CSP does not allow `github.com` images at all.
 *
 * GitHub's rendered HTML (`bodyHTML`) carries the same image as a signed
 * `private-user-images.githubusercontent.com/...-<uuid>.<ext>?jwt=...` URL that
 * loads with no session. The JWT is valid for about five minutes, so a signed
 * body is for a live response only: never persist it, never compare it.
 *
 * Only image positions are rewritten (`![alt](url)` and `<img src="url">`).
 * A bare attachment link stays as it is, because a person can click it long
 * after the signature has expired.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ATTACHMENT = `https://github\\.com/(?:user-attachments/assets|[\\w.-]+/[\\w.-]+/assets/\\d+)/(${UUID})`;

/** An attachment URL in an image position. Group 1 is the prefix, 2 the URL, 3 the uuid. */
const IMAGE_ATTACHMENT = new RegExp(
  `(src\\s*=\\s*["']?|!\\[[^\\]\\n]*\\]\\(\\s*<?)(${ATTACHMENT})`,
  'gi'
);

const SIGNED_SRC = new RegExp(
  `https://private-user-images\\.githubusercontent\\.com/[^"'\\s<>]*?(${UUID})[^"'\\s<>]*`,
  'gi'
);

/** True when the markdown shows at least one GitHub attachment as an image. */
export function hasAttachmentImages(markdown: string | null | undefined): boolean {
  if (!markdown) return false;
  IMAGE_ATTACHMENT.lastIndex = 0;
  return IMAGE_ATTACHMENT.test(markdown);
}

/** The signed URL for each attachment uuid in GitHub's rendered HTML. */
export function signedAttachmentUrls(html: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!html) return out;
  for (const match of html.matchAll(SIGNED_SRC)) {
    const uuid = match[1].toLowerCase();
    if (!out.has(uuid)) out.set(uuid, match[0].replace(/&amp;/g, '&'));
  }
  return out;
}

/**
 * The markdown with each attachment image pointed at its signed URL from
 * `html`. An image with no signed URL keeps its original URL.
 */
export function signAttachmentImages(markdown: string, html: string | null | undefined): string {
  if (!markdown || !html) return markdown;
  const signed = signedAttachmentUrls(html);
  if (signed.size === 0) return markdown;
  return markdown.replace(IMAGE_ATTACHMENT, (whole, prefix: string, _url: string, uuid: string) => {
    const url = signed.get(uuid.toLowerCase());
    return url ? `${prefix}${url}` : whole;
  });
}
