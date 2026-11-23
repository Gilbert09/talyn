import { describe, expect, it } from 'vitest';
import {
  isWorkbenchTextContent,
  isWorkbenchTextFile,
  isWorkbenchVideoType,
  workbenchAttachmentFileName,
  workbenchAttachmentMaxBytes,
  WORKBENCH_MAX_IMAGE_BYTES,
  WORKBENCH_MAX_TEXT_BYTES,
  WORKBENCH_MAX_VIDEO_BYTES,
} from '@talyn/shared';

describe('workbenchAttachmentFileName', () => {
  it.each([
    ['shot.png', 'image/png', 'shot.png'],
    ['shot', 'image/png', 'shot.png'],
    ['photo.jpeg', 'image/jpeg', 'photo.jpeg'],
    ['photo.JPG', 'image/jpeg', 'photo.JPG'],
    ['photo.png', 'image/jpeg', 'photo.jpg'],
    ['clip.mp4', 'video/mp4', 'clip.mp4'],
    ['clip.m4v', 'video/mp4', 'clip.m4v'],
    ['IMG_0001.MOV', 'video/quicktime', 'IMG_0001.MOV'],
    ['clip.mp4', 'video/webm', 'clip.webm'],
    ['recording', 'video/quicktime', 'recording.mov'],
    ['my.screen.recording', 'video/mp4', 'my.screen.mp4'],
    ['.hidden', 'video/mp4', '.hidden.mp4'],
    ['notes.txt', 'text/plain', 'notes.txt'],
  ])('%s as %s is stored as %s', (name, type, expected) => {
    expect(workbenchAttachmentFileName(name, type)).toBe(expected);
  });
});

describe('attachment limits', () => {
  it.each([
    ['video/mp4', true, WORKBENCH_MAX_VIDEO_BYTES],
    ['video/quicktime', true, WORKBENCH_MAX_VIDEO_BYTES],
    ['VIDEO/WEBM', true, WORKBENCH_MAX_VIDEO_BYTES],
    ['video/x-matroska', false, WORKBENCH_MAX_IMAGE_BYTES],
    ['image/png', false, WORKBENCH_MAX_IMAGE_BYTES],
    ['application/octet-stream', false, WORKBENCH_MAX_IMAGE_BYTES],
    ['text/plain', false, WORKBENCH_MAX_TEXT_BYTES],
    ['TEXT/PLAIN', false, WORKBENCH_MAX_TEXT_BYTES],
  ])('%s: video %s, limit %d', (type, video, limit) => {
    expect(isWorkbenchVideoType(type)).toBe(video);
    expect(workbenchAttachmentMaxBytes(type)).toBe(limit);
  });
});

describe('isWorkbenchTextFile', () => {
  it.each([
    ['notes.txt', 'text/plain', true],
    ['README.md', '', true],
    ['data.json', 'application/json', true],
    ['config.yaml', 'application/octet-stream', true],
    ['index.ts', 'video/mp2t', true],
    ['App.TSX', '', true],
    ['Dockerfile', '', true],
    ['Makefile', null, true],
    ['.gitignore', '', true],
    ['report', 'text/csv', true],
    ['feed', 'application/xml; charset=utf-8', true],
    ['shot.png', 'image/png', false],
    ['clip.mp4', 'video/mp4', false],
    ['archive.zip', 'application/zip', false],
    ['binary', 'application/octet-stream', false],
    ['icon.svg', 'image/svg+xml', false],
  ])('%s (%s): %s', (name, type, expected) => {
    expect(isWorkbenchTextFile({ name, type })).toBe(expected);
  });
});

describe('isWorkbenchTextContent', () => {
  it.each([
    ['empty', Buffer.alloc(0), true],
    ['ASCII', Buffer.from('hello\nworld\t!'), true],
    ['two-byte UTF-8', Buffer.from('café'), true],
    ['three-byte UTF-8', Buffer.from('✓ €'), true],
    ['four-byte UTF-8', Buffer.from('emoji 😀'), true],
    ['a UTF-8 byte order mark', Buffer.from([0xef, 0xbb, 0xbf, 0x61]), true],
    ['a NUL byte', Buffer.from([0x61, 0x00, 0x62]), false],
    ['a lone continuation byte', Buffer.from([0x80]), false],
    ['a cut-off sequence', Buffer.from([0x61, 0xe2, 0x82]), false],
    ['an overlong encoding', Buffer.from([0xc0, 0xaf]), false],
    ['an overlong three-byte encoding', Buffer.from([0xe0, 0x80, 0xaf]), false],
    ['a UTF-16 surrogate', Buffer.from([0xed, 0xa0, 0x80]), false],
    ['a code point past U+10FFFF', Buffer.from([0xf4, 0x90, 0x80, 0x80]), false],
    ['a Latin-1 byte', Buffer.from([0x63, 0x61, 0x66, 0xe9]), false],
    ['PNG bytes', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), false],
  ])('%s: %s', (_label, bytes, expected) => {
    expect(isWorkbenchTextContent(bytes)).toBe(expected);
  });
});
