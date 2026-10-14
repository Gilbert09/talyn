/** @jest-environment node */
import path from 'path';
import { mergePath } from '../environment';

test.each([
  [
    '/custom/bin:/usr/bin',
    '/usr/bin:/bin',
    ['/custom/bin', '/usr/bin', '/bin'],
  ],
  ['', '', ['/opt/homebrew/bin', '/usr/local/bin']],
  ['.:relative:/safe/bin::', '/bin', ['/safe/bin', '/bin']],
])('merges PATH %p and %p', (login, inherited, prefix) => {
  const entries = mergePath(login, inherited, '/home/test', 'linux').split(
    path.posix.delimiter,
  );
  expect(entries.slice(0, prefix.length)).toEqual(prefix);
  expect(entries).toContain('/home/test/.local/bin');
  expect(entries).toContain('/home/test/.claude/local');
  expect(entries.length).toBe(new Set(entries).size);
  expect(entries.every((entry) => path.posix.isAbsolute(entry))).toBe(true);
});

test('merges a Windows PATH without the POSIX directories', () => {
  expect(
    mergePath(
      'C:\\Git\\cmd;relative;C:\\Windows',
      'C:\\Windows;D:\\tools',
      'C:\\Users\\test',
      'win32',
    ).split(';'),
  ).toEqual([
    'C:\\Git\\cmd',
    'C:\\Windows',
    'D:\\tools',
    'C:\\Users\\test\\.local\\bin',
  ]);
});
