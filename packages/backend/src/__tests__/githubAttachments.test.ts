import { describe, expect, it } from 'vitest';
import {
  hasAttachmentImages,
  signAttachmentImages,
  signedAttachmentUrls,
} from '../services/githubAttachments.js';

const A = '27ad58e7-b0e3-4c9f-9f22-156ac33515ed';
const B = '5f571fe5-d7ca-4e64-8fa9-ecfb669445b6';
const ATTACH_A = `https://github.com/user-attachments/assets/${A}`;
const ATTACH_B = `https://github.com/user-attachments/assets/${B}`;
const LEGACY_A = `https://github.com/PostHog/posthog/assets/19493900/${A}`;
const SIGNED_A = `https://private-user-images.githubusercontent.com/19493900/712798228-${A}.png?jwt=eyJ0.eyJp.GIat`;
const SIGNED_B = `https://private-user-images.githubusercontent.com/19493900/712798815-${B}.png?jwt=eyJ0.eyJq.FdgB`;

/** The shape GitHub's bodyHTML uses for an attachment image. */
function htmlFor(...signed: string[]): string {
  return signed
    .map(
      (url) =>
        `<p><a target="_blank" rel="noopener noreferrer" href="${url}"><img width="1096" alt="x" src="${url}" style="max-width: 100%"></a></p>`
    )
    .join('\n');
}

describe('hasAttachmentImages', () => {
  it.each([
    ['a markdown image', `![shot](${ATTACH_A})`, true],
    ['a markdown image in angle brackets', `![shot](<${ATTACH_A}>)`, true],
    ['an <img> with double quotes', `<img width="10" src="${ATTACH_A}" />`, true],
    ['an <img> with single quotes', `<img src='${ATTACH_A}'>`, true],
    ['an <img> with spaces around =', `<img src = "${ATTACH_A}">`, true],
    ['the legacy repo assets URL', `![shot](${LEGACY_A})`, true],
    ['an upper-case uuid', `![shot](https://github.com/user-attachments/assets/${A.toUpperCase()})`, true],
    ['a bare attachment link (a video)', `${ATTACH_A}`, false],
    ['a markdown link to an attachment', `[see](${ATTACH_A})`, false],
    ['an external image', '![x](https://example.com/a.png)', false],
    ['an empty body', '', false],
    ['null', null, false],
    ['undefined', undefined, false],
  ])('%s → %s', (_label, body, expected) => {
    expect(hasAttachmentImages(body)).toBe(expected);
  });

  it('gives the same answer when it is called twice (no regex state leaks)', () => {
    const body = `![shot](${ATTACH_A})`;
    expect(hasAttachmentImages(body)).toBe(true);
    expect(hasAttachmentImages(body)).toBe(true);
  });
});

describe('signedAttachmentUrls', () => {
  it('maps each uuid to its signed URL', () => {
    const map = signedAttachmentUrls(htmlFor(SIGNED_A, SIGNED_B));
    expect(map.get(A)).toBe(SIGNED_A);
    expect(map.get(B)).toBe(SIGNED_B);
    expect(map.size).toBe(2);
  });

  it('decodes &amp; in the attribute', () => {
    const encoded = `${SIGNED_A}&amp;x=1`;
    expect(signedAttachmentUrls(htmlFor(encoded)).get(A)).toBe(`${SIGNED_A}&x=1`);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['HTML with only external images', '<img src="https://camo.githubusercontent.com/abc">'],
  ])('is empty for %s', (_label, html) => {
    expect(signedAttachmentUrls(html).size).toBe(0);
  });
});

describe('signAttachmentImages', () => {
  it.each([
    ['a markdown image', `before ![shot](${ATTACH_A}) after`, `before ![shot](${SIGNED_A}) after`],
    ['a markdown image in angle brackets', `![shot](<${ATTACH_A}>)`, `![shot](<${SIGNED_A}>)`],
    ['an <img> tag', `<img width="1096" alt="pr" src="${ATTACH_A}" />`, `<img width="1096" alt="pr" src="${SIGNED_A}" />`],
    ['an <img> with single quotes', `<img src='${ATTACH_A}'>`, `<img src='${SIGNED_A}'>`],
    ['the legacy repo assets URL', `![shot](${LEGACY_A})`, `![shot](${SIGNED_A})`],
    [
      'two images',
      `<img src="${ATTACH_A}">\n<img src="${ATTACH_B}">`,
      `<img src="${SIGNED_A}">\n<img src="${SIGNED_B}">`,
    ],
    ['a bare link (kept: it must still work after the JWT expires)', `Video: ${ATTACH_A}`, `Video: ${ATTACH_A}`],
    ['a markdown link (kept)', `[see](${ATTACH_A})`, `[see](${ATTACH_A})`],
    [
      'an image wrapped in a link to the same asset (only the image changes)',
      `[![shot](${ATTACH_A})](${ATTACH_A})`,
      `[![shot](${SIGNED_A})](${ATTACH_A})`,
    ],
  ])('rewrites %s', (_label, body, expected) => {
    expect(signAttachmentImages(body, htmlFor(SIGNED_A, SIGNED_B))).toBe(expected);
  });

  it('keeps an image that the HTML has no signed URL for', () => {
    const body = `![a](${ATTACH_A}) ![b](${ATTACH_B})`;
    expect(signAttachmentImages(body, htmlFor(SIGNED_A))).toBe(`![a](${SIGNED_A}) ![b](${ATTACH_B})`);
  });

  it.each([
    ['null HTML', null],
    ['undefined HTML', undefined],
    ['empty HTML', ''],
    ['HTML with no signed URLs', '<p>hi</p>'],
  ])('returns the body unchanged for %s', (_label, html) => {
    const body = `![shot](${ATTACH_A})`;
    expect(signAttachmentImages(body, html)).toBe(body);
  });

  it('returns an empty body unchanged', () => {
    expect(signAttachmentImages('', htmlFor(SIGNED_A))).toBe('');
  });
});
