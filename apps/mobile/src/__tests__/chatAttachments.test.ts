import { WORKBENCH_MAX_IMAGE_BYTES, WORKBENCH_MAX_VIDEO_BYTES } from '@talyn/shared';
import {
  attachmentUrl, buildMessageInput, checkAttachment, eventAttachments, attachmentMimeType, sendBlock, type ImageDraft,
} from '../features/chat/attachments';

const draft = (patch: Partial<ImageDraft> = {}): ImageDraft => ({
  id: 'd1', uri: 'file:///a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', status: 'ready',
  attachment: { name: 'a.jpg', mimeType: 'image/jpeg', path: '.context/attachments/x-a.jpg' }, ...patch,
});

describe('attachment types', () => {
  it.each([
    [{ uri: 'file:///a', mimeType: 'image/jpeg' }, 'image/jpeg'],
    [{ uri: 'file:///a', mimeType: 'image/jpg' }, 'image/jpeg'],
    [{ uri: 'file:///a', mimeType: 'IMAGE/PNG' }, 'image/png'],
    [{ uri: 'file:///a.webp?x=1', mimeType: null }, 'image/webp'],
    [{ uri: 'file:///a', fileName: 'shot.GIF', mimeType: 'application/octet-stream' }, 'image/gif'],
    [{ uri: 'file:///a.heic', mimeType: 'image/heic' }, null],
    [{ uri: 'file:///a.pdf', mimeType: null }, null],
    [{ uri: 'file:///a', mimeType: 'video/mp4' }, 'video/mp4'],
    [{ uri: 'file:///a', mimeType: 'video/quicktime' }, 'video/quicktime'],
    [{ uri: 'file:///a', mimeType: 'VIDEO/WEBM' }, 'video/webm'],
    [{ uri: 'file:///a', mimeType: 'video/mov' }, 'video/quicktime'],
    [{ uri: 'file:///a', mimeType: 'video/x-m4v' }, 'video/mp4'],
    [{ uri: 'file:///clip.MOV?x=1', mimeType: null }, 'video/quicktime'],
    [{ uri: 'file:///a', fileName: 'clip.m4v', mimeType: 'application/octet-stream' }, 'video/mp4'],
    [{ uri: 'file:///clip.webm', mimeType: undefined }, 'video/webm'],
    [{ uri: 'file:///a.avi', mimeType: 'video/x-msvideo' }, null],
    [{ uri: 'file:///a.mkv', mimeType: null }, null],
  ])('reads %j as %s', (image, expected) => { expect(attachmentMimeType(image)).toBe(expected); });
});

describe('checkAttachment', () => {
  it.each([
    [{ uri: 'file:///a.jpg', mimeType: 'image/jpeg', fileName: 'cat.jpg', fileSize: 1000 }, true, 'cat.jpg'],
    [{ uri: 'file:///a', mimeType: 'image/png' }, true, 'photo-1.png'],
    [{ uri: 'file:///a', mimeType: 'image/png', fileSize: WORKBENCH_MAX_IMAGE_BYTES }, true, 'photo-1.png'],
    [{ uri: 'file:///a', mimeType: 'image/png', fileSize: WORKBENCH_MAX_IMAGE_BYTES + 1 }, false, 'photo-1.png'],
    [{ uri: 'file:///a.heic', mimeType: 'image/heic' }, false, 'photo-1.jpg'],
    [{ uri: 'file:///a', mimeType: 'video/mp4' }, true, 'video-1.mp4'],
    [{ uri: 'file:///a', mimeType: 'video/quicktime' }, true, 'video-1.mov'],
    [{ uri: 'file:///a', mimeType: 'video/webm', fileName: ' ' }, true, 'video-1.webm'],
    [{ uri: 'file:///a', mimeType: 'video/mp4', fileName: 'demo.mp4' }, true, 'demo.mp4'],
    [{ uri: 'file:///a', mimeType: 'video/mp4', fileSize: WORKBENCH_MAX_VIDEO_BYTES }, true, 'video-1.mp4'],
    [{ uri: 'file:///a', mimeType: 'video/mp4', fileSize: WORKBENCH_MAX_VIDEO_BYTES + 1 }, false, 'video-1.mp4'],
    [{ uri: 'file:///a', mimeType: 'video/mp4', fileSize: WORKBENCH_MAX_IMAGE_BYTES + 1 }, true, 'video-1.mp4'],
    [{ uri: 'file:///a.avi', mimeType: 'video/x-msvideo' }, false, 'photo-1.jpg'],
  ])('checks %j', (image, ok, name) => {
    const result = checkAttachment(image, 0);
    expect(result.ok).toBe(ok);
    expect(result.name).toBe(name);
  });
  it.each([
    [{ uri: 'file:///a.heic', mimeType: 'image/heic' }, 'Only PNG, JPEG, WebP and GIF images and MP4, MOV and WebM videos can be attached.'],
    [{ uri: 'file:///a', mimeType: 'image/png', fileSize: WORKBENCH_MAX_IMAGE_BYTES + 1 }, 'The image is larger than 10 MB.'],
    [{ uri: 'file:///a', mimeType: 'video/mp4', fileSize: WORKBENCH_MAX_VIDEO_BYTES + 1 }, 'The video is larger than 50 MB.'],
  ])('explains why %j fails', (image, reason) => { expect(checkAttachment(image, 0)).toMatchObject({ ok: false, reason }); });
  it('numbers default names by pick index', () => { expect(checkAttachment({ uri: 'file:///a', mimeType: 'video/mp4' }, 2).name).toBe('video-3.mp4'); });
});

describe('buildMessageInput', () => {
  it('sends text only when there are no images', () => { expect(buildMessageInput('hi', [])).toEqual({ text: 'hi' }); });
  it('sends the uploaded attachments in the web shape', () => {
    expect(buildMessageInput('look', [draft()])).toEqual({ text: 'look', attachments: [{ name: 'a.jpg', mimeType: 'image/jpeg', path: '.context/attachments/x-a.jpg' }] });
  });
  it('sends a video next to an image', () => {
    const video = draft({ id: 'v', name: 'clip.mov', mimeType: 'video/quicktime', attachment: { name: 'clip.mov', mimeType: 'video/quicktime', path: '.context/attachments/x-clip.mov' } });
    expect(buildMessageInput('watch', [draft(), video])).toEqual({ text: 'watch', attachments: [
      { name: 'a.jpg', mimeType: 'image/jpeg', path: '.context/attachments/x-a.jpg' },
      { name: 'clip.mov', mimeType: 'video/quicktime', path: '.context/attachments/x-clip.mov' }] });
  });
  it('leaves out images that are not uploaded', () => {
    expect(buildMessageInput('look', [draft({ status: 'error', attachment: undefined }), draft({ status: 'uploading', attachment: undefined })])).toEqual({ text: 'look' });
  });
});

describe('sendBlock', () => {
  it.each([
    ['hi', [], null],
    ['', [], null],
    ['hi', [draft()], null],
    ['  ', [draft()], 'Add a message to send with the attachments.'],
    ['hi', [draft({ status: 'uploading' })], 'Waiting for the attachments to upload.'],
    ['hi', [draft({ status: 'error' })], 'Remove the attachments that failed, or try them again.'],
    ['  ', [draft({ mimeType: 'video/mp4' })], 'Add a message to send with the attachments.'],
    ['hi', [draft({ mimeType: 'video/mp4', status: 'uploading' })], 'Waiting for the attachments to upload.'],
  ] as const)('text %j with %#', (text, drafts, expected) => { expect(sendBlock({ text, drafts: [...drafts] })).toBe(expected); });
});

describe('attachment urls and events', () => {
  it('builds the raw attachment url', () => {
    expect(attachmentUrl('https://api.test/', 'wb 1', '.context/attachments/a b.png')).toBe('https://api.test/api/v1/workbenches/wb%201/attachments/raw?path=.context%2Fattachments%2Fa%20b.png');
  });
  it.each([
    [undefined, []],
    ['x', []],
    [[{ name: 'a.png', mimeType: 'image/png', path: 'p' }, { name: 1 }, null], [{ name: 'a.png', mimeType: 'image/png', path: 'p' }]],
    [[{ name: 'b.png', mimeType: 'image/png' }], [{ name: 'b.png', mimeType: 'image/png' }]],
  ])('reads event attachments %j', (raw, expected) => { expect(eventAttachments(raw)).toEqual(expected); });
});
