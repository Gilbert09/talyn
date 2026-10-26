import { spawn } from 'child_process';
import { once } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { createGzip, gzip } from 'zlib';
import {
  claudeProjectSlug,
  claudePromptText,
  isClaudeSessionId,
  WORKBENCH_IMPORT_MAX_BYTES,
  type WorkbenchImportHeader,
} from '@talyn/shared';
import type { ClaudeConversation, ClaudeImportPrepared } from '../../workbenchBridgeTypes';
import { matchingRemote, readCheckoutConfig } from './detectCheckouts';
import { processEnv } from './environment';

/**
 * Local Claude Code conversations, for "Continue a Claude Code conversation".
 * `listClaudeConversations` reads only the head and tail of each file.
 * `prepareClaudeImport` builds the upload body the backend's import route
 * takes (framing in `claudeSessionImport.ts`). Neither writes to the user's
 * checkout or its index, and neither fetches or pushes.
 */

const gzipAsync = promisify(gzip);

/** Bytes read from each end of a file by the list. A first prompt and a title fit in this. */
const PEEK_BYTES = 64 * 1024;
/** The newest conversations the list keeps. */
export const LIST_LIMIT = 100;
/** Bytes read from each end of a file to spot a script run: the first lines of a CLI conversation fit. */
const SCRIPT_CHECK_BYTES = 8 * 1024;
/** Files checked at once for their entrypoint: two small reads each, well under the open-file limit. */
const SCRIPT_CHECK_BATCH = 64;

export function claudeProjectsDir(): string {
  const config = process.env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(config || path.join(os.homedir(), '.claude'), 'projects');
}

type Json = Record<string, unknown>;

function parseLines(text: string): Json[] {
  const out: Json[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Json);
    } catch {
      // A line cut by the read window, or not JSON.
    }
  }
  return out;
}

const RAW_FIELDS = ['entrypoint', 'cwd', 'gitBranch'] as const;

/**
 * The metadata fields as they first appear in raw text. A first prompt can be
 * longer than the read window, and then no complete line carries them.
 * Content that quotes these keys is escaped (`\"cwd\":`), so it does not match.
 */
export function rawFields(text: string): Json | null {
  const out: Json = {};
  for (const key of RAW_FIELDS) {
    const m = new RegExp(`(?<!\\\\)"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
    if (!m) continue;
    try {
      out[key] = JSON.parse(`"${m[1]}"`);
    } catch {
      // Not a JSON string.
    }
  }
  return Object.keys(out).length ? out : null;
}

/** The complete lines in the first and the last `PEEK_BYTES` of a file. */
export async function peekFile(file: string, size: number): Promise<{ head: Json[]; tail: Json[] }> {
  const handle = await fs.open(file, 'r');
  try {
    const headBuf = Buffer.alloc(Math.min(PEEK_BYTES, size));
    await handle.read(headBuf, 0, headBuf.length, 0);
    const rawHead = headBuf.toString('utf8');
    const fields = rawFields(rawHead);
    let headText = rawHead;
    if (size > PEEK_BYTES) headText = headText.slice(0, headText.lastIndexOf('\n') + 1);
    const head = [...parseLines(headText), ...(fields ? [fields] : [])];
    if (size <= PEEK_BYTES) return { head, tail: parseLines(headText) };
    const tailLength = Math.min(PEEK_BYTES, size);
    const tailBuf = Buffer.alloc(tailLength);
    await handle.read(tailBuf, 0, tailLength, size - tailLength);
    const tailText = tailBuf.toString('utf8');
    return { head, tail: parseLines(tailText.slice(tailText.indexOf('\n') + 1)) };
  } finally {
    await handle.close();
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * A conversation a program started through the Claude Agent SDK, not a person.
 * Its lines say `entrypoint: "sdk-…"`, or its prompts say `promptSource: "sdk"`
 * (an SDK run started from an editor reports the editor's entrypoint), and its
 * file queues its prompt before the first user line, which a person cannot do.
 */
export function isScriptRun(lines: Json[], opts: { raw?: string; fileStart?: boolean } = {}): boolean {
  if (opts.fileStart) {
    // A person cannot queue a prompt before the first one has started; the SDK queues its input.
    for (const line of lines) {
      if (line.type === 'user') break;
      if (line.type === 'queue-operation') return true;
    }
  }
  for (const line of lines) {
    if (str(line.entrypoint)?.startsWith('sdk-') || line.promptSource === 'sdk') return true;
  }
  return Boolean(opts.raw && /(?<!\\)"(?:promptSource":"sdk"|entrypoint":"sdk-)/.test(opts.raw));
}

/** `isScriptRun` from a small read at each end of the file, before the full peek. */
async function scriptRunAtEnds(file: string, size: number): Promise<boolean> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(SCRIPT_CHECK_BYTES, size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const raw = buffer.toString('utf8', 0, bytesRead);
    const text = bytesRead < size ? raw.slice(0, raw.lastIndexOf('\n') + 1) : raw;
    if (isScriptRun(parseLines(text), { raw, fileStart: true })) return true;
    if (size <= buffer.length) return false;
    // A long first prompt puts the metadata past the window. Every line carries `entrypoint`, so read the end too.
    const { bytesRead: tailRead } = await handle.read(buffer, 0, buffer.length, size - buffer.length);
    const tailText = buffer.toString('utf8', 0, tailRead);
    return isScriptRun(parseLines(tailText.slice(tailText.indexOf('\n') + 1)));
  } finally {
    await handle.close();
  }
}

/** What the head and tail say about one conversation. */
export function summarise(head: Json[], tail: Json[], projectFolder?: string): Pick<ClaudeConversation, 'cwd' | 'gitBranch' | 'title' | 'firstPrompt'> & { lastTimestamp: string | null } {
  const headCwds = head.map((line) => str(line.cwd));
  const tailCwds = tail.map((line) => str(line.cwd));
  const launch = (value: string | null) => Boolean(value && projectFolder && claudeProjectSlug(value) === projectFolder);
  const cwd = headCwds.find(launch) || headCwds.find(Boolean) || tailCwds.find(launch) || tailCwds.find(Boolean) || null;
  let gitBranch: string | null = null;
  let firstPrompt: string | null = null;
  for (const line of head) {
    gitBranch ??= str(line.gitBranch);
    firstPrompt ??= claudePromptText(line);
  }
  for (const line of [...head, ...tail]) {
    if (str(line.cwd) === cwd && str(line.gitBranch)) gitBranch = str(line.gitBranch);
  }
  let title: string | null = null;
  let lastTimestamp: string | null = null;
  let lastPrompt: string | null = null;
  for (const line of tail) {
    if (str(line.timestamp)) lastTimestamp = str(line.timestamp);
    if (line.type === 'ai-title' && str(line.aiTitle)) title = str(line.aiTitle);
    if (line.type === 'summary' && str(line.summary)) title = str(line.summary);
    if (line.type === 'last-prompt' && str(line.lastPrompt)) lastPrompt = str(line.lastPrompt);
  }
  return { cwd, gitBranch, title, firstPrompt: firstPrompt ?? lastPrompt, lastTimestamp };
}

/** The folder holding `.git`, at `dir` or above it; null when there is none or `dir` is gone. */
export async function checkoutRoot(dir: string): Promise<{ root: string; main: boolean } | null> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const stat = await fs.lstat(path.join(current, '.git'));
      if (stat.isDirectory() || stat.isFile()) return { root: current, main: stat.isDirectory() };
    } catch {
      // Not here; look one level up.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function repoForFolder(
  cwd: string | null,
  wanted: Map<string, string>,
): Promise<{ repoFullName: string | null; unavailableReason: string | null }> {
  if (!cwd) return { repoFullName: null, unavailableReason: 'The conversation does not say which folder it ran in.' };
  try {
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('not a folder');
  } catch {
    return { repoFullName: null, unavailableReason: 'The folder no longer exists.' };
  }
  const checkout = await checkoutRoot(cwd);
  if (!checkout) return { repoFullName: null, unavailableReason: 'The folder is not a Git checkout.' };
  const config = await readCheckoutConfig(checkout.root, checkout.main);
  const matches = config ? matchingRemote(config, new Set(wanted.keys())) : new Map<string, boolean>();
  const best = [...matches].sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0];
  if (!best) return { repoFullName: null, unavailableReason: 'Not a repository this workspace watches.' };
  return { repoFullName: wanted.get(best) ?? best, unavailableReason: null };
}

/** Local conversations, newest first, each matched to a watched repository or given the reason it is not. */
export async function listClaudeConversations(
  repoFullNames: string[],
  opts: { projectsDir?: string; limit?: number } = {},
): Promise<ClaudeConversation[]> {
  const root = opts.projectsDir ?? claudeProjectsDir();
  const wanted = new Map(repoFullNames.map((name) => [name.toLowerCase(), name]));
  let folders: string[];
  try {
    folders = await fs.readdir(root);
  } catch {
    return [];
  }
  const files: Array<{ file: string; folder: string; sessionId: string; size: number; mtimeMs: number }> = [];
  for (const folder of folders) {
    let names: string[];
    try {
      names = await fs.readdir(path.join(root, folder));
    } catch {
      continue;
    }
    for (const name of names) {
      const sessionId = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '';
      if (!isClaudeSessionId(sessionId)) continue;
      const file = path.join(root, folder, name);
      try {
        const stat = await fs.stat(file);
        if (stat.isFile() && stat.size > 0) files.push({ file, folder, sessionId, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Removed while listing.
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const repoByFolder = new Map<string, Promise<{ repoFullName: string | null; unavailableReason: string | null }>>();
  const out: ClaudeConversation[] = [];
  const limit = opts.limit ?? LIST_LIMIT;
  const inspect = async (entry: (typeof files)[number]) => {
    try {
      if (await scriptRunAtEnds(entry.file, entry.size)) return null;
      const { head, tail } = await peekFile(entry.file, entry.size);
      if (isScriptRun(head, { fileStart: true }) || isScriptRun(tail)) return null;
      return summarise(head, tail, entry.folder);
    } catch {
      return null;
    }
  };
  // Script runs can be the newest thousands of files, so inspect a batch at a time, in parallel, newest first.
  for (let i = 0; i < files.length && out.length < limit; i += SCRIPT_CHECK_BATCH) {
    const batch = files.slice(i, i + SCRIPT_CHECK_BATCH);
    const summaries = await Promise.all(batch.map(inspect));
    for (let j = 0; j < batch.length && out.length < limit; j += 1) {
      const entry = batch[j];
      const summary = summaries[j];
      if (!summary) continue;
        if (!summary.firstPrompt && !summary.title) continue;
        const key = summary.cwd ?? '';
        if (!repoByFolder.has(key)) repoByFolder.set(key, repoForFolder(summary.cwd, wanted));
        const repo = await repoByFolder.get(key)!;
        out.push({
          sessionId: entry.sessionId,
          cwd: summary.cwd,
          gitBranch: summary.gitBranch,
          title: summary.title,
          firstPrompt: summary.firstPrompt,
          lastActivity: summary.lastTimestamp ?? new Date(entry.mtimeMs).toISOString(),
          bytes: entry.size,
          ...repo,
        });
    }
  }
  return out;
}

// ============================================================================
// Prepare
// ============================================================================

interface Run {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** Git with buffer output. `GIT_OPTIONAL_LOCKS=0` stops a read from refreshing the user's index. */
async function runGit(cwd: string, args: string[], sink?: (chunk: Buffer) => Promise<void>): Promise<Run> {
  const env = { ...(await processEnv()), GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  exited.catch(() => undefined);
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      if (sink) await sink(chunk);
      else out.push(chunk);
    }
  } catch (err) {
    child.kill();
    throw err;
  }
  return { code: await exited, stdout: Buffer.concat(out), stderr };
}

async function gitText(cwd: string, ...args: string[]): Promise<string | null> {
  const run = await runGit(cwd, args);
  return run.code === 0 ? run.stdout.toString('utf8').trim() : null;
}

/** The remote's default branch as `origin/<name>`, else the branch's upstream, else null. */
export async function remoteBaseRef(root: string): Promise<string | null> {
  const head = await gitText(root, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
  if (head?.startsWith('refs/remotes/')) return head.slice('refs/remotes/'.length);
  const upstream = await gitText(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
  if (upstream) return upstream;
  for (const name of ['origin/main', 'origin/master']) {
    if (await gitText(root, 'rev-parse', '--verify', '--quiet', `${name}^{commit}`)) return name;
  }
  return null;
}

class TooLargeError extends Error {}

const DIFF_ARGS = ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];

function megabytes(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

/** The conversation file for `sessionId`: under the folder's own slug first, else anywhere in projects. */
export async function findSessionFile(sessionId: string, cwd: string, projectsDir = claudeProjectsDir()): Promise<string | null> {
  const direct = path.join(projectsDir, claudeProjectSlug(cwd), `${sessionId}.jsonl`);
  try {
    if ((await fs.stat(direct)).isFile()) return direct;
  } catch {
    // Look in the other folders.
  }
  let folders: string[] = [];
  try {
    folders = await fs.readdir(projectsDir);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const candidate = path.join(projectsDir, folder, `${sessionId}.jsonl`);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Not in this folder.
    }
  }
  return null;
}

/**
 * The upload body for one conversation: its file, and every change from the
 * commit the branch shares with the remote's default branch to the working
 * tree — unpushed commits, staged and unstaged edits, and untracked files.
 * Refuses, with sizes, anything over the import limit.
 */
export async function prepareClaudeImport(
  input: { sessionId: string; cwd: string },
  opts: { projectsDir?: string; maxBytes?: number } = {},
): Promise<ClaudeImportPrepared> {
  const maxBytes = opts.maxBytes ?? WORKBENCH_IMPORT_MAX_BYTES;
  if (!isClaudeSessionId(input.sessionId)) throw new Error('That is not a Claude Code conversation id.');
  const file = await findSessionFile(input.sessionId, input.cwd, opts.projectsDir);
  if (!file) throw new Error('Could not find that conversation on this machine.');
  const checkout = await checkoutRoot(input.cwd);
  if (!checkout) throw new Error(`${input.cwd} is not a Git checkout.`);
  const root = (await gitText(checkout.root, 'rev-parse', '--show-toplevel')) ?? checkout.root;

  const baseRef = await remoteBaseRef(root);
  if (!baseRef) throw new Error('Could not find the remote default branch. Run git fetch, then try again.');
  const base = await gitText(root, 'merge-base', 'HEAD', baseRef);
  if (!base || !/^[0-9a-f]{40}$/.test(base)) {
    throw new Error(`This branch shares no commit with ${baseRef}. Run git fetch, then try again.`);
  }

  const sessionGz = await gzipAsync(await fs.readFile(file));
  const headerReserve = 4096;
  const budget = maxBytes - sessionGz.length - headerReserve;
  if (budget < 0) {
    throw new Error(`The conversation is ${megabytes(sessionGz.length)} compressed; one import can take ${megabytes(maxBytes)}.`);
  }

  const untracked = (await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean);

  const zip = createGzip();
  const parts: Buffer[] = [];
  let patchBytes = 0;
  zip.on('data', (chunk: Buffer) => {
    parts.push(chunk);
    patchBytes += chunk.length;
  });
  const finished = once(zip, 'end');
  const sink = async (chunk: Buffer) => {
    if (patchBytes > budget) throw new TooLargeError();
    if (!zip.write(chunk)) await once(zip, 'drain');
  };
  try {
    const tracked = await runGit(root, [...DIFF_ARGS, base, '--'], sink);
    if (tracked.code !== 0) throw new Error(`Could not read your changes: ${tracked.stderr.trim().slice(-200)}`);
    for (const rel of untracked) {
      const run = await runGit(root, [...DIFF_ARGS, '--no-index', '--', '/dev/null', rel], sink);
      if (run.code !== 0 && run.code !== 1) throw new Error(`Could not read ${rel}: ${run.stderr.trim().slice(-200)}`);
    }
  } catch (err) {
    zip.destroy();
    if (err instanceof TooLargeError) {
      throw new Error(
        `Your changes are more than ${megabytes(budget)} compressed with this conversation; one import can take ${megabytes(maxBytes)}. Remove large untracked files, then try again.`,
      );
    }
    throw err;
  }
  zip.end();
  await finished;
  const patchGz = Buffer.concat(parts);

  const header: WorkbenchImportHeader = {
    agent: 'claude',
    sessionId: input.sessionId,
    cwd: input.cwd,
    root,
    base,
    sessionBytes: sessionGz.length,
    patchBytes: patchGz.length,
  };
  const body = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), sessionGz, patchGz]);
  if (body.length > maxBytes) {
    throw new Error(`The conversation and your changes are ${megabytes(body.length)} compressed; one import can take ${megabytes(maxBytes)}.`);
  }
  return { body, sessionBytes: sessionGz.length, patchBytes: patchGz.length, base, root, untrackedFiles: untracked.length };
}
