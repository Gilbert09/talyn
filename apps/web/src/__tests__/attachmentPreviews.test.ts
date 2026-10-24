import { describe, it, expect, vi, beforeAll } from 'vitest';
import { attachmentPreview, loadAttachmentPreview } from '../lib/attachmentPreviews';

beforeAll(() => {
  let n = 0;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:preview-${++n}`) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

describe('loadAttachmentPreview', () => {
  it('keeps a preview URL for the fetched bytes and reuses it', async () => {
    const fetchBlob = vi.fn().mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    const url = await loadAttachmentPreview(fetchBlob, 'a.png', 'image/png');
    expect(url).toMatch(/^blob:preview-/);
    expect(attachmentPreview('a.png')).toBe(url);
    await expect(loadAttachmentPreview(fetchBlob, 'a.png', 'image/png')).resolves.toBe(url);
    expect(fetchBlob).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a 404 from a backend without the raw route', () => Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))],
    ['a network failure', () => Promise.reject(new TypeError('fetch failed'))],
    ['an empty body', () => Promise.resolve(new Blob([]))],
  ])('answers null on %s, so the caller shows only the name', async (_n, impl) => {
    const path = `missing-${Math.random()}.png`;
    await expect(loadAttachmentPreview(vi.fn(impl), path, 'image/png')).resolves.toBeNull();
    expect(attachmentPreview(path)).toBeNull();
  });
});
