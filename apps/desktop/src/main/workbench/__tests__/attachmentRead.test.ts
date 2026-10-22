/** @jest-environment node */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { readFileBase64 } from '../git';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-attachment-read-'));
  await fs.mkdir(path.join(root, '.context', 'attachments'), { recursive: true });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('reads image bytes as base64', async () => {
  const bytes = Buffer.from([0, 255, 12, 42]);
  await fs.writeFile(path.join(root, '.context', 'attachments', 'image.png'), bytes);
  expect(await readFileBase64(root, '.context/attachments/image.png')).toBe(bytes.toString('base64'));
});

test.each(['../secret.png', '.context/attachments/../secret.png', 'image.png'])('rejects unsafe path %s', async (relative) => {
  await expect(readFileBase64(root, relative)).rejects.toThrow('Invalid attachment path');
});

test('rejects a symlink outside the worktree', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-attachment-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'secret.png'), 'secret');
    await fs.symlink(path.join(outside, 'secret.png'), path.join(root, '.context', 'attachments', 'link.png'));
    await expect(readFileBase64(root, '.context/attachments/link.png')).rejects.toThrow('escapes');
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});
