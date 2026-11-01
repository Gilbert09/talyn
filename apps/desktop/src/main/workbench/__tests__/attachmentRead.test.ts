/** @jest-environment node */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { exec, readFileBase64, writeAttachment } from '../git';

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

describe('writeAttachment', () => {
  test('writes a 2 MiB image that the old argv path could not pass, and reads it back', async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
    // The old path put the base64 text in an argv; macOS caps an argv near 1 MiB.
    if (process.platform !== 'win32') {
      await expect(exec(root, [{ argv: ['sh', '-c', 'true', 'sh', bytes.toString('base64')] }])).rejects.toThrow('E2BIG');
    }
    const relative = await writeAttachment(root, 'my shot (1).png', bytes.toString('base64'));
    expect(relative).toMatch(/^\.context\/attachments\/\d+-[0-9a-f]{8}-my-shot-1-.png$/);
    expect(await readFileBase64(root, relative)).toBe(bytes.toString('base64'));
  });

  test.each(['../../etc/passwd', '.hidden', '', '..'])('keeps the name %p inside the attachments folder', async (name) => {
    const relative = await writeAttachment(root, name, Buffer.from('x').toString('base64'));
    expect(relative).toMatch(/^\.context\/attachments\/[A-Za-z0-9._-]+$/);
    expect(relative.slice('.context/attachments/'.length)).not.toMatch(/^\./);
  });

  test('refuses a symlinked .context folder', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-attachment-outside-'));
    try {
      await fs.rm(path.join(root, '.context'), { recursive: true });
      await fs.symlink(outside, path.join(root, '.context'));
      await expect(writeAttachment(root, 'a.png', 'eA==')).rejects.toThrow('symlink');
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test('refuses data over the 10 MiB limit', async () => {
    await expect(writeAttachment(root, 'a.png', 'A'.repeat(14 * 1024 * 1024 + 4))).rejects.toThrow('10 MiB');
  });
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
