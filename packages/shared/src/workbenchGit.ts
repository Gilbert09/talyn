/**
 * Git for workbenches, as data: argv builders and output parsers, with NO
 * execution here.
 *
 * Both runtimes run the same commands. The local runtime runs each step with
 * `execFile` (no shell); the sandbox runtime prefers one `/exec` round trip, so
 * {@link toShellScript} turns a step list into one POSIX `sh` script. Keeping
 * the argv in one place is what stops the two from disagreeing about, say,
 * whether untracked files count as changes.
 *
 * Steps can pass a value to a later step: a step with `capture: 'tree'` stores
 * its trimmed stdout, and a later argv element `{{tree}}` receives it. A
 * step-by-step runner resolves that with {@link resolveStepArgv}; the shell
 * script uses a variable.
 */
import type { WorkbenchChangedFile, WorkbenchChangedFileStatus, WorkbenchDiffStat } from './workbench.js';

// ============================================================================
// Steps
// ============================================================================

export interface GitStep {
  /** argv[0] is the program — `git` for every git op; a few cleanup steps use `rm` or `printf`. */
  argv: string[];
  /** Extra environment for this step only (e.g. `GIT_INDEX_FILE`). */
  env?: Record<string, string>;
  /** A non-zero exit does not stop the sequence. */
  allowFailure?: boolean;
  /** Store this step's trimmed stdout under this name for later `{{name}}` placeholders. */
  capture?: string;
}

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Fill `{{name}}` placeholders from earlier captures. Throws on a missing capture. */
export function resolveStepArgv(step: GitStep, captures: Record<string, string>): string[] {
  return step.argv.map((arg) =>
    arg.replace(PLACEHOLDER, (_m, name: string) => {
      if (!Object.prototype.hasOwnProperty.call(captures, name)) {
        throw new Error(`git step references {{${name}}} before any step captured it`);
      }
      return captures[name];
    })
  );
}

/**
 * Quote one argument for POSIX `sh`. Safe characters pass through unchanged so
 * a script stays readable in a log; everything else is single-quoted, with each
 * embedded `'` closed, escaped and reopened (`'\''`). Inside single quotes `sh`
 * interprets nothing — not `$`, not backticks, not backslashes, not newlines.
 */
export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_\-.,:/@%+=]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function captureVar(name: string): string {
  return `talyn_${name}`;
}

/** One argv element as shell text, with placeholders turned into quoted variable expansions. */
function shellWord(arg: string): string {
  const parts: string[] = [];
  let last = 0;
  for (const match of arg.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(shellQuote(arg.slice(last, index)));
    parts.push(`"$${captureVar(match[1])}"`);
    last = index + match[0].length;
  }
  if (last < arg.length || parts.length === 0) parts.push(shellQuote(arg.slice(last)));
  return parts.join('');
}

/**
 * The steps as one POSIX `sh` script, for a runtime that wants one round trip.
 *
 * `set -eu`: the script stops at the first failing step (unless the step allows
 * failure) and at any unset variable. Captures become `talyn_<name>` variables
 * — prefixed so a capture can never shadow `PATH` or `HOME`. Step env is a
 * command prefix, so it applies to that one command only.
 */
export function toShellScript(steps: GitStep[]): string {
  const lines = ['set -eu'];
  for (const step of steps) {
    if (step.argv.length === 0) throw new Error('git step has an empty argv');
    const env = Object.entries(step.env ?? {}).map(([key, value]) => {
      if (!ENV_NAME.test(key)) throw new Error(`invalid environment variable name: ${key}`);
      return `${key}=${shellWord(value)}`;
    });
    let command = [...env, ...step.argv.map(shellWord)].join(' ');
    if (step.capture) {
      if (!ENV_NAME.test(step.capture)) throw new Error(`invalid capture name: ${step.capture}`);
      command = `${captureVar(step.capture)}=$(${command})`;
    }
    if (step.allowFailure) command = `${command} || true`;
    lines.push(command);
  }
  return `${lines.join('\n')}\n`;
}

// ============================================================================
// Simple ops
// ============================================================================

const git = (...argv: string[]): GitStep => ({ argv: ['git', ...argv] });

/** stdout: the merge-base sha of HEAD and `base`. */
export function mergeBase(base: string): GitStep {
  return git('merge-base', 'HEAD', base);
}

/** stdout: the HEAD sha. */
export function headSha(): GitStep {
  return git('rev-parse', 'HEAD');
}

/**
 * Working tree (staged and unstaged) vs `sha`, as `parseNumstatZ` input. Pass
 * the merge-base sha, not the base branch: diffing against the branch tip
 * would show the base's own new commits as reverted on this branch.
 */
export function diffNumstat(sha: string): GitStep {
  return git('diff', '--numstat', '-z', '--find-renames', sha, '--');
}

/** The same diff as `--name-status`, which is where added/deleted/renamed comes from. */
export function diffNameStatus(sha: string): GitStep {
  return git('diff', '--name-status', '-z', '--find-renames', sha, '--');
}

/** Untracked, not ignored — the files a diff against a commit cannot see. */
export function untrackedFiles(): GitStep {
  return git('ls-files', '--others', '--exclude-standard', '-z');
}

/** Every file a file tree should show: tracked plus untracked, gitignored excluded. */
export function listFiles(): GitStep {
  return git('ls-files', '--cached', '--others', '--exclude-standard', '-z');
}

/** Unified patch text vs `sha`, for one path or all of them. */
export function diffPatch(sha: string, path?: string): GitStep {
  const argv = ['diff', '--no-color', '--find-renames', sha, '--'];
  if (path) argv.push(path);
  return git(...argv);
}

/**
 * The patch for one UNTRACKED file, as an addition. `git diff --no-index`
 * exits 1 when the files differ, which here is always, so failure is allowed.
 */
export function untrackedFilePatch(path: string): GitStep {
  return { argv: ['git', 'diff', '--no-color', '--no-index', '--', '/dev/null', path], allowFailure: true };
}

export function statusPorcelain(): GitStep {
  return git('status', '--porcelain=v2', '-z', '--branch');
}

/** Rename the current branch. Validate with {@link isValidBranchName} first. */
export function renameBranch(newName: string): GitStep {
  return git('branch', '-m', newName);
}

export function fetchOrigin(): GitStep {
  return git('fetch', '--prune', 'origin');
}

/** A new branch `branch` from `base`, checked out at `path`. */
export function worktreeAdd(path: string, branch: string, base: string): GitStep {
  return git('worktree', 'add', '-b', branch, path, base);
}

/** An existing branch checked out at `path` (a workbench opened from a PR). */
export function worktreeAddExisting(path: string, branch: string): GitStep {
  return git('worktree', 'add', path, branch);
}

/** `force` discards uncommitted changes in the worktree; without it git refuses a dirty one. */
export function worktreeRemove(path: string, opts: { force?: boolean } = {}): GitStep {
  return opts.force ? git('worktree', 'remove', '--force', path) : git('worktree', 'remove', path);
}

/** Exit 0: a merge is in progress (MERGE_HEAD exists). Exit 1: none. Never fails otherwise. */
export function isMergeInProgress(): GitStep {
  return { argv: ['git', 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], allowFailure: true };
}

/** Interpret {@link isMergeInProgress}'s exit code. */
export function mergeInProgressFromExit(exitCode: number): boolean {
  return exitCode === 0;
}

/**
 * Git's ref-name rules (`git check-ref-format --branch`), the subset that
 * matters for a name a person or an agent typed.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.endsWith('.lock') || name === '@' || name === 'HEAD') return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  // Control characters, space, and ~ ^ : ? * [ \ are never allowed.
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(ch)) return false;
  }
  return !name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'));
}

// ============================================================================
// Checkpoints
// ============================================================================

export const CHECKPOINT_REF_PREFIX = 'refs/talyn/checkpoints';

export function checkpointRef(chatId: string, turn: number): string {
  if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error(`invalid chat id for a checkpoint ref: ${chatId}`);
  if (!Number.isInteger(turn) || turn < 0) throw new Error(`invalid turn for a checkpoint ref: ${turn}`);
  return `${CHECKPOINT_REF_PREFIX}/${chatId}/${turn}`;
}

/** Identity for the hidden commit, so a fresh sandbox with no `user.name` can still make one. */
const CHECKPOINT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Talyn',
  GIT_AUTHOR_EMAIL: 'checkpoints@talyn.dev',
  GIT_COMMITTER_NAME: 'Talyn',
  GIT_COMMITTER_EMAIL: 'checkpoints@talyn.dev',
};

/**
 * Snapshot the working tree as a hidden commit, without touching the branch,
 * HEAD or the real index.
 *
 * Everything is staged into a TEMPORARY index (`GIT_INDEX_FILE`), seeded with a
 * copy of the real one, so the user's own staging is never disturbed. `add -A` picks up
 * modified, deleted and untracked files (gitignored ones excluded). The tree
 * is committed with HEAD as its parent — so `<sha>^` is where the branch was —
 * and pinned under `refs/talyn/checkpoints/<chat>/<turn>` so `gc` keeps it.
 * The last step prints the checkpoint sha.
 *
 * `tmpIndexPath` must be a path the runtime owns (e.g. under `$TMPDIR`), not
 * inside the worktree. Requires HEAD to exist (a repository with one commit).
 */
export function checkpointCreateSteps(opts: { chatId: string; turn: number; tmpIndexPath: string }): GitStep[] {
  const ref = checkpointRef(opts.chatId, opts.turn);
  const index = { GIT_INDEX_FILE: opts.tmpIndexPath };
  return [
    // A COPY of the real index rather than `read-tree HEAD`: the copy carries
    // stat data, so `add -A` re-hashes only files that changed instead of the
    // whole tree, and a file the user force-added survives.
    { argv: ['git', 'rev-parse', '--git-path', 'index'], capture: 'realIndex' },
    { argv: ['cp', '{{realIndex}}', opts.tmpIndexPath] },
    { argv: ['git', 'add', '-A', '--', '.'], env: index },
    { argv: ['git', 'write-tree'], env: index, capture: 'tree' },
    {
      argv: ['git', 'commit-tree', '{{tree}}', '-p', 'HEAD', '-m', `talyn checkpoint ${opts.chatId} turn ${opts.turn}`],
      env: CHECKPOINT_IDENTITY,
      capture: 'commit',
    },
    { argv: ['git', 'update-ref', ref, '{{commit}}'] },
    { argv: ['rm', '-f', opts.tmpIndexPath], allowFailure: true },
    { argv: ['printf', '%s\\n', '{{commit}}'] },
  ];
}

/**
 * Put the working tree back exactly as it was at a checkpoint, without moving
 * the branch, HEAD or the real index.
 *
 * The sequence, and why each step is safe:
 *
 *  1. `read-tree <sha>` into a TEMPORARY index — the checkpoint's file list.
 *  2. `checkout-index -a -f` from that index writes every checkpoint file into
 *     the working tree, overwriting edits and recreating deleted files.
 *  3. `clean -fd` against that same temporary index removes files that are not
 *     in the checkpoint. Because the temp index is the checkpoint, "untracked"
 *     here means "created after the checkpoint". Without `-x`, gitignored files
 *     (`node_modules`, `.env`, build output) are KEPT; without a second `-f`,
 *     nested git repositories are kept too.
 *  4. Remove the temporary index.
 *
 * What it does not do: the real index keeps whatever was staged, so
 * `git status` may show staged changes relative to the restored files. HEAD is
 * not moved either — if the agent COMMITTED after the checkpoint, the restored
 * tree shows as uncommitted changes that undo those commits, which is what the
 * user asked for without rewriting history. Callers should take a checkpoint
 * of the current state first, so a restore can itself be undone.
 */
export function checkpointRestoreSteps(opts: { sha: string; tmpIndexPath: string }): GitStep[] {
  if (!/^[0-9a-f]{7,64}$/i.test(opts.sha)) throw new Error(`invalid checkpoint sha: ${opts.sha}`);
  const index = { GIT_INDEX_FILE: opts.tmpIndexPath };
  return [
    { argv: ['git', 'read-tree', opts.sha], env: index },
    { argv: ['git', 'checkout-index', '-a', '-f'], env: index },
    { argv: ['git', 'clean', '-fd', '--', '.'], env: index },
    { argv: ['rm', '-f', opts.tmpIndexPath], allowFailure: true },
  ];
}

/** Every checkpoint ref of a chat: `<sha> <ref>` per line. */
export function listCheckpointRefs(chatId: string): GitStep {
  return git('for-each-ref', '--format=%(objectname) %(refname)', `${CHECKPOINT_REF_PREFIX}/${chatId}/`);
}

/** Delete a chat's checkpoint refs (archive / delete). One step per ref. */
export function deleteCheckpointRef(ref: string): GitStep {
  return { argv: ['git', 'update-ref', '-d', ref], allowFailure: true };
}

/** Parse {@link listCheckpointRefs} output into `{turn, ref, sha}`, sorted by turn. */
export function parseCheckpointRefs(output: string): Array<{ turn: number; ref: string; sha: string }> {
  const out: Array<{ turn: number; ref: string; sha: string }> = [];
  for (const line of output.split('\n')) {
    const match = /^([0-9a-f]+) (refs\/talyn\/checkpoints\/[^/]+\/(\d+))$/.exec(line.trim());
    if (match) out.push({ sha: match[1], ref: match[2], turn: Number(match[3]) });
  }
  return out.sort((a, b) => a.turn - b.turn);
}

// ============================================================================
// Parsers
// ============================================================================

export interface NumstatEntry {
  path: string;
  oldPath?: string;
  /** Null for a binary file. */
  added: number | null;
  removed: number | null;
  binary: boolean;
}

/**
 * `git diff --numstat -z` output.
 *
 * Each record is `added\tremoved\tpath\0`; a rename leaves the path empty and
 * follows with `old\0new\0`; a binary file has `-` counts. With `-z` paths are
 * verbatim — no quoting, tabs and newlines included.
 */
export function parseNumstatZ(output: string): NumstatEntry[] {
  const fields = output.split('\0');
  const out: NumstatEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(field);
    if (!match) continue;
    const binary = match[1] === '-' && match[2] === '-';
    const added = match[1] === '-' ? null : Number(match[1]);
    const removed = match[2] === '-' ? null : Number(match[2]);
    if (match[3] === '') {
      const oldPath = fields[i + 1];
      const path = fields[i + 2];
      i += 2;
      if (!path || !oldPath) break;
      out.push({ path, oldPath, added, removed, binary });
    } else {
      out.push({ path: match[3], added, removed, binary });
    }
  }
  return out;
}

export interface NameStatusEntry {
  status: WorkbenchChangedFileStatus;
  path: string;
  oldPath?: string;
}

/**
 * `git diff --name-status -z` output: `M\0path\0`, `R100\0old\0new\0`,
 * `C075\0src\0dst\0`. A copy reads as added (the source is unchanged); a type
 * change (`T`) reads as modified; `U` (unmerged) as modified too.
 */
export function parseNameStatus(output: string): NameStatusEntry[] {
  const fields = output.split('\0');
  const out: NameStatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = fields[i + 1];
      const path = fields[i + 2];
      i += 2;
      if (!path || !oldPath) break;
      out.push(letter === 'R' ? { status: 'renamed', path, oldPath } : { status: 'added', path });
      continue;
    }
    const path = fields[i + 1];
    i += 1;
    if (!path) break;
    const status: WorkbenchChangedFileStatus = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
    out.push({ status, path });
  }
  return out;
}

/** NUL-separated path list (`ls-files -z`). */
export function parseNulList(output: string): string[] {
  return output.split('\0').filter((p) => p.length > 0);
}

/** Lines in a text file the way `git diff --numstat` counts an added file. */
export function countLines(content: string): number {
  if (!content) return 0;
  const newlines = content.split('\n').length - 1;
  return content.endsWith('\n') ? newlines : newlines + 1;
}

/**
 * The changed-file list a diff panel shows: tracked changes (numstat for the
 * counts, name-status for the kind) plus untracked files as additions.
 * `untrackedLineCounts` supplies an untracked file's line count when the
 * runtime read it; otherwise it counts 0 rather than guessing.
 */
export function mergeChangedFiles(input: {
  numstat: string;
  nameStatus: string;
  untracked?: string;
  untrackedLineCounts?: Record<string, number>;
}): WorkbenchChangedFile[] {
  const statusByPath = new Map(parseNameStatus(input.nameStatus).map((e) => [e.path, e]));
  const files = new Map<string, WorkbenchChangedFile>();
  for (const entry of parseNumstatZ(input.numstat)) {
    const kind = statusByPath.get(entry.path);
    const status: WorkbenchChangedFileStatus = kind?.status ?? (entry.oldPath ? 'renamed' : 'modified');
    const file: WorkbenchChangedFile = {
      path: entry.path,
      status,
      added: entry.added ?? 0,
      removed: entry.removed ?? 0,
      binary: entry.binary,
    };
    const oldPath = entry.oldPath ?? kind?.oldPath;
    if (oldPath && status === 'renamed') file.oldPath = oldPath;
    files.set(entry.path, file);
  }
  for (const path of parseNulList(input.untracked ?? '')) {
    if (files.has(path)) continue;
    files.set(path, {
      path,
      status: 'added',
      added: input.untrackedLineCounts?.[path] ?? 0,
      removed: 0,
      binary: false,
    });
  }
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function diffStatOf(files: WorkbenchChangedFile[]): WorkbenchDiffStat {
  return files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed, files: acc.files + 1 }),
    { added: 0, removed: 0, files: 0 }
  );
}

export interface FilePatch {
  path: string;
  oldPath?: string;
  patch: string;
}

/** Strip git's `a/` / `b/` prefix and C-style quoting from a patch header path. */
function patchPath(raw: string): string | null {
  let value = raw.trim();
  if (value === '/dev/null') return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value
      .slice(1, -1)
      .replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/\\(["\\])/g, '$1')
      .replace(/\\t/g, '\t')
      .replace(/\\n/g, '\n');
  }
  return value.replace(/^[ab]\//, '');
}

/**
 * Split a multi-file unified diff into one patch per file.
 *
 * The path comes from `+++` (or `---` for a deletion), or from `rename from` /
 * `rename to`, and only falls back to the `diff --git a/x b/y` header — that
 * header is ambiguous when a path contains ` b/`. A binary file has no
 * `---`/`+++` lines, so the header is the only source there.
 */
export function splitUnifiedDiff(patch: string): FilePatch[] {
  if (!patch.trim()) return [];
  const chunks: string[] = [];
  const lines = patch.split('\n');
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) chunks.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) chunks.push(current.join('\n'));

  return chunks.map((chunk) => {
    const chunkLines = chunk.split('\n');
    let minus: string | null | undefined;
    let plus: string | null | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    for (const line of chunkLines) {
      if (line.startsWith('@@')) break;
      if (line.startsWith('--- ')) minus = patchPath(line.slice(4));
      else if (line.startsWith('+++ ')) plus = patchPath(line.slice(4));
      else if (line.startsWith('rename from ')) renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) renameTo = line.slice('rename to '.length);
    }
    let path = renameTo ?? plus ?? minus ?? undefined;
    if (!path) {
      const header = /^diff --git a\/(.*) b\/(.*)$/.exec(chunkLines[0]);
      path = header ? header[2] : chunkLines[0].slice('diff --git '.length);
    }
    const oldPath = renameFrom ?? (minus && plus && minus !== plus ? minus : undefined);
    const text = chunk.endsWith('\n') ? chunk : `${chunk}\n`;
    return oldPath ? { path, oldPath, patch: text } : { path, patch: text };
  });
}

export interface PorcelainStatus {
  /** HEAD sha, or null on an unborn branch. */
  oid: string | null;
  /** Branch name, or null when detached. */
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Unmerged paths — a merge or rebase stopped on these. */
  conflicted: string[];
  /** Tracked paths with staged or unstaged changes. */
  changed: string[];
  untracked: string[];
  /** Any change, conflict or untracked file. */
  dirty: boolean;
}

/**
 * `git status --porcelain=v2 -z --branch`.
 *
 * Records are NUL-terminated. Headers are `# branch.oid|head|upstream|ab …`;
 * entries are `1` (changed), `2` (renamed/copied — followed by the original
 * path as its own NUL field), `u` (unmerged), `?` (untracked), `!` (ignored).
 */
export function parsePorcelainV2(output: string): PorcelainStatus {
  const status: PorcelainStatus = {
    oid: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    conflicted: [],
    changed: [],
    untracked: [],
    dirty: false,
  };
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record) continue;
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') status.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') status.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          status.ahead = Number(match[1]);
          status.behind = Number(match[2]);
        }
      }
      continue;
    }
    const type = record[0];
    if (type === '1') {
      // 1 XY sub mH mI mW hH hI path — the path is everything after 8 spaces.
      status.changed.push(afterFields(record, 8));
    } else if (type === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path, then origPath as the next field.
      status.changed.push(afterFields(record, 9));
      i += 1;
    } else if (type === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      status.conflicted.push(afterFields(record, 10));
    } else if (type === '?') {
      status.untracked.push(record.slice(2));
    }
  }
  status.dirty = status.changed.length + status.conflicted.length + status.untracked.length > 0;
  return status;
}

/** The remainder of `record` after its first `n` space-separated fields. */
function afterFields(record: string, n: number): string {
  let index = 0;
  for (let k = 0; k < n; k++) {
    index = record.indexOf(' ', index) + 1;
    if (index === 0) return '';
  }
  return record.slice(index);
}
