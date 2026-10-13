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
  const entries = mergePath(login, inherited, '/home/test').split(
    path.delimiter,
  );
  expect(entries.slice(0, prefix.length)).toEqual(prefix);
  expect(entries).toContain('/home/test/.local/bin');
  expect(entries).toContain('/home/test/.claude/local');
  expect(entries.length).toBe(new Set(entries).size);
  expect(entries.every((entry) => path.isAbsolute(entry))).toBe(true);
});
