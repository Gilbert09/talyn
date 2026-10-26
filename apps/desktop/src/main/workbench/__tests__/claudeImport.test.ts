/** @jest-environment node */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { gunzipSync } from 'zlib';
import { claudeProjectSlug, type WorkbenchImportHeader } from '@talyn/shared';
import * as environment from '../environment';
import {
  listClaudeConversations,
  peekFile,
  prepareClaudeImport,
  remoteBaseRef,
  summarise,
} from '../claudeImport';
import { runGit, temporaryRepo, testEnv } from '../testSupport';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
const prompt = (cwd: string, text: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', cwd, gitBranch: 'feature', timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: text }, ...extra });

let directory: string;
let repo: string;
let projects: string;

beforeEach(async () => {
  ({ directory, repo } = await temporaryRepo());
  repo = await fs.realpath(repo);
  projects = path.join(directory, 'projects');
  await fs.mkdir(projects);
  jest.spyOn(environment, 'processEnv').mockResolvedValue(testEnv);
  await runGit(repo, ['remote', 'add', 'origin', 'git@github.com:Acme/App.git']);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

async function writeConversation(cwd: string, id: string, lines: string[], mtime?: Date): Promise<string> {
  const dir = path.join(projects, claudeProjectSlug(cwd));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(file, `${lines.join('\n')}\n`);
  if (mtime) await fs.utimes(file, mtime, mtime);
  return file;
}

describe('summarise', () => {
  it.each([
    [
      'the first typed prompt, skipping meta and command lines',
      [
        line({ type: 'mode', mode: 'default' }),
        line({ type: 'user', isMeta: true, cwd: '/a', message: { content: '<local-command-caveat>x</local-command-caveat>' } }),
        line({ type: 'user', cwd: '/a', message: { content: '<command-name>/clear</command-name>' } }),
        prompt('/a', 'Real prompt'),
      ],
      [],
      { cwd: '/a', firstPrompt: 'Real prompt', gitBranch: 'feature', title: null },
    ],
    [
      'the title and newest folder from the tail',
      [prompt('/a', 'First')],
      [line({ type: 'ai-title', aiTitle: 'Fix login' }), line({ type: 'user', cwd: '/b', gitBranch: 'other', timestamp: '2026-10-21T00:00:00.000Z', message: { content: [{ type: 'tool_result' }] } })],
      { cwd: '/b', firstPrompt: 'First', gitBranch: 'other', title: 'Fix login', lastTimestamp: '2026-10-21T00:00:00.000Z' },
    ],
    [
      'the last prompt when the head holds none',
      [line({ type: 'file-history-snapshot' })],
      [line({ type: 'last-prompt', lastPrompt: 'Later prompt' })],
      { firstPrompt: 'Later prompt' },
    ],
  ])('reads %s', (_label, head, tail, expected) => {
    const parse = (ls: string[]) => ls.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(summarise(parse(head), parse(tail))).toMatchObject(expected);
  });
});

describe('peekFile', () => {
  it('reads only whole lines from each end of a large file', async () => {
    const filler = Array.from({ length: 3000 }, (_, i) => line({ type: 'attachment', n: i, pad: 'p'.repeat(60) }));
    const file = await writeConversation(repo, ID(1), [prompt(repo, 'Start here'), ...filler, line({ type: 'ai-title', aiTitle: 'Tail title' })]);
    const size = (await fs.stat(file)).size;
    expect(size).toBeGreaterThan(2 * 64 * 1024);
    const { head, tail } = await peekFile(file, size);
    expect(head[0]).toMatchObject({ type: 'user' });
    expect(tail.at(-1)).toMatchObject({ aiTitle: 'Tail title' });
    // Neither end reaches the middle of the file.
    const middle = (filler.length / 2) | 0;
    expect([...head, ...tail].some((l) => l.n === middle)).toBe(false);
  });
});

describe('listClaudeConversations', () => {
  it('lists newest first, matches folders to watched repositories, and says why the others are not offered', async () => {
    const sub = path.join(repo, 'src');
    await fs.mkdir(sub);
    const plain = path.join(directory, 'plain');
    await fs.mkdir(plain);
    const other = path.join(directory, 'other');
    await fs.mkdir(other);
    await runGit(other, ['init', '--initial-branch=main']);
    await runGit(other, ['remote', 'add', 'origin', 'https://github.com/someone/else.git']);

    await writeConversation(repo, ID(1), [prompt(repo, 'Oldest in the repo')], new Date('2026-10-01T00:00:00Z'));
    await writeConversation(sub, ID(2), [prompt(sub, 'From a subfolder')], new Date('2026-10-05T00:00:00Z'));
    await writeConversation(path.join(directory, 'gone'), ID(3), [prompt(path.join(directory, 'gone'), 'Deleted folder')], new Date('2026-10-04T00:00:00Z'));
    await writeConversation(plain, ID(4), [prompt(plain, 'No git')], new Date('2026-10-03T00:00:00Z'));
    await writeConversation(other, ID(5), [prompt(other, 'Unwatched')], new Date('2026-10-02T00:00:00Z'));
    // Not conversations: a sidechain file, a non-UUID name, an empty file, one with no prompt or title.
    await writeConversation(repo, 'agent-abc', [prompt(repo, 'agent')]);
    await fs.writeFile(path.join(projects, claudeProjectSlug(repo), 'notes.txt'), 'x');
    await fs.writeFile(path.join(projects, claudeProjectSlug(repo), `${ID(6)}.jsonl`), '');
    await writeConversation(repo, ID(7), [line({ type: 'file-history-snapshot' })]);

    const list = await listClaudeConversations(['acme/app', 'acme/web'], { projectsDir: projects });
    expect(list.map((c) => [c.firstPrompt, c.repoFullName, c.unavailableReason])).toEqual([
      ['From a subfolder', 'acme/app', null],
      ['Deleted folder', null, 'The folder no longer exists.'],
      ['No git', null, 'The folder is not a Git checkout.'],
      ['Unwatched', null, 'Not a repository this workspace watches.'],
      ['Oldest in the repo', 'acme/app', null],
    ]);
    expect(list[0]).toMatchObject({ sessionId: ID(2), cwd: sub, gitBranch: 'feature', lastActivity: '2026-10-20T10:00:00.000Z' });
    expect(list[0].bytes).toBeGreaterThan(0);
  });

  it('reads only the newest files up to the limit', async () => {
    for (let i = 1; i <= 3; i++) {
      await writeConversation(repo, ID(i), [prompt(repo, `p${i}`)], new Date(Date.UTC(2026, 9, i)));
    }
    const list = await listClaudeConversations(['acme/app'], { projectsDir: projects, limit: 2 });
    expect(list.map((c) => c.firstPrompt)).toEqual(['p3', 'p2']);
  });

  it('returns nothing when there is no projects folder', async () => {
    expect(await listClaudeConversations(['acme/app'], { projectsDir: path.join(directory, 'missing') })).toEqual([]);
  });
});

describe('prepareClaudeImport', () => {
  const git = (...args: string[]) => runGit(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args]);
  const sha = (file: Buffer) => createHash('sha256').update(file).digest('hex');

  async function remoteAtHead(): Promise<string> {
    const base = await runGit(repo, ['rev-parse', 'HEAD']);
    await runGit(repo, ['update-ref', 'refs/remotes/origin/main', base]);
    await runGit(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    return base;
  }

  function split(body: Uint8Array) {
    const buf = Buffer.from(body);
    const nl = buf.indexOf(0x0a);
    const header = JSON.parse(buf.subarray(0, nl).toString('utf8')) as WorkbenchImportHeader;
    const rest = buf.subarray(nl + 1);
    return {
      header,
      session: gunzipSync(rest.subarray(0, header.sessionBytes)).toString('utf8'),
      patch: header.patchBytes ? gunzipSync(rest.subarray(header.sessionBytes)).toString('utf8') : '',
    };
  }

  it('folds unpushed commits, staged, unstaged and untracked files into one patch and leaves the checkout alone', async () => {
    const base = await remoteAtHead();
    await fs.writeFile(path.join(repo, 'committed.txt'), 'unpushed\n');
    await git('add', 'committed.txt');
    await git('commit', '-q', '-m', 'local only');
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'edited\n');
    await fs.writeFile(path.join(repo, 'staged.txt'), 'staged\n');
    await git('add', 'staged.txt');
    await fs.mkdir(path.join(repo, 'new dir'));
    await fs.writeFile(path.join(repo, 'new dir', 'untracked.txt'), 'brand new\n');
    await fs.writeFile(path.join(repo, 'image.bin'), Buffer.from([0, 1, 2, 255, 0, 7]));
    await fs.writeFile(path.join(repo, '.env.local'), 'SECRET=1\n');
    const id = ID(9);
    await writeConversation(repo, id, [prompt(repo, 'Continue me')]);

    const indexBefore = sha(await fs.readFile(path.join(repo, '.git', 'index')));
    const headBefore = await runGit(repo, ['rev-parse', 'HEAD']);
    const statusBefore = await runGit(repo, ['status', '--porcelain']);

    const prepared = await prepareClaudeImport({ sessionId: id, cwd: repo }, { projectsDir: projects });
    expect(prepared.base).toBe(base);
    expect(prepared.untrackedFiles).toBe(2);
    const { header, session, patch } = split(prepared.body);
    expect(header).toMatchObject({ agent: 'claude', sessionId: id, cwd: repo, root: repo, base });
    expect(header.sessionBytes).toBe(prepared.sessionBytes);
    expect(session).toContain('Continue me');
    for (const name of ['committed.txt', 'tracked.txt', 'staged.txt', 'new dir/untracked.txt', 'image.bin']) {
      expect(patch).toContain(`b/${name}`);
    }
    expect(patch).toContain('GIT binary patch');
    expect(patch).not.toContain('.env.local');

    // Nothing on the user's side moved.
    expect(sha(await fs.readFile(path.join(repo, '.git', 'index')))).toBe(indexBefore);
    expect(await runGit(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await runGit(repo, ['status', '--porcelain'])).toBe(statusBefore);

    // The patch rebuilds the working tree on a clean checkout of the base.
    const copy = path.join(directory, 'copy');
    await runGit(directory, ['clone', '-q', repo, copy]);
    await runGit(copy, ['checkout', '-q', base]);
    const patchFile = path.join(directory, 'changes.patch');
    await fs.writeFile(patchFile, patch);
    await runGit(copy, ['apply', '--binary', '--whitespace=nowarn', patchFile]);
    for (const name of ['committed.txt', 'tracked.txt', 'staged.txt', 'new dir/untracked.txt', 'image.bin']) {
      expect((await fs.readFile(path.join(copy, name))).equals(await fs.readFile(path.join(repo, name)))).toBe(true);
    }
  });

  it('sends an empty patch for a clean checkout at the base', async () => {
    await remoteAtHead();
    const id = ID(10);
    await writeConversation(repo, id, [prompt(repo, 'Clean')]);
    const { patch, header } = split((await prepareClaudeImport({ sessionId: id, cwd: repo }, { projectsDir: projects })).body);
    expect(patch).toBe('');
    expect(header.patchBytes).toBeGreaterThan(0);
  });

  it('falls back to the upstream when origin/HEAD is not set', async () => {
    const base = await runGit(repo, ['rev-parse', 'HEAD']);
    await runGit(repo, ['update-ref', 'refs/remotes/origin/trunk', base]);
    await runGit(repo, ['branch', '--set-upstream-to=origin/trunk', 'main']);
    expect(await remoteBaseRef(repo)).toBe('origin/trunk');
  });

  it.each([
    ['a bad id', { sessionId: 'nope' }, 'not a Claude Code conversation id'],
    ['a missing conversation', { sessionId: ID(99) }, 'Could not find that conversation'],
  ])('refuses %s', async (_label, input, message) => {
    await remoteAtHead();
    await expect(prepareClaudeImport({ cwd: repo, ...input }, { projectsDir: projects })).rejects.toThrow(message);
  });

  it('refuses when no remote default branch is known', async () => {
    const id = ID(11);
    await writeConversation(repo, id, [prompt(repo, 'x')]);
    await expect(prepareClaudeImport({ sessionId: id, cwd: repo }, { projectsDir: projects })).rejects.toThrow('Run git fetch');
  });

  it('refuses a folder that is not a checkout', async () => {
    const plain = path.join(os.tmpdir(), `talyn-plain-${process.pid}`);
    await fs.mkdir(plain, { recursive: true });
    const id = ID(12);
    await writeConversation(plain, id, [prompt(plain, 'x')]);
    try {
      await expect(prepareClaudeImport({ sessionId: id, cwd: plain }, { projectsDir: projects })).rejects.toThrow('not a Git checkout');
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  it('refuses changes over the limit instead of cutting them', async () => {
    await remoteAtHead();
    const id = ID(13);
    await writeConversation(repo, id, [prompt(repo, 'x')]);
    await fs.writeFile(path.join(repo, 'big.bin'), Buffer.from(Array.from({ length: 200_000 }, () => Math.floor(Math.random() * 256))));
    await expect(prepareClaudeImport({ sessionId: id, cwd: repo }, { projectsDir: projects, maxBytes: 50_000 })).rejects.toThrow(
      'Remove large untracked files',
    );
  });
});
