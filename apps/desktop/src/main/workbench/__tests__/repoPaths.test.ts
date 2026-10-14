/** @jest-environment node */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { RepoPaths, repoFullNameFromRemote } from '../repoPaths';
import { runGit, temporaryRepo } from '../testSupport';

test.each([
  ['https://github.com/PostHog/posthog.git', 'PostHog/posthog'],
  ['https://github.com/PostHog/posthog', 'PostHog/posthog'],
  ['https://user:tok@github.com/a/b.git', 'a/b'],
  ['git@github.com:a/b.git', 'a/b'],
  ['ssh://git@github.com/a/b.git', 'a/b'],
  ['https://gitlab.com/a/b.git', null],
  ['/local/path', null],
])('parses %s', (url, expected) => {
  expect(repoFullNameFromRemote(url)).toBe(expected);
});

describe('RepoPaths', () => {
  let userData: string;
  let repo: string;
  let directory: string;
  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-userdata-'));
    ({ repo, directory } = await temporaryRepo());
  });
  afterEach(async () => {
    await fs.rm(userData, { recursive: true, force: true });
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each([
    'https://github.com/Owner/Name.git',
    'git@github.com:owner/name.git',
  ])('accepts a matching origin %s case-insensitively', async (url) => {
    await runGit(repo, ['remote', 'add', 'origin', url]);
    const store = new RepoPaths(userData);
    const root = await fs.realpath(repo);
    expect(await store.set({ repoFullName: 'owner/NAME', path: repo })).toEqual({ 'owner/NAME': root });
    expect(await new RepoPaths(userData).get()).toEqual({ 'owner/NAME': root });
    expect(await store.set({ repoFullName: 'Owner/Name', path: repo })).toEqual({ 'owner/NAME': root });
    expect(await store.remove('OWNER/name')).toEqual({});
  });

  it('rejects a different origin', async () => {
    await runGit(repo, ['remote', 'add', 'origin', 'git@github.com:other/thing.git']);
    await expect(new RepoPaths(userData).set({ repoFullName: 'owner/name', path: repo })).rejects.toThrow(/other\/thing/);
  });

  it('rejects a repo without origin', async () => {
    await expect(new RepoPaths(userData).set({ repoFullName: 'owner/name', path: repo })).rejects.toThrow(/origin/);
  });

  it('rejects a non-repo and a relative path', async () => {
    const store = new RepoPaths(userData);
    await expect(store.set({ repoFullName: 'owner/name', path: userData })).rejects.toThrow(/not a Git/);
    await expect(store.set({ repoFullName: 'owner/name', path: 'rel' })).rejects.toThrow(/absolute/);
    await expect(store.set({ repoFullName: 'bad', path: repo })).rejects.toThrow(/Invalid/);
  });
});
