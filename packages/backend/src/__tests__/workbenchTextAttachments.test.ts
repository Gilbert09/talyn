import { describe, expect, it } from 'vitest';
import { WORKBENCH_MAX_TEXT_BYTES } from '@talyn/shared';

const { normaliseMessage } = await import('../services/workbenches/turns.js');

const inline = (data: Buffer, name = 'notes.md') => ({
  text: '',
  attachments: [{ name, mimeType: 'text/plain', dataBase64: data.toString('base64') }],
});

describe('inline text attachments', () => {
  it('keeps a UTF-8 text file', () => {
    const message = normaliseMessage(inline(Buffer.from('# Notes\nnaïve café ✓\n')));
    expect(message.attachments).toEqual([
      { name: 'notes.md', mimeType: 'text/plain', dataBase64: Buffer.from('# Notes\nnaïve café ✓\n').toString('base64') },
    ]);
  });

  it('keeps a text file of exactly the limit', () => {
    expect(() => normaliseMessage(inline(Buffer.alloc(WORKBENCH_MAX_TEXT_BYTES, 'a')))).not.toThrow();
  });

  it.each([
    ['a file over 1 MB', Buffer.alloc(WORKBENCH_MAX_TEXT_BYTES + 1, 'a'), 413, 'attachment_too_large'],
    ['binary bytes', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), 415, 'bad_attachment'],
    ['a NUL byte', Buffer.from('a\u0000b'), 415, 'bad_attachment'],
    ['invalid UTF-8', Buffer.from([0x61, 0xc3, 0x28]), 415, 'bad_attachment'],
  ])('refuses %s', (_label, data, status, code) => {
    expect(() => normaliseMessage(inline(data))).toThrow(expect.objectContaining({ status, code }));
  });

  it('does not check the bytes of an image', () => {
    const message = normaliseMessage({ text: 'look', attachments: [{ name: 'a.png', mimeType: 'image/png', dataBase64: 'AAEC' }] });
    expect(message.attachments).toHaveLength(1);
  });
});
