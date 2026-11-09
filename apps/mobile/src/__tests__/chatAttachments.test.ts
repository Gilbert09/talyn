import {
  MAX_IMAGE_BYTES, attachmentUrl, buildMessageInput, checkImage, eventAttachments, imageMimeType, sendBlock, type ImageDraft,
} from '../features/chat/attachments';

const draft = (patch: Partial<ImageDraft> = {}): ImageDraft => ({
  id: 'd1', uri: 'file:///a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', status: 'ready',
  attachment: { name: 'a.jpg', mimeType: 'image/jpeg', path: '.context/attachments/x-a.jpg' }, ...patch,
});

describe('image types', () => {
  it.each([
    [{ uri: 'file:///a', mimeType: 'image/jpeg' }, 'image/jpeg'],
    [{ uri: 'file:///a', mimeType: 'image/jpg' }, 'image/jpeg'],
    [{ uri: 'file:///a', mimeType: 'IMAGE/PNG' }, 'image/png'],
    [{ uri: 'file:///a.webp?x=1', mimeType: null }, 'image/webp'],
    [{ uri: 'file:///a', fileName: 'shot.GIF', mimeType: 'application/octet-stream' }, 'image/gif'],
    [{ uri: 'file:///a.heic', mimeType: 'image/heic' }, null],
    [{ uri: 'file:///a.pdf', mimeType: null }, null],
  ])('reads %j as %s', (image, expected) => { expect(imageMimeType(image)).toBe(expected); });
});

describe('checkImage', () => {
  it.each([
    [{ uri: 'file:///a.jpg', mimeType: 'image/jpeg', fileName: 'cat.jpg', fileSize: 1000 }, true, 'cat.jpg'],
    [{ uri: 'file:///a', mimeType: 'image/png' }, true, 'photo-1.png'],
    [{ uri: 'file:///a', mimeType: 'image/png', fileSize: MAX_IMAGE_BYTES }, true, 'photo-1.png'],
    [{ uri: 'file:///a', mimeType: 'image/png', fileSize: MAX_IMAGE_BYTES + 1 }, false, 'photo-1.png'],
    [{ uri: 'file:///a.heic', mimeType: 'image/heic' }, false, 'photo-1.jpg'],
  ])('checks %j', (image, ok, name) => {
    const result = checkImage(image, 0);
    expect(result.ok).toBe(ok);
    expect(result.name).toBe(name);
  });
});

describe('buildMessageInput', () => {
  it('sends text only when there are no images', () => { expect(buildMessageInput('hi', [])).toEqual({ text: 'hi' }); });
  it('sends the uploaded attachments in the web shape', () => {
    expect(buildMessageInput('look', [draft()])).toEqual({ text: 'look', attachments: [{ name: 'a.jpg', mimeType: 'image/jpeg', path: '.context/attachments/x-a.jpg' }] });
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
    ['  ', [draft()], 'Add a message to send with the images.'],
    ['hi', [draft({ status: 'uploading' })], 'Waiting for the images to upload.'],
    ['hi', [draft({ status: 'error' })], 'Remove the images that failed, or try them again.'],
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
