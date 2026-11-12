import { describe, expect, it } from 'vitest';
import {
  isWorkbenchVideoType,
  workbenchAttachmentFileName,
  workbenchAttachmentMaxBytes,
  WORKBENCH_MAX_IMAGE_BYTES,
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
  ])('%s: video %s, limit %d', (type, video, limit) => {
    expect(isWorkbenchVideoType(type)).toBe(video);
    expect(workbenchAttachmentMaxBytes(type)).toBe(limit);
  });
});
