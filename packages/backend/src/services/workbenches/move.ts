import { shellQuote, WORKBENCH_IMPORT_MAX_BYTES } from '@talyn/shared';
import { runWithoutScope } from '../../db/client.js';
import { FleetRunNotFoundError, type FleetSandbox } from '../selfHosted/client.js';
import { refreshDiffStat } from './changes.js';
import {
  DISK_PROBE_SCRIPT,
  grownDiskMib,
  LOW_DISK_BYTES,
  parseDiskProbe,
  type DiskProbe,
} from './execFailures.js';
import { emitWorkbenchChat, emitWorkbenchEvents, emitWorkbenchUpdated } from './emit.js';
import { userFacingError } from './errors.js';
import { publicWorkbench } from './prLink.js';
import { recoverLostSandbox } from './recovery.js';
import {
  cloneScript,
  fleetClientFor,
  loadWorkbenchConfig,
  nextSandboxId,
  recordWorkbenchEvent,
  runCapture,
  sandboxGeneration,
  sandboxIdFor,
} from './sandboxRuntime.js';
import { writeSandboxFiles } from './sandboxFiles.js';
import { startScript, stopAllScripts } from './scripts.js';
import {
  appendEvents,
  claimMove,
  commitMove,
  getWorkbench,
  listChats,
  movingWorkbenches,
  otherRunningChats,
  releaseMove,
  rowToChat,
  updateChat,
  updateWorkbench,
  type ChatRow,
  type WorkbenchRow,
} from './store.js';

/**
 * Moving a session to a fresh box: the newest golden for its repository, with
 * the branch, the uncommitted changes, small ignored files (`.env` and the
 * like) and every chat's agent conversation carried over. Running processes
 * do not survive, and the system note says so.
 *
 * # Why
 *
 * A box's rootfs is a copy of the golden it was created from, chosen only at
 * create, and a resume always reuses the box's own disk. So a session keeps
 * its golden for life, and an old golden can be full.
 *
 * # The old box's disk is never written
 *
 * It may be full, and a write that fails half way is the thing to avoid. The
 * export runs with `TMPDIR`, the git index and the staging folder on
 * `/dev/shm` (tmpfs), `GIT_OPTIONAL_LOCKS=0`, and pushes the commits rather
 * than writing a bundle: a push writes no objects. The staged files then
 * cross to the new box in chunks the backend holds one at a time.
 *
 * # Never lose work
 *
 * The old box is deleted only after the new one has everything and the row
 * names it. Any failure before that keeps the old box, puts the status back
 * and deletes the half-made new one.
 *
 * # Concurrency
 *
 * One move per workbench, by a DB claim (`ready` → `moving`) rather than a
 * lock: a deploy overlaps two backend instances. A turn start reads the
 * workbench under a share lock and does not start while it is `moving`, and
 * the move reads the running chats only after its claim has committed, so
 * either the turn or the move sees the other.
 */

export type MoveReason = 'stale_golden' | 'low_disk' | 'disk_full';

const REASON_TEXT: Record<MoveReason, string> = {
  stale_golden: 'a newer sandbox image was ready',
  low_disk: 'the disk was nearly full',
  disk_full: 'the disk was full',
};

export type MoveResult =
  | { moved: true; row: WorkbenchRow }
  | { moved: false; reason: 'not_applicable' | 'busy' | 'failed'; message?: string };

export interface MoveOptions {
  /** The chat whose turn asked for the move. It is running, and is not a reason to refuse. */
  ownerChatId?: string;
  /** Called with true once the claim is held, or false when the move will not happen. */
  onClaim?: (claimed: boolean) => void;
}

// ============================================================================
// Limits
// ============================================================================

const MIB = 1024 * 1024;

/**
 * The most a move carries, compressed: four imports' worth. Every chat's
 * conversation comes along, and one import is already sized to the largest
 * real conversation (`WORKBENCH_IMPORT_MAX_BYTES`). Writing into the new box
 * costs one exec per 288 KiB (see `sandboxFiles.ts`), so this is about 340
 * execs. A larger move is refused, never cut.
 */
export const MOVE_TRANSFER_MAX_BYTES = 4 * WORKBENCH_IMPORT_MAX_BYTES;

/**
 * One read from the old box. The fleet cuts a quiet answer at 4 MiB and
 * capture mode sends base64, so 2 MiB of bytes is about 2.7 MiB on the wire.
 * It is also all the backend holds of a transfer at one time.
 */
export const MOVE_CHUNK_BYTES = 2 * MIB;

/** An ignored file larger than this is a build output or data, not configuration. */
export const MOVE_IGNORED_FILE_MAX_BYTES = 1 * MIB;

/**
 * All ignored files together, measured as tar stores them. A sixth of the
 * move's limit, so configuration never crowds out the conversations.
 */
export const MOVE_IGNORED_TOTAL_MAX_BYTES = 16 * MIB;

/** Ignored files skipped by name in the note; the rest are counted. */
const SKIPPED_NAMES_SHOWN = 50;

/** Dependency, build and cache folders. The setup script makes them again. */
export const MOVE_SKIP_DIRS = [
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.nuxt',
  'target',
  '.cache',
  'coverage',
  '.parcel-cache',
  '.gradle',
] as const;

/** A suspended box may first come back from object storage, which takes about a minute. */
const EXPORT_TIMEOUT_MS = 10 * 60_000;
const CHUNK_TIMEOUT_MS = 2 * 60_000;
const CLONE_TIMEOUT_MS = 20 * 60_000;
const IMPORT_TIMEOUT_MS = 10 * 60_000;

/** After a failed move, automatic moves for that session wait this long. */
const FAILED_MOVE_BACKOFF_MS = 30 * 60_000;

/** How often a session's golden is asked about at most. One GET each time. */
const STALE_CHECK_INTERVAL_MS = 3 * 60_000;

// ============================================================================
// Names
// ============================================================================

/** The hidden remote ref that carries the session's commits across. */
export function moveRef(workbenchId: string): string {
  return `refs/talyn/move/${workbenchId}`;
}

/** Where the old box stages the export. tmpfs, never the rootfs. */
export function moveStagingDir(workbenchId: string): string {
  return `/dev/shm/talyn-move-${workbenchId}`;
}

/** Where the new box puts the transfer back together. Its disk is a fresh golden. */
export function moveImportDir(workbenchId: string): string {
  return `/tmp/talyn-move-${workbenchId}`;
}

/** The env every exec on the old box runs with, so nothing it does writes the rootfs. */
export function moveExportEnv(workbenchId: string): Record<string, string> {
  return {
    TMPDIR: '/dev/shm',
    GIT_INDEX_FILE: `/dev/shm/talyn-move-${workbenchId}.index`,
    GIT_OPTIONAL_LOCKS: '0',
  };
}

/** The staged files, in the order the import applies them. */
export const MOVE_ARTIFACTS = ['staged.patch.gz', 'unstaged.patch.gz', 'ignored.tgz', 'agent.tgz'] as const;
export type MoveArtifact = (typeof MOVE_ARTIFACTS)[number];

export interface MoveSession {
  agent: 'claude' | 'codex';
  sessionId: string;
}

const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/;

// ============================================================================
// Scripts
// ============================================================================

/** Exit codes of the export script. */
export const MOVE_EXPORT_EXIT: Record<number, string> = {
  30: 'could not stage the work in memory',
  31: 'could not read the repository',
  32: 'could not push the commits to GitHub',
  33: 'could not read the uncommitted changes',
  34: 'could not pack the ignored files',
  35: 'could not pack the agent conversations',
  40: 'the work is too large to move',
};

/**
 * The old box's side. Writes only under /dev/shm (staging, index, temp files)
 * and pushes HEAD to `moveRef`. Prints a manifest:
 *   HEAD <sha> · BRANCH <b64> · UPSTREAM <b64>
 *   FILE <name> <bytes> <sha256>   one per staged file
 *   SKIPPED <b64 path> · SKIPPED_COUNT <n>   ignored files left behind
 *   MISSING_SESSION <id>   a chat's conversation file was not found
 */
export function moveExportScript(input: { workbenchId: string; sessions: MoveSession[] }): string {
  const dir = shellQuote(moveStagingDir(input.workbenchId));
  const ref = shellQuote(moveRef(input.workbenchId));
  const skipCase = MOVE_SKIP_DIRS.map((d) => `*/${d}/*`).join('|');
  const prune = MOVE_SKIP_DIRS.map((d) => `-name ${shellQuote(d)}`).join(' -o ');
  const sessions = input.sessions.filter((s) => SESSION_ID.test(s.sessionId));
  const sessionLines = sessions.flatMap((s) =>
    s.agent === 'codex'
      ? [
          `found=; while IFS= read -r -d '' f; do printf '%s\\0' "\${f#/}" >> "$d/agent.list"; found=1; done < <(find "\${CODEX_HOME:-$HOME/.codex}/sessions" -type f -name ${shellQuote(`*${s.sessionId}*.jsonl`)} -print0 2>/dev/null)`,
          `[ -n "$found" ] || echo ${shellQuote(`MISSING_SESSION ${s.sessionId}`)}`,
        ]
      : [
          `f=$(find "$HOME/.claude/projects" -mindepth 2 -maxdepth 2 -name ${shellQuote(`${s.sessionId}.jsonl`)} -print -quit 2>/dev/null)`,
          'if [ -n "$f" ]; then',
          `  printf '%s\\0' "\${f#/}" >> "$d/agent.list"`,
          // Claude Code keeps a session's subagent and tool output beside it.
          '  side=${f%.jsonl}',
          `  if [ -d "$side" ]; then printf '%s\\0' "\${side#/}" >> "$d/agent.list"; fi`,
          `else echo ${shellQuote(`MISSING_SESSION ${s.sessionId}`)}; fi`,
        ],
  );
  return [
    'set -u',
    `d=${dir}`,
    `cap=${MOVE_TRANSFER_MAX_BYTES}`,
    'rm -rf -- "$d" && mkdir -p -- "$d" || exit 30',
    'allzero() { for c in "$@"; do [ "$c" = 0 ] || return 1; done; }',
    // A file one byte over the cap means it was cut, so it is refused, not sent.
    'fits() { [ "$(stat -c %s -- "$d/$1")" -le "$cap" ] || { echo "TOO_LARGE $1" >&2; exit 40; }; }',
    'capped() { head -c $((cap + 1)) > "$d/$1"; }',
    // The REAL index, read only: the env points GIT_INDEX_FILE at /dev/shm.
    'real_index=$(env -u GIT_INDEX_FILE git rev-parse --git-path index) || exit 31',
    'head=$(git rev-parse --verify HEAD) || exit 31',
    'branch=$(git symbolic-ref --short -q HEAD || true)',
    `upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)`,
    // Commits: a push sends a pack over the wire and writes no objects here.
    `git push --no-verify --force --quiet origin "$head":${ref} >&2 || exit 32`,
    // Staged changes, against HEAD, from the real index.
    'GIT_INDEX_FILE="$real_index" git diff --cached --binary --no-ext-diff --no-textconv --no-color HEAD -- | gzip -c | capped staged.patch.gz',
    'rc="${PIPESTATUS[*]}"; fits staged.patch.gz; allzero $rc || exit 33',
    // Unstaged and untracked: a copy of the index in /dev/shm, untracked files
    // added as intent-to-add (no blobs written), then the work tree against it.
    'rm -f -- "$GIT_INDEX_FILE"',
    'if [ -f "$real_index" ]; then cp -- "$real_index" "$GIT_INDEX_FILE" || exit 33; fi',
    'git ls-files -z -o --exclude-standard | xargs -0 -r git add -N -- || exit 33',
    'git diff --binary --no-ext-diff --no-textconv --no-color -- | gzip -c | capped unstaged.patch.gz',
    'rc="${PIPESTATUS[*]}"; fits unstaged.patch.gz; allzero $rc || exit 33',
    'rm -f -- "$GIT_INDEX_FILE"',
    // Small ignored files. Each costs its size in 512-byte blocks plus a
    // 512-byte header, as in the tar.
    `skipdir() { case "/$1/" in ${skipCase}) return 0 ;; esac; return 1; }`,
    'total=0; nskip=0',
    ': > "$d/ignored.list"; : > "$d/skipped.list"',
    `note_skip() { nskip=$((nskip + 1)); if [ "$nskip" -le ${SKIPPED_NAMES_SHOWN} ]; then printf '%s\\0' "$1" >> "$d/skipped.list"; fi; }`,
    'add_file() {',
    '  skipdir "$1" && return 0',
    '  if [ -L "$1" ]; then size=0; elif [ -f "$1" ]; then size=$(stat -c %s -- "$1" 2>/dev/null || echo 0); else return 0; fi',
    '  cost=$(( (size + 511) / 512 * 512 + 512 ))',
    `  if [ "$size" -gt ${MOVE_IGNORED_FILE_MAX_BYTES} ] || [ $((total + cost)) -gt ${MOVE_IGNORED_TOTAL_MAX_BYTES} ]; then note_skip "$1"; return 0; fi`,
    `  total=$((total + cost)); printf '%s\\0' "$1" >> "$d/ignored.list"`,
    '}',
    'while IFS= read -r -d \'\' e; do',
    '  case "$e" in',
    '    */)',
    '      e=${e%/}; skipdir "$e" && continue',
    `      while IFS= read -r -d '' f; do add_file "$f"; done < <(find "$e" -type d \\( ${prune} \\) -prune -o \\( -type f -o -type l \\) -print0 2>/dev/null) ;;`,
    '    *) add_file "$e" ;;',
    '  esac',
    // The real index, so tracked files never read as ignored ones.
    'done < <(GIT_INDEX_FILE="$real_index" git ls-files -z -o -i --exclude-standard --directory)',
    'if [ -s "$d/ignored.list" ]; then',
    '  tar -czf - --null --no-recursion -T "$d/ignored.list" | capped ignored.tgz',
    '  rc="${PIPESTATUS[*]}"; fits ignored.tgz; allzero $rc || exit 34',
    'fi',
    // The agents' conversation files, by path from /, so they land where they were.
    ': > "$d/agent.list"',
    ...sessionLines,
    'if [ -s "$d/agent.list" ]; then',
    '  tar -C / -czf - --null -T "$d/agent.list" | capped agent.tgz',
    '  rc="${PIPESTATUS[*]}"; fits agent.tgz; allzero $rc || exit 35',
    'fi',
    // The manifest.
    'b64() { printf %s "$1" | base64 -w 0; }',
    'printf "HEAD %s\\n" "$head"',
    'printf "BRANCH %s\\n" "$(b64 "$branch")"',
    'printf "UPSTREAM %s\\n" "$(b64 "$upstream")"',
    `for name in ${MOVE_ARTIFACTS.join(' ')}; do`,
    '  [ -f "$d/$name" ] || continue',
    '  printf "FILE %s %s %s\\n" "$name" "$(stat -c %s -- "$d/$name")" "$(sha256sum -- "$d/$name" | cut -d " " -f 1)"',
    'done',
    'printf "SKIPPED_COUNT %s\\n" "$nskip"',
    `while IFS= read -r -d '' f; do printf "SKIPPED %s\\n" "$(b64 "$f")"; done < "$d/skipped.list"`,
  ].join('\n');
}

/** Read `length` bytes at `offset` of a staged file, as raw stdout. */
export function moveReadChunkScript(path: string, offset: number, length: number): string {
  return `dd if=${shellQuote(path)} bs=1M iflag=skip_bytes,count_bytes skip=${offset} count=${length} status=none`;
}

/** Exit codes of the import script. */
export const MOVE_IMPORT_EXIT: Record<number, string> = {
  20: 'the copied files did not match',
  21: 'could not fetch the commits from GitHub',
  22: 'could not check out the branch',
  23: 'could not apply the staged changes',
  24: 'could not apply the unstaged changes',
  25: 'could not unpack the ignored files',
  26: 'could not unpack the agent conversations',
};

export interface MoveManifest {
  head: string;
  branch: string;
  upstream: string;
  files: Array<{ name: MoveArtifact; size: number; sha256: string }>;
  skipped: string[];
  skippedCount: number;
  missingSessions: string[];
}

/**
 * The new box's side, run in the repository after the clone: check every
 * copied file, put the branch at the moved commit with its upstream, apply
 * the staged then the unstaged changes, and unpack the ignored files and the
 * conversations.
 */
export function moveImportScript(input: { workbenchId: string; manifest: MoveManifest }): string {
  const { manifest } = input;
  const has = (name: MoveArtifact) => manifest.files.some((f) => f.name === name);
  const head = shellQuote(manifest.head);
  const lines = [
    'set -u',
    `d=${shellQuote(moveImportDir(input.workbenchId))}`,
    'trap \'rm -rf -- "$d"\' EXIT',
    ...manifest.files.map(
      (f) =>
        `printf '%s  %s\\n' ${shellQuote(f.sha256)} "$d/${f.name}" | sha256sum -c --status || { echo ${shellQuote(`checksum mismatch: ${f.name}`)} >&2; exit 20; }`,
    ),
    `git fetch --no-tags --quiet origin ${shellQuote(moveRef(input.workbenchId))} || exit 21`,
    `git cat-file -e ${shellQuote(`${manifest.head}^{commit}`)} || exit 21`,
  ];
  if (manifest.branch) {
    const branch = shellQuote(manifest.branch);
    lines.push(`git checkout --quiet -f -B ${branch} ${head} || exit 22`);
    if (manifest.upstream.startsWith('origin/')) {
      const remoteBranch = manifest.upstream.slice('origin/'.length);
      const spec = shellQuote(`+refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`);
      lines.push(
        `git config --get-all remote.origin.fetch | grep -qxF -e ${shellQuote('+refs/heads/*:refs/remotes/origin/*')} -e ${spec} || git config --add remote.origin.fetch ${spec}`,
        `if git fetch --quiet origin ${spec} 2>/dev/null; then git branch --quiet --set-upstream-to=${shellQuote(manifest.upstream)} ${branch} || true; fi`,
      );
    } else {
      lines.push(`git branch --unset-upstream ${branch} 2>/dev/null || true`);
    }
  } else {
    lines.push(`git checkout --quiet -f --detach ${head} || exit 22`);
  }
  if (has('staged.patch.gz')) {
    lines.push(
      'gunzip -c "$d/staged.patch.gz" > "$d/staged.patch" || exit 23',
      'if [ -s "$d/staged.patch" ]; then git apply --index --binary --whitespace=nowarn "$d/staged.patch" || exit 23; fi',
    );
  }
  if (has('unstaged.patch.gz')) {
    lines.push(
      'gunzip -c "$d/unstaged.patch.gz" > "$d/unstaged.patch" || exit 24',
      'if [ -s "$d/unstaged.patch" ]; then git apply --binary --whitespace=nowarn "$d/unstaged.patch" || exit 24; fi',
    );
  }
  if (has('ignored.tgz')) lines.push('tar -xzf "$d/ignored.tgz" -C . || exit 25');
  if (has('agent.tgz')) lines.push('tar -xzf "$d/agent.tgz" -C / || exit 26');
  return lines.join('\n');
}

export function parseMoveManifest(stdout: string): MoveManifest | null {
  const out: MoveManifest = {
    head: '',
    branch: '',
    upstream: '',
    files: [],
    skipped: [],
    skippedCount: 0,
    missingSessions: [],
  };
  const decode = (v: string | undefined) => (v ? Buffer.from(v, 'base64').toString('utf8') : '');
  for (const line of stdout.split('\n')) {
    const [kind, ...rest] = line.trim().split(' ');
    if (kind === 'HEAD' && /^[0-9a-f]{40,64}$/.test(rest[0] ?? '')) out.head = rest[0];
    else if (kind === 'BRANCH') out.branch = decode(rest[0]);
    else if (kind === 'UPSTREAM') out.upstream = decode(rest[0]);
    else if (kind === 'FILE') {
      const name = rest[0] as MoveArtifact;
      const size = Number(rest[1]);
      if (MOVE_ARTIFACTS.includes(name) && Number.isSafeInteger(size) && size >= 0 && /^[0-9a-f]{64}$/.test(rest[2] ?? '')) {
        out.files.push({ name, size, sha256: rest[2] });
      }
    } else if (kind === 'SKIPPED') out.skipped.push(decode(rest[0]));
    else if (kind === 'SKIPPED_COUNT') out.skippedCount = Number(rest[0]) || 0;
    else if (kind === 'MISSING_SESSION' && rest[0]) out.missingSessions.push(rest[0]);
  }
  return out.head ? out : null;
}

// ============================================================================
// The move
// ============================================================================

const inFlight = new Map<string, Promise<MoveResult>>();
const held = new Map<string, number>();
const failedAt = new Map<string, number>();

/**
 * Keep automatic moves off a workbench while an archive or a delete owns it.
 * Returns the release.
 */
export function holdMoves(workbenchId: string): () => void {
  held.set(workbenchId, (held.get(workbenchId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (held.get(workbenchId) ?? 1) - 1;
    if (n <= 0) held.delete(workbenchId);
    else held.set(workbenchId, n);
  };
}

/** Tests only: forget backoffs, holds and stale-golden checks. */
export function resetMovesForTests(): void {
  held.clear();
  failedAt.clear();
  staleChecks.clear();
}

function backingOff(workbenchId: string): boolean {
  const at = failedAt.get(workbenchId);
  return at !== undefined && Date.now() - at < FAILED_MOVE_BACKOFF_MS;
}

/**
 * Move a session to a fresh box. One at a time per workbench: a second call
 * in this process waits for the first, and a call on another instance finds
 * the claim taken (`busy`).
 */
export function moveWorkbenchToFreshSandbox(
  row: WorkbenchRow,
  reason: MoveReason,
  opts: MoveOptions = {},
): Promise<MoveResult> {
  const pending = inFlight.get(row.id);
  if (pending) {
    opts.onClaim?.(true);
    return pending;
  }
  const work = runWithoutScope(() => runMove(row, reason, opts))
    .catch((err): MoveResult => {
      console.error(`[workbench] moving ${row.id} crashed:`, err);
      return { moved: false, reason: 'failed', message: userFacingError(err) };
    })
    .finally(() => {
      inFlight.delete(row.id);
      opts.onClaim?.(false);
    });
  inFlight.set(row.id, work);
  return work;
}

/** The first generation from `nextSandboxId` the fleet does not know, tombstones included. */
async function freeSandboxId(row: WorkbenchRow): Promise<string> {
  const first = nextSandboxId(row);
  const client = await fleetClientFor(row.workspaceId, row.fleetHost);
  let generation = sandboxGeneration(first);
  for (let i = 0; i < 5; i++) {
    const id = sandboxIdFor(row.id, generation);
    try {
      await client.getSandbox(id);
    } catch {
      return id;
    }
    generation++;
  }
  return sandboxIdFor(row.id, generation);
}

async function setMessage(row: WorkbenchRow, message: string): Promise<void> {
  const updated = await updateWorkbench(row.id, { statusMessage: message }).catch(() => null);
  if (updated) await emitWorkbenchUpdated(await publicWorkbench(updated)).catch(() => undefined);
}

async function runMove(row: WorkbenchRow, reason: MoveReason, opts: MoveOptions): Promise<MoveResult> {
  if (row.runtime !== 'sandbox' || !row.sandboxId || held.has(row.id)) {
    return { moved: false, reason: 'not_applicable' };
  }
  const fromSandboxId = row.sandboxId;
  const previousMessage = row.statusMessage;
  const targetId = await freeSandboxId(row);
  const claimed = await claimMove(row.id, fromSandboxId, targetId, 'Saving the session’s work');
  if (!claimed) return { moved: false, reason: 'busy' };
  // Read only now that the claim has committed: a turn that started before it is seen here.
  if ((await otherRunningChats(row.id, opts.ownerChatId)) > 0) {
    const released = await releaseMove(row.id, fromSandboxId, previousMessage);
    if (released) await emitWorkbenchUpdated(await publicWorkbench(released));
    return { moved: false, reason: 'busy' };
  }
  opts.onClaim?.(true);
  await emitWorkbenchUpdated(await publicWorkbench(claimed));
  recordWorkbenchEvent(claimed, 'move_start', `${reason}: ${fromSandboxId} → ${targetId}`);

  const chats = await listChats(row.id);
  const sessions: MoveSession[] = chats
    .filter((c) => c.agentSessionId)
    .map((c) => ({ agent: c.agent === 'codex' ? 'codex' : 'claude', sessionId: c.agentSessionId! }));
  let created: { sandboxId: string; fleetHost: string | null; fleetSandboxId: string | null } | null = null;
  let step = 'export';
  try {
    const manifest = await exportFromOldBox(claimed, sessions);

    step = 'create';
    await setMessage(claimed, 'Starting a fresh sandbox');
    const { createWorkbenchSandbox } = await import('./lifecycle.js');
    const made = await createWorkbenchSandbox(claimed, targetId);
    if (!made.ok) throw new Error(made.error);
    created = made;
    const fresh: WorkbenchRow = { ...claimed, sandboxId: made.sandboxId, fleetHost: made.fleetHost ?? null };

    step = 'clone';
    const cloned = await runCapture(fresh, cloneScript(claimed), {
      cwd: '/',
      timeoutMs: CLONE_TIMEOUT_MS,
      diskRecovery: false,
    });
    if (cloned.exitCode !== 0) throw new Error(`the clone failed: ${tail(cloned.stderr) || `exit ${cloned.exitCode}`}`);

    step = 'transfer';
    await setMessage(claimed, 'Copying the work into the new sandbox');
    for (const file of manifest.files) await transferFile(claimed, fresh, file);

    step = 'import';
    const imported = await runCapture(fresh, moveImportScript({ workbenchId: row.id, manifest }), {
      quiet: true,
      timeoutMs: IMPORT_TIMEOUT_MS,
      diskRecovery: false,
    });
    if (imported.exitCode !== 0) {
      const what = MOVE_IMPORT_EXIT[imported.exitCode] ?? `the import exited ${imported.exitCode}`;
      throw new Error(`${what}${tail(imported.stderr) ? `: ${tail(imported.stderr)}` : ''}`);
    }

    step = 'setup';
    const setupNote = await runSetup(claimed, fresh);

    step = 'commit';
    const committed = await commitMove(row.id, fromSandboxId, {
      sandboxId: made.sandboxId,
      fleetHost: made.fleetHost ?? null,
      fleetSandboxId: made.fleetSandboxId,
      statusMessage: setupNote,
    });
    if (!committed) throw new Error('the session was archived or deleted during the move');

    await afterSuccess(claimed, committed, reason, manifest, chats, opts);
    return { moved: true, row: committed };
  } catch (err) {
    const message = userFacingError(err);
    failedAt.set(row.id, Date.now());
    console.warn(`[workbench] moving ${row.id} failed at ${step}:`, err);
    recordWorkbenchEvent(claimed, 'move_failed', `${step}: ${message}`, false, err);
    const oldBoxLost = step === 'export' && err instanceof FleetRunNotFoundError;
    await afterFailure(claimed, fromSandboxId, previousMessage, created, message, oldBoxLost ? err : null, opts);
    return { moved: false, reason: 'failed', message };
  }
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-3).join(' ').slice(-300);
}

async function exportFromOldBox(row: WorkbenchRow, sessions: MoveSession[]): Promise<MoveManifest> {
  const r = await runCapture(row, moveExportScript({ workbenchId: row.id, sessions }), {
    env: moveExportEnv(row.id),
    quiet: true,
    timeoutMs: EXPORT_TIMEOUT_MS,
    diskRecovery: false,
  });
  if (r.exitCode !== 0) {
    const what = MOVE_EXPORT_EXIT[r.exitCode] ?? `the export exited ${r.exitCode}`;
    throw new Error(`${what}${tail(r.stderr) ? `: ${tail(r.stderr)}` : ''}`);
  }
  if (r.truncated) throw new Error('the export answer was cut short');
  const manifest = parseMoveManifest(r.stdout);
  if (!manifest) throw new Error('the export printed no manifest');
  const total = manifest.files.reduce((sum, f) => sum + f.size, 0);
  if (total > MOVE_TRANSFER_MAX_BYTES) {
    throw new Error(
      `the changes and conversations come to ${Math.ceil(total / MIB)} MB compressed, ` +
        `more than the ${MOVE_TRANSFER_MAX_BYTES / MIB} MB a move can carry`,
    );
  }
  return manifest;
}

/** One staged file, old box to new, a chunk at a time. Every chunk's length is checked. */
async function transferFile(
  oldRow: WorkbenchRow,
  newRow: WorkbenchRow,
  file: MoveManifest['files'][number],
): Promise<void> {
  const source = `${moveStagingDir(oldRow.id)}/${file.name}`;
  const dir = moveImportDir(oldRow.id);
  const target = shellQuote(`${dir}/${file.name}`);
  const part = `${dir}/${file.name}.part`;
  for (let offset = 0; offset < file.size; offset += MOVE_CHUNK_BYTES) {
    const length = Math.min(MOVE_CHUNK_BYTES, file.size - offset);
    const r = await runCapture(oldRow, moveReadChunkScript(source, offset, length), {
      cwd: '/',
      env: moveExportEnv(oldRow.id),
      quiet: true,
      timeoutMs: CHUNK_TIMEOUT_MS,
      diskRecovery: false,
    });
    if (r.exitCode !== 0) throw new Error(`could not read ${file.name} on the old sandbox: ${tail(r.stderr)}`);
    if (r.truncated || r.stdoutBytes.length !== length) {
      throw new Error(`reading ${file.name} returned ${r.stdoutBytes.length} of ${length} bytes`);
    }
    await writeSandboxFiles(newRow, [{ path: part, base64: r.stdoutBytes.toString('base64') }], {
      ...(offset === 0 ? { before: `mkdir -p ${shellQuote(dir)} && : > ${target}` } : {}),
      after: `cat ${shellQuote(part)} >> ${target} && rm -f ${shellQuote(part)}`,
      timeoutMs: CHUNK_TIMEOUT_MS,
      diskRecovery: false,
    });
  }
}

/** The setup script, as a provision runs it. A failure is a note, not a failed move. */
async function runSetup(claimed: WorkbenchRow, fresh: WorkbenchRow): Promise<string | null> {
  const config = await loadWorkbenchConfig(fresh).catch(() => null);
  if (!config?.setup) return null;
  await setMessage(claimed, 'Running the setup script');
  try {
    const { done } = await startScript(fresh, 'setup', { config });
    const code = await done;
    return code === 0 ? null : `The setup script exited with ${code ?? 'no exit code'}. Its output is in the Scripts panel.`;
  } catch (err) {
    return `The setup script could not run: ${userFacingError(err)}`;
  }
}

export function movedNote(reason: MoveReason): string {
  return (
    `Moved to a fresh sandbox (${REASON_TEXT[reason]}). Your branch, changes and this conversation came along. ` +
    'Running processes stopped, so restart any dev servers.'
  );
}

function skippedNote(manifest: MoveManifest): string | null {
  if (manifest.skippedCount === 0) return null;
  const names = manifest.skipped.slice(0, 10).join(', ');
  const more = manifest.skippedCount - Math.min(10, manifest.skipped.length);
  return `Ignored files too large to copy: ${names}${more > 0 ? ` and ${more} more` : ''}.`;
}

async function note(chat: ChatRow, subtype: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  const stored = await appendEvents(chat.id, [{ turn: chat.turnCount, event: { type: 'system', subtype, text, ...extra } }]);
  emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
}

async function startQueued(workbenchId: string, ownerChatId?: string): Promise<void> {
  const { startQueuedIfIdle } = await import('./turns.js');
  for (const chat of await listChats(workbenchId)) {
    if (chat.id === ownerChatId || chat.closedAt || chat.queuedMessages.length === 0) continue;
    await startQueuedIfIdle(chat.id).catch(() => false);
  }
}

async function afterSuccess(
  old: WorkbenchRow,
  committed: WorkbenchRow,
  reason: MoveReason,
  manifest: MoveManifest,
  chats: ChatRow[],
  opts: MoveOptions,
): Promise<void> {
  failedAt.delete(old.id);
  staleChecks.delete(old.id);
  await emitWorkbenchUpdated(await publicWorkbench(committed));
  recordWorkbenchEvent(committed, 'moved', `${old.sandboxId} → ${committed.sandboxId} (${reason})`);

  // The old box goes last: its followers first, then the box itself.
  await stopAllScripts(old).catch(() => undefined);
  try {
    const client = await fleetClientFor(old.workspaceId, old.fleetHost);
    await client.deleteSandbox(old.sandboxId!);
  } catch (err) {
    console.warn(`[workbench] deleting the old sandbox ${old.sandboxId} after a move failed:`, err);
    recordWorkbenchEvent(committed, 'move_cleanup', `old sandbox ${old.sandboxId} not deleted`, false, err);
  }
  await runCapture(committed, `git push --no-verify --quiet origin ${shellQuote(`:${moveRef(old.id)}`)}`, {
    quiet: true,
    timeoutMs: 60_000,
    diskRecovery: false,
  }).catch((err) => console.warn(`[workbench] deleting ${moveRef(old.id)} failed:`, err));

  const missing = new Set(manifest.missingSessions);
  const skipped = skippedNote(manifest);
  for (const chat of chats) {
    if (chat.closedAt) continue;
    let current = chat;
    if (chat.agentSessionId && missing.has(chat.agentSessionId)) {
      // Its file was not on the old box, so a resume would fail the next turn.
      const cleared = await updateChat(chat.id, { agentSessionId: null }).catch(() => null);
      if (cleared) {
        current = cleared;
        emitWorkbenchChat(cleared.workspaceId, rowToChat(cleared));
      }
    }
    const text = [movedNote(reason), skipped].filter(Boolean).join(' ');
    await note(current, 'sandbox_moved', text, skipped ? { skippedFiles: manifest.skipped } : {}).catch((err) =>
      console.warn(`[workbench] noting the move in chat ${chat.id} failed:`, err),
    );
  }
  void refreshDiffStat(committed).catch(() => undefined);
  await startQueued(committed.id, opts.ownerChatId);
}

async function afterFailure(
  claimed: WorkbenchRow,
  fromSandboxId: string,
  previousMessage: string | null,
  created: { sandboxId: string; fleetHost: string | null } | null,
  message: string,
  /** Set when the export found the old box gone: recovery then replaces it. */
  oldBoxLost: FleetRunNotFoundError | null,
  opts: MoveOptions,
): Promise<void> {
  if (created) {
    try {
      const client = await fleetClientFor(claimed.workspaceId, created.fleetHost);
      await client.deleteSandbox(created.sandboxId);
    } catch (deleteErr) {
      console.warn(`[workbench] deleting the half-made sandbox ${created.sandboxId} failed:`, deleteErr);
      recordWorkbenchEvent(claimed, 'move_cleanup', `new sandbox ${created.sandboxId} not deleted`, false, deleteErr);
    }
  }
  if (!oldBoxLost) {
    // The staging lives in memory, but a long-lived box should not keep it.
    // Deleting the ref writes nothing to the disk either.
    const dir = shellQuote(moveStagingDir(claimed.id));
    await runCapture(
      claimed,
      `rm -rf -- ${dir} ${shellQuote(moveExportEnv(claimed.id).GIT_INDEX_FILE)}; git push --no-verify --quiet origin ${shellQuote(`:${moveRef(claimed.id)}`)} || true`,
      { env: moveExportEnv(claimed.id), quiet: true, timeoutMs: 60_000, diskRecovery: false },
    ).catch(() => undefined);
  }
  const released = await releaseMove(claimed.id, fromSandboxId, previousMessage);
  if (!released) return;
  await emitWorkbenchUpdated(await publicWorkbench(released));
  for (const chat of await listChats(claimed.id)) {
    if (chat.closedAt) continue;
    await note(
      chat,
      'sandbox_move_failed',
      `Talyn could not move this session to a fresh sandbox: ${message} It stays on its current sandbox.`,
    ).catch(() => undefined);
  }
  if (oldBoxLost) await recoverLostSandbox(released, oldBoxLost).catch(() => undefined);
  await startQueued(claimed.id, opts.ownerChatId);
}

// ============================================================================
// Triggers
// ============================================================================

/** T1: a box asleep on a stale golden. A running box is never moved for this. */
export function shouldMoveForStaleGolden(sandbox: Pick<FleetSandbox, 'status' | 'goldenStale'>): boolean {
  return sandbox.status === 'suspended' && sandbox.goldenStale === true;
}

const staleChecks = new Map<string, { sandboxId: string; at: number }>();

/**
 * Whether the session should move before its box wakes. One GET of the box
 * record, which does not wake it, at most once per interval per box.
 */
export async function needsFreshGolden(row: WorkbenchRow): Promise<boolean> {
  if (row.runtime !== 'sandbox' || row.status !== 'ready' || !row.sandboxId) return false;
  if (held.has(row.id) || backingOff(row.id)) return false;
  const last = staleChecks.get(row.id);
  if (last && last.sandboxId === row.sandboxId && Date.now() - last.at < STALE_CHECK_INTERVAL_MS) return false;
  staleChecks.set(row.id, { sandboxId: row.sandboxId, at: Date.now() });
  try {
    const client = await fleetClientFor(row.workspaceId, row.fleetHost);
    const { sandbox } = await client.getSandbox(row.sandboxId);
    return shouldMoveForStaleGolden(sandbox);
  } catch {
    return false;
  }
}

/**
 * T1 for a read: start the move and answer at once. True when the move holds
 * its claim, so the caller can say the session is moving.
 */
export async function startStaleGoldenMove(row: WorkbenchRow): Promise<boolean> {
  if (!(await needsFreshGolden(row))) return false;
  return new Promise<boolean>((resolve) => {
    void moveWorkbenchToFreshSandbox(row, 'stale_golden', { onClaim: resolve });
  });
}

/** One `df` of the root filesystem. Runs on a full disk too: its temp files go to /dev/shm. */
export async function probeDisk(row: WorkbenchRow): Promise<DiskProbe | null> {
  const r = await runCapture(row, DISK_PROBE_SCRIPT, {
    cwd: '/',
    env: { TMPDIR: '/dev/shm' },
    quiet: true,
    timeoutMs: 60_000,
    diskRecovery: false,
  });
  return parseDiskProbe(r.stderr);
}

/**
 * Grow the box's disk through the fleet, when it can. True when the box then
 * has `LOW_DISK_BYTES` free. False when the fleet has no grow route, the grow
 * failed, or it did not help.
 */
export async function tryGrowDisk(row: WorkbenchRow, probe?: DiskProbe | null): Promise<boolean> {
  if (!row.sandboxId) return false;
  const before = probe ?? (await probeDisk(row));
  if (!before) return false;
  const client = await fleetClientFor(row.workspaceId, row.fleetHost);
  const current = await client
    .getSandbox(row.sandboxId)
    .then((r) => r.sandbox.diskMib)
    .catch(() => undefined);
  const target = grownDiskMib(before, current);
  if (target === null) return false;
  const answer = await client.growSandboxDisk(row.sandboxId, target);
  if (answer === 'unsupported') return false;
  const after = await probeDisk(row).catch(() => null);
  const ok = after !== null && after.availBytes >= LOW_DISK_BYTES;
  recordWorkbenchEvent(row, 'disk_grow', `grew to ${target} MiB; ${after ? Math.floor(after.availBytes / MIB) : '?'} MiB free`, ok);
  return ok;
}

export type DiskRecovery = { ok: true; row: WorkbenchRow; action: 'grown' | 'moved' } | { ok: false };

/** T2 and T3: grow the disk when the fleet can, else move. */
export async function growOrMove(
  row: WorkbenchRow,
  reason: 'low_disk' | 'disk_full',
  opts: { ownerChatId?: string; probe?: DiskProbe | null } = {},
): Promise<DiskRecovery> {
  if (held.has(row.id) || backingOff(row.id)) return { ok: false };
  const grown = await tryGrowDisk(row, opts.probe).catch((err) => {
    console.warn(`[workbench] growing the disk of ${row.id} failed:`, err);
    return false;
  });
  if (grown) return { ok: true, row, action: 'grown' };
  const moved = await moveWorkbenchToFreshSandbox(row, reason, { ownerChatId: opts.ownerChatId });
  return moved.moved ? { ok: true, row: moved.row, action: 'moved' } : { ok: false };
}

/**
 * T3 from the exec layer: an exec failed on a full disk. Only between turns:
 * a running chat makes the move's claim refuse. Returns the row to retry on.
 */
export async function recoverFromDiskFull(row: WorkbenchRow): Promise<WorkbenchRow | null> {
  const pending = inFlight.get(row.id);
  if (pending) {
    const result = await pending;
    return result.moved ? result.row : null;
  }
  const fresh = await getWorkbench(row.id);
  if (!fresh || fresh.status !== 'ready' || fresh.sandboxId !== row.sandboxId) return null;
  const outcome = await growOrMove(fresh, 'disk_full');
  return outcome.ok ? outcome.row : null;
}

/**
 * Boot sweep: a move a dead process left half done. The row still names the
 * old box, which holds the work, so the move is undone and the half-made box
 * deleted. Moves this process runs are left alone.
 */
export async function sweepAbandonedMoves(): Promise<number> {
  let undone = 0;
  for (const row of await movingWorkbenches()) {
    if (inFlight.has(row.id) || !row.sandboxId) continue;
    const released = await releaseMove(row.id, row.sandboxId, null);
    if (!released) continue;
    undone++;
    recordWorkbenchEvent(released, 'move_abandoned', 'a move left by a restart was undone', false);
    await emitWorkbenchUpdated(await publicWorkbench(released)).catch(() => undefined);
    const target = (row.settings as Record<string, unknown> | null)?.moveSandboxId;
    if (typeof target === 'string' && target !== row.sandboxId) {
      await fleetClientFor(row.workspaceId)
        .then((client) => client.deleteSandbox(target))
        .catch((err) => console.warn(`[workbench] deleting the abandoned sandbox ${target} failed:`, err));
    }
    await startQueued(row.id);
  }
  return undone;
}
