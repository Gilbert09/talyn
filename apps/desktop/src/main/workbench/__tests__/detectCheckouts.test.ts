import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { detectCheckouts, uniqueMainCheckouts } from '../detectCheckouts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-checkouts-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function mainCheckout(relative: string, config: string): Promise<string> {
  const checkout = path.join(root, relative);
  await fs.mkdir(path.join(checkout, '.git'), { recursive: true });
  await fs.writeFile(path.join(checkout, '.git', 'config'), config);
  return checkout;
}

async function worktree(relative: string, common: string): Promise<string> {
  const checkout = path.join(root, relative);
  const gitdir = path.join(root, 'metadata', relative.replaceAll('/', '-'));
  await fs.mkdir(checkout, { recursive: true });
  await fs.mkdir(gitdir, { recursive: true });
  await fs.writeFile(path.join(checkout, '.git'), `gitdir: ${gitdir}\n`);
  await fs.writeFile(path.join(gitdir, 'commondir'), `${path.relative(gitdir, path.join(common, '.git'))}\n`);
  return checkout;
}

test.each([
  'git@github.com:PostHog/posthog.git',
  'ssh://git@github.com/PostHog/posthog.git/',
  'https://github.com/PostHog/posthog/',
])('finds a checkout with remote %s', async (url) => {
  const checkout = await mainCheckout('dev/posthog', `[remote "origin"]\n  url = ${url}\n`);
  expect(await detectCheckouts(['posthog/POSTHOG'], { mounts: new Set(), roots: [root] })).toEqual({
    'posthog/POSTHOG': [checkout],
  });
});

test('ranks main checkouts before worktrees, then uses origin and path length', async () => {
  const short = await mainCheckout('dev/a', '[remote "upstream"]\n url = git@github.com:owner/repo.git\n');
  const origin = await mainCheckout('dev/longer-name', '[remote "origin"]\n url = https://github.com/OWNER/REPO.git\n');
  const tree = await worktree('work/repo-tree', short);
  const found = await detectCheckouts(['Owner/Repo'], { mounts: new Set(), roots: [root] });
  expect(found).toEqual({ 'Owner/Repo': [origin, short, tree] });
  expect(await uniqueMainCheckouts(found)).toEqual({});
});

test('finds a worktree through its common config', async () => {
  const common = await mainCheckout('metadata/base', '[remote "origin"]\n url = ssh://git@github.com/a/b.git\n');
  const tree = await worktree('dev/tree', common);
  expect(await detectCheckouts(['a/b'], { mounts: new Set(), roots: [path.join(root, 'dev')] })).toEqual({ 'a/b': [tree] });
});

test.each([
  'Library', 'node_modules', 'Pictures', 'Music', 'Movies', 'Applications',
  'Desktop', 'Documents', 'Downloads', 'go', 'venv', 'vendor', 'dist',
  'build', 'target', 'Pods', 'DerivedData', '.hidden',
])('skips %s under HOME', async (name) => {
  await mainCheckout(`${name}/repo`, '[remote "origin"]\n url = https://github.com/a/b\n');
  expect(await detectCheckouts(['a/b'], { mounts: new Set(), roots: [root] })).toEqual({});
});

test.each([
  'Documents',
  'Documents/work',
])('scans a chosen root at %s', async (chosen) => {
  const checkout = await mainCheckout('Documents/work/repo', '[remote "origin"]\n url = https://github.com/a/b\n');
  expect(await detectCheckouts(['a/b'], {
    mounts: new Set(), roots: [root], extraRoots: [path.join(root, chosen)],
  })).toEqual({ 'a/b': [checkout] });
});

test('scans overlapping chosen roots to their own depth limits', async () => {
  const checkout = await mainCheckout('projects/one/two/three/four/five/repo', '[remote "origin"]\n url = https://github.com/a/b\n');
  expect(await detectCheckouts(['a/b'], {
    mounts: new Set(), roots: [root], extraRoots: [path.join(root, 'projects'), path.join(root, 'projects', 'one')],
  })).toEqual({ 'a/b': [checkout] });
});

test('skips symlinks and checkout descendants, and respects depth', async () => {
  const visible = await mainCheckout('one/two/three', '[remote "origin"]\n url = https://github.com/a/b\n');
  await mainCheckout('node_modules/hidden', '[remote "origin"]\n url = https://github.com/a/b\n');
  await mainCheckout('one/two/three/deeper', '[remote "origin"]\n url = https://github.com/a/b\n');
  await mainCheckout('other', '[remote "origin"]\n url = https://gitlab.com/a/b\n');
  await fs.symlink(visible, path.join(root, 'linked'));
  expect(await detectCheckouts(['a/b'], { mounts: new Set(), roots: [root], maxDepth: 2 })).toEqual({});
  expect(await detectCheckouts(['a/b'], { mounts: new Set(), roots: [root], maxDepth: 3 })).toEqual({ 'a/b': [visible] });
});

test.each([
  [5, true],
  [6, false],
] as const)('default HOME depth stops before level %i: %s', async (depth, found) => {
  const checkout = await mainCheckout(`${'level/'.repeat(depth - 1)}repo`, '[remote "origin"]\n url = https://github.com/a/b\n');
  expect(await detectCheckouts(['a/b'], { mounts: new Set(), roots: [root] })).toEqual(
    found ? { 'a/b': [checkout] } : {},
  );
});

test('returns quickly when the time budget is spent', async () => {
  await mainCheckout('repo', '[remote "origin"]\n url = https://github.com/a/b\n');
  expect(await detectCheckouts(['a/b'], { mounts: new Set(), roots: [root], timeBudgetMs: 0 })).toEqual({});
});

test('never steps into another mounted volume', async () => {
  await mainCheckout('dev/share/repo', '[remote "origin"]\n url = git@github.com:o/r.git\n');
  const local = await mainCheckout('dev/local/repo', '[remote "origin"]\n url = git@github.com:o/r.git\n');
  const mounts = new Set([path.join(root, 'dev', 'share')]);
  expect(await detectCheckouts(['o/r'], { mounts, roots: [root] })).toEqual({ 'o/r': [local] });
});

test('the startup scan skips a chosen folder on another volume, a manual scan reads it', async () => {
  const checkout = await mainCheckout('disk/repo', '[remote "origin"]\n url = git@github.com:o/r.git\n');
  const mounts = new Set([path.join(root, 'disk')]);
  const opts = { mounts, roots: [], extraRoots: [path.join(root, 'disk')] };
  expect(await detectCheckouts(['o/r'], { ...opts, localOnly: true })).toEqual({});
  expect(await detectCheckouts(['o/r'], opts)).toEqual({ 'o/r': [checkout] });
});
