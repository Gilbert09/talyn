import { shellQuote, WORKBENCH_IMPORT_MAX_BYTES } from '@talyn/shared';
import { runWithoutScope } from '../../db/client.js';
import { FleetRunNotFoundError, type FleetSandbox } from '../selfHosted/client.js';
import { DISK_PROBE_SCRIPT, grownDiskMib, LOW_DISK_BYTES, parseDiskProbe, type DiskProbe } from './execFailures.js';
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
import { runningScriptNames, startScript, stopAllScripts } from './scripts.js';
import {
  appendEvents,
  claimMove,
  commitMove,
  getWorkbench,
  heartbeatMove,
  listChats,
  mergeWorkbenchSettings,
  otherRunningChats,
  recordMoveFailure,
  releaseMove,
  rowToChat,
  setMoveTargetHost,
  staleMovingWorkbenches,
  updateChat,
  updateWorkbench,
  type ChatRow,
  type WorkbenchRow,
} from './store.js';
import { closeWorkbenchTerminals } from './terminalBridge.js';

/**
 * Moving a session to a fresh box: the newest golden for its repository, with
 * every local branch, the stash, the turn checkpoints, the uncommitted
 * changes, small ignored files (`.env` and the like) and every chat's agent
 * conversation carried over. Running processes do not survive, and the chat
 * note says so.
 *
 * # Why
 *
 * A box's rootfs is a copy of the golden it was created from, chosen only at
 * create, and a resume always reuses the box's own disk. So a session keeps
 * its golden for life, and an old golden can be full.
 *
 * # The old box's disk is never written, and nothing is published
 *
 * The export runs with `TMPDIR`, the git index and the staging folder on
 * `/dev/shm` (tmpfs) and `GIT_OPTIONAL_LOCKS=0`. Commits travel as a git
 * bundle streamed through Talyn, never as a push: a push of unpushed commits
 * to a hidden ref on a public repository would publish them.
 *
 * # Never lose work
 *
 * The old box is deleted only after the row names the new one. Before that,
 * any failure keeps the old box, puts the status back and deletes the
 * half-made new one, after reading the row again in case a commit landed
 * whose answer was lost. After it, nothing deletes the box the row names.
 *
 * # Concurrency
 *
 * One move per workbench, by a DB claim (`ready` → `moving`) and a lease: the
 * running move renews `settings.moveHeartbeatAt`, and the sweep undoes only a
 * move whose lease has lapsed, so a live move on the other instance during a
 * deploy overlap is never touched. A turn start reads the workbench under a
 * share lock and does not start while it is `moving`, and the move reads the
 * running chats only after its claim has committed.
 *
 * # Known gap
 *
 * A Create PR or checkout that started before the claim keeps running on the
 * old box. No in-flight marker exists for them; their pushes still reach
 * GitHub, but a commit made after the export is not in the new box.
 */

export type MoveReason = 'stale_golden' | 'low_disk' | 'disk_full';

export type MoveResult =
  | { moved: true; row: WorkbenchRow }
  | { moved: false; reason: 'not_applicable' | 'busy' | 'blocked' | 'failed'; message?: string };

export interface MoveOptions {
  /** The chat whose turn asked for the move. It is running, and is not a reason to refuse. */
  ownerChatId?: string;
  /** Called with true once the claim is held, or false when the move will not happen. */
  onClaim?: (claimed: boolean) => void;
}

/** Settings keys only the server writes. A settings PATCH keeps them. */
export const MOVE_SETTINGS_KEYS = [
  'moveSandboxId',
  'moveHeartbeatAt',
  'moveTargetHost',
  'moveFleetSandboxId',
  'moveFailedAt',
  'moveFailures',
  'movedForDiskTo',
  'lowDiskNotedFor',
] as const;

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

/** Large ignored files named in the manifest; the rest are counted. */
const SKIPPED_NAMES_SHOWN = 50;

/** Files counted per skipped folder, at most: the count is for the note, not worth a long walk. */
const SKIPDIR_COUNT_MAX = 100_000;

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

/**
 * The lease. A move renews it every 30 s; a sweep treats a move as abandoned
 * after six missed renewals, which is longer than any single step blocks the
 * event loop and shorter than a user would wait for a stuck status to clear.
 */
const LEASE_RENEW_MS = 30_000;
export const LEASE_STALE_SECONDS = 180;
/** How often the sweep looks for abandoned moves. */
export const MOVE_SWEEP_INTERVAL_MS = 60_000;

/** After the nth failed or refused move, automatic moves wait 30 min × 2^(n-1), at most a day. */
const BACKOFF_BASE_MS = 30 * 60_000;
const BACKOFF_MAX_MS = 24 * 60 * 60_000;

/** How often a session's golden is asked about at most. One GET each time. */
const STALE_CHECK_INTERVAL_MS = 3 * 60_000;

// ============================================================================
// Names
// ============================================================================

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

/** The staged files, in the order the import uses them. */
export const MOVE_ARTIFACTS = [
  'repo.bundle',
  'staged.patch.gz',
  'unstaged.patch.gz',
  'filtered.tgz',
  'ignored.tgz',
  'agent.tgz',
] as const;
export type MoveArtifact = (typeof MOVE_ARTIFACTS)[number];
/** Always made by the export, even when empty. A manifest without them is incomplete. */
const REQUIRED_ARTIFACTS: readonly MoveArtifact[] = ['staged.patch.gz', 'unstaged.patch.gz'];

/** The refs a move carries: every branch, the stash, the turn checkpoints. */
const CARRIED_REF = /^refs\/(?:heads\/[^\s~^:?*[\\]+|stash|talyn\/checkpoints\/[^\s~^:?*[\\]+)$/;

export interface MoveSession {
  agent: 'claude' | 'codex';
  sessionId: string;
}

const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/;

// ============================================================================
// Scripts
// ============================================================================

/** Exit codes of the export script. 41 and 42 refuse the move rather than fail it. */
export const MOVE_EXPORT_EXIT: Record<number, string> = {
  30: 'could not stage the work in memory',
  31: 'could not read the repository',
  33: 'could not read the uncommitted changes',
  34: 'could not pack the ignored files',
  35: 'could not pack the agent conversations',
  36: 'could not bundle the commits',
  40: 'the work is too large to move',
  41: 'a rebase, merge, cherry-pick or bisect is in progress',
  42: 'there are commits with Git LFS files that are not pushed',
};
const BLOCKING_EXITS = new Set([41, 42]);

/**
 * The old box's side. Writes only under /dev/shm (staging, index, temp files)
 * and prints a manifest, one fact per line, ending in END:
 *   HEAD <sha> · BRANCH <b64> · UPSTREAM <b64>
 *   REF <sha> <ref> [<upstream>]          every branch, the stash, each checkpoint
 *   FILE <name> <bytes> <sha256>          one per staged file
 *   FILTERED_DELETED <b64 path>           a filtered file deleted in the work tree
 *   SKIPPED <b64 path> · SKIPPED_COUNT <n>   ignored files too large to copy
 *   SKIPDIR <b64 path> <files>            a dependency or build folder left behind
 *   MISSING_SESSION <id>                  a chat's conversation file was not found
 */
export function moveExportScript(input: { workbenchId: string; sessions: MoveSession[] }): string {
  const dir = shellQuote(moveStagingDir(input.workbenchId));
  const skipCase = MOVE_SKIP_DIRS.map((d) => `*/${d}/*`).join('|');
  const prune = MOVE_SKIP_DIRS.map((d) => `-name ${shellQuote(d)}`).join(' -o ');
  const sessions = input.sessions.filter((s) => SESSION_ID.test(s.sessionId));
  const sessionLines = sessions.flatMap((s) =>
    s.agent === 'codex'
      ? [
          `found=; while IFS= read -r -d '' f; do printf '%s\\0' "\${f#/}" >> "$d/agent.list"; found=1; done < <(find "\${CODEX_HOME:-$HOME/.codex}/sessions" -type f -name ${shellQuote(`*${s.sessionId}*.jsonl`)} -print0 2>/dev/null)`,
          `[ -n "$found" ] || echo ${shellQuote(`MISSING_SESSION ${s.sessionId}`)} >> "$d/manifest.extra"`,
        ]
      : [
          `f=$(find "$HOME/.claude/projects" -mindepth 2 -maxdepth 2 -name ${shellQuote(`${s.sessionId}.jsonl`)} -print -quit 2>/dev/null)`,
          'if [ -n "$f" ]; then',
          `  printf '%s\\0' "\${f#/}" >> "$d/agent.list"`,
          // Claude Code keeps a session's subagent and tool output beside it.
          '  side=${f%.jsonl}',
          `  if [ -d "$side" ]; then printf '%s\\0' "\${side#/}" >> "$d/agent.list"; fi`,
          `else echo ${shellQuote(`MISSING_SESSION ${s.sessionId}`)} >> "$d/manifest.extra"; fi`,
        ],
  );
  return [
    'set -u',
    `d=${dir}`,
    `cap=${MOVE_TRANSFER_MAX_BYTES}`,
    'rm -rf -- "$d" && mkdir -p -- "$d" && : > "$d/manifest.extra" || exit 30',
    'b64() { printf %s "$1" | base64 -w 0; }',
    'allzero() { for c in "$@"; do [ "$c" = 0 ] || return 1; done; }',
    // A file one byte over the cap was cut, so it is refused, not sent.
    'fits() { [ "$(stat -c %s -- "$d/$1")" -le "$cap" ] || { echo "TOO_LARGE $1" >&2; exit 40; }; }',
    'capped() { head -c $((cap + 1)) > "$d/$1"; }',
    'gitpath() { env -u GIT_INDEX_FILE git rev-parse --git-path "$1"; }',
    // The REAL index, read only: the env points GIT_INDEX_FILE at /dev/shm.
    'real_index=$(gitpath index) || exit 31',
    // Any object git writes (the empty blob `add -N` records) goes to /dev/shm;
    // the real store is read as an alternate.
    'objects=$(cd "$(gitpath objects)" && pwd) || exit 31',
    'mkdir -p -- "$d/objects" || exit 30',
    'export GIT_OBJECT_DIRECTORY="$d/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$objects"',
    'head=$(git rev-parse --verify HEAD) || exit 31',
    'branch=$(git symbolic-ref --short -q HEAD || true)',
    `upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)`,
    // The state of these lives in .git and does not travel.
    'for s in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do',
    '  if [ -e "$(gitpath "$s")" ]; then echo "IN_PROGRESS $s" >&2; exit 41; fi',
    'done',
    // Commits: a bundle of every carried ref, less what the remote already has.
    `git for-each-ref --format='%(objectname) %(refname) %(upstream:short)' refs/heads refs/stash refs/talyn/checkpoints > "$d/refs.txt" || exit 31`,
    'refs=(); while IFS= read -r r; do refs+=("$r"); done < <(cut -d " " -f 2 "$d/refs.txt")',
    'if [ "${#refs[@]}" -gt 0 ] && [ "$(git rev-list --count "${refs[@]}" --not --remotes)" -gt 0 ]; then',
    // Unpushed commits that add LFS pointers: their objects are only in .git/lfs.
    '  if [ -d "$(gitpath lfs)" ] && git log --format= -p --no-textconv --no-ext-diff "${refs[@]}" --not --remotes 2>/dev/null | grep -q "^+version https://git-lfs.github.com/spec/v1"; then',
    '    echo LFS_UNPUSHED >&2; exit 42',
    '  fi',
    '  git bundle create - "${refs[@]}" --not --remotes | capped repo.bundle',
    '  rc="${PIPESTATUS[*]}"; fits repo.bundle; allzero $rc || exit 36',
    'fi',
    // Paths with a clean/smudge filter (LFS, git-crypt, uv.lock) travel as raw
    // bytes: a diff would carry the cleaned text, which does not apply.
    '{ GIT_INDEX_FILE="$real_index" git diff --name-only -z HEAD -- && GIT_INDEX_FILE="$real_index" git ls-files -z -o --exclude-standard; } > "$d/changed.list" || exit 33',
    'excl=(); : > "$d/filtered.list"',
    "while IFS= read -r -d '' p && IFS= read -r -d '' a && IFS= read -r -d '' v; do",
    "  case \"$v\" in unspecified|unset|'') continue ;; esac",
    '  excl+=(":(exclude,literal)$p")',
    `  if [ -e "$p" ] || [ -L "$p" ]; then printf '%s\\0' "$p" >> "$d/filtered.list"; else printf 'FILTERED_DELETED %s\\n' "$(b64 "$p")" >> "$d/manifest.extra"; fi`,
    'done < <(GIT_INDEX_FILE="$real_index" git check-attr -z --stdin filter < "$d/changed.list")',
    'if [ -s "$d/filtered.list" ]; then',
    '  tar -czf - --null --no-recursion -T "$d/filtered.list" | capped filtered.tgz',
    '  rc="${PIPESTATUS[*]}"; fits filtered.tgz; allzero $rc || exit 33',
    'fi',
    // Staged changes, against HEAD, from the real index.
    'GIT_INDEX_FILE="$real_index" git diff --cached --binary --no-ext-diff --no-textconv --no-color HEAD -- . ${excl[@]+"${excl[@]}"} | gzip -c | capped staged.patch.gz',
    'rc="${PIPESTATUS[*]}"; fits staged.patch.gz; allzero $rc || exit 33',
    // Unstaged and untracked: a copy of the index in /dev/shm, untracked files
    // added as intent-to-add (no blobs written), then the work tree against it.
    'rm -f -- "$GIT_INDEX_FILE"',
    'if [ -f "$real_index" ]; then cp -- "$real_index" "$GIT_INDEX_FILE" || exit 33; fi',
    'git ls-files -z -o --exclude-standard | xargs -0 -r git add -N -- || exit 33',
    'git diff --binary --no-ext-diff --no-textconv --no-color -- . ${excl[@]+"${excl[@]}"} | gzip -c | capped unstaged.patch.gz',
    'rc="${PIPESTATUS[*]}"; fits unstaged.patch.gz; allzero $rc || exit 33',
    'rm -f -- "$GIT_INDEX_FILE"',
    // Small ignored files. Each costs its size in 512-byte blocks plus a
    // 512-byte header, as in the tar. Dependency folders are counted, not sent.
    `skipdir() { case "/$1/" in ${skipCase}) return 0 ;; esac; return 1; }`,
    `skipped_dir() { printf 'SKIPDIR %s %s\\n' "$(b64 "$1")" "$(find "$1" \\( -type f -o -type l \\) 2>/dev/null | head -n ${SKIPDIR_COUNT_MAX} | wc -l)" >> "$d/manifest.extra"; }`,
    'total=0; nskip=0',
    ': > "$d/ignored.list"; : > "$d/skipped.list"',
    `note_skip() { nskip=$((nskip + 1)); if [ "$nskip" -le ${SKIPPED_NAMES_SHOWN} ]; then printf '%s\\0' "$1" >> "$d/skipped.list"; fi; }`,
    'add_file() {',
    '  if skipdir "$1"; then skipped_dir "$1"; return 0; fi',
    '  if [ -L "$1" ]; then size=0; elif [ -f "$1" ]; then size=$(stat -c %s -- "$1" 2>/dev/null || echo 0); else return 0; fi',
    '  cost=$(( (size + 511) / 512 * 512 + 512 ))',
    `  if [ "$size" -gt ${MOVE_IGNORED_FILE_MAX_BYTES} ] || [ $((total + cost)) -gt ${MOVE_IGNORED_TOTAL_MAX_BYTES} ]; then note_skip "$1"; return 0; fi`,
    `  total=$((total + cost)); printf '%s\\0' "$1" >> "$d/ignored.list"`,
    '}',
    "while IFS= read -r -d '' e; do",
    '  case "$e" in',
    '    */)',
    '      e=${e%/}',
    '      if skipdir "$e"; then skipped_dir "$e"; continue; fi',
    `      while IFS= read -r -d '' f; do`,
    '        if [ -d "$f" ] && [ ! -L "$f" ]; then skipped_dir "$f"; else add_file "$f"; fi',
    `      done < <(find "$e" -type d \\( ${prune} \\) -prune -print0 -o \\( -type f -o -type l \\) -print0 2>/dev/null) ;;`,
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
    'printf "HEAD %s\\n" "$head"',
    'printf "BRANCH %s\\n" "$(b64 "$branch")"',
    'printf "UPSTREAM %s\\n" "$(b64 "$upstream")"',
    'while IFS= read -r line; do [ -n "$line" ] && printf "REF %s\\n" "$line"; done < "$d/refs.txt"',
    `for name in ${MOVE_ARTIFACTS.join(' ')}; do`,
    '  [ -f "$d/$name" ] || continue',
    '  printf "FILE %s %s %s\\n" "$name" "$(stat -c %s -- "$d/$name")" "$(sha256sum -- "$d/$name" | cut -d " " -f 1)"',
    'done',
    'cat "$d/manifest.extra"',
    'printf "SKIPPED_COUNT %s\\n" "$nskip"',
    `while IFS= read -r -d '' f; do printf "SKIPPED %s\\n" "$(b64 "$f")"; done < "$d/skipped.list"`,
    'echo END',
  ].join('\n');
}

/** Read `length` bytes at `offset` of a staged file, as raw stdout. */
export function moveReadChunkScript(path: string, offset: number, length: number): string {
  return `dd if=${shellQuote(path)} bs=1M iflag=skip_bytes,count_bytes skip=${offset} count=${length} status=none`;
}

/** Exit codes of the import script. */
export const MOVE_IMPORT_EXIT: Record<number, string> = {
  20: 'the copied files did not match',
  21: 'could not bring the commits into the new sandbox',
  22: 'could not put the branches back',
  23: 'could not apply the staged changes',
  24: 'could not apply the unstaged changes',
  25: 'could not unpack the ignored or filtered files',
  26: 'could not unpack the agent conversations',
};

export interface MoveRef {
  name: string;
  sha: string;
  /** `origin/x`, or empty. */
  upstream: string;
}

export interface MoveManifest {
  head: string;
  branch: string;
  upstream: string;
  refs: MoveRef[];
  files: Array<{ name: MoveArtifact; size: number; sha256: string }>;
  filteredDeleted: string[];
  skipped: string[];
  skippedCount: number;
  skippedDirs: Array<{ path: string; files: number }>;
  missingSessions: string[];
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SHA = /^[0-9a-f]{40,64}$/;

/**
 * The manifest, strictly: an unknown or malformed line, a missing required
 * line or file, a duplicate, or no END means the export did not finish, and
 * the move fails rather than carry part of the work.
 */
export function parseMoveManifest(stdout: string): MoveManifest | null {
  const out: MoveManifest = {
    head: '',
    branch: '',
    upstream: '',
    refs: [],
    files: [],
    filteredDeleted: [],
    skipped: [],
    skippedCount: -1,
    skippedDirs: [],
    missingSessions: [],
  };
  const seen = new Set<string>();
  const decode = (v: string): string | null => {
    if (!B64.test(v)) return null;
    const text = Buffer.from(v, 'base64').toString('utf8');
    return /[\0\n]/.test(text) ? null : text;
  };
  const lines = stdout.split('\n').filter((l) => l !== '');
  if (lines.at(-1) !== 'END') return null;
  for (const line of lines.slice(0, -1)) {
    const parts = line.split(' ');
    const [kind, ...rest] = parts;
    const once = (k: string) => {
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    };
    switch (kind) {
      case 'HEAD':
        if (rest.length !== 1 || !SHA.test(rest[0]) || !once(kind)) return null;
        out.head = rest[0];
        break;
      case 'BRANCH':
      case 'UPSTREAM': {
        const value = decode(rest[0] ?? '');
        if (rest.length > 1 || value === null || !once(kind)) return null;
        if (kind === 'BRANCH') out.branch = value;
        else out.upstream = value;
        break;
      }
      case 'REF': {
        const [sha, name, upstream = ''] = rest;
        if (rest.length < 2 || rest.length > 3 || !SHA.test(sha) || !CARRIED_REF.test(name) || /\s/.test(upstream)) {
          return null;
        }
        if (!once(`REF ${name}`)) return null;
        out.refs.push({ name, sha, upstream });
        break;
      }
      case 'FILE': {
        const [name, sizeText, sha256] = rest;
        const size = Number(sizeText);
        if (
          rest.length !== 3 ||
          !MOVE_ARTIFACTS.includes(name as MoveArtifact) ||
          !/^\d+$/.test(sizeText) ||
          !Number.isSafeInteger(size) ||
          !/^[0-9a-f]{64}$/.test(sha256) ||
          !once(`FILE ${name}`)
        ) {
          return null;
        }
        out.files.push({ name: name as MoveArtifact, size, sha256 });
        break;
      }
      case 'FILTERED_DELETED':
      case 'SKIPPED': {
        const path = rest.length === 1 ? decode(rest[0]) : null;
        if (!path) return null;
        (kind === 'SKIPPED' ? out.skipped : out.filteredDeleted).push(path);
        break;
      }
      case 'SKIPPED_COUNT':
        if (rest.length !== 1 || !/^\d+$/.test(rest[0]) || !once(kind)) return null;
        out.skippedCount = Number(rest[0]);
        break;
      case 'SKIPDIR': {
        const path = rest.length === 2 ? decode(rest[0]) : null;
        if (!path || !/^\d+$/.test(rest[1])) return null;
        out.skippedDirs.push({ path, files: Number(rest[1]) });
        break;
      }
      case 'MISSING_SESSION':
        if (rest.length !== 1 || !SESSION_ID.test(rest[0])) return null;
        out.missingSessions.push(rest[0]);
        break;
      default:
        return null;
    }
  }
  if (!seen.has('HEAD') || !seen.has('BRANCH') || !seen.has('UPSTREAM') || out.skippedCount < 0) return null;
  if (REQUIRED_ARTIFACTS.some((name) => !out.files.some((f) => f.name === name))) return null;
  // The current branch must be one of the carried refs, at HEAD.
  if (out.branch && !out.refs.some((r) => r.name === `refs/heads/${out.branch}` && r.sha === out.head)) return null;
  return out;
}

/**
 * The new box's side, run in the repository after the clone: check every
 * copied file's size and sha256, bring the commits in from the bundle (and
 * any tip it did not need from origin), put every carried ref back, check out
 * the same branch with its upstream, apply the staged then the unstaged
 * changes, then write the filtered files' raw bytes, the ignored files and
 * the conversations.
 */
export function moveImportScript(input: { workbenchId: string; manifest: MoveManifest }): string {
  const { manifest } = input;
  const has = (name: MoveArtifact) => manifest.files.some((f) => f.name === name);
  const q = shellQuote;
  const lines = [
    'set -u',
    `d=${q(moveImportDir(input.workbenchId))}`,
    'trap \'rm -rf -- "$d"\' EXIT',
    ...manifest.files.flatMap((f) => [
      `[ "$(stat -c %s -- "$d/${f.name}" 2>/dev/null)" = ${f.size} ] || { echo ${q(`size mismatch: ${f.name}`)} >&2; exit 20; }`,
      `printf '%s  %s\\n' ${f.sha256} "$d/${f.name}" | sha256sum -c --status || { echo ${q(`checksum mismatch: ${f.name}`)} >&2; exit 20; }`,
    ]),
    // A shallow golden fetches a missing commit at depth 1; a full clone fetches it as it is.
    'depth=; if [ "$(git rev-parse --is-shallow-repository)" = true ]; then depth=--depth=1; fi',
    'have() { git cat-file -e "$1^{commit}" 2>/dev/null || git fetch --quiet --no-tags $depth origin "$1"; }',
  ];
  if (has('repo.bundle')) {
    lines.push(
      // The bundle's prerequisites: commits the old box had from the remote.
      `sed -n '/^$/q; s/^-\\([0-9a-f]\\{40,64\\}\\).*/\\1/p' "$d/repo.bundle" > "$d/prereqs" || exit 21`,
      'while read -r p; do have "$p" || exit 21; done < "$d/prereqs"',
      `git fetch --quiet --no-tags "$d/repo.bundle" '+refs/*:refs/talyn-import/*' || exit 21`,
    );
  }
  const shas = [...new Set([manifest.head, ...manifest.refs.map((r) => r.sha)])];
  lines.push(...shas.map((sha) => `have ${sha} || exit 21`));
  // Detached first, so the branch the clone checked out can move.
  lines.push('git checkout --quiet --detach || exit 22');
  for (const ref of manifest.refs) {
    if (ref.name === 'refs/stash') continue;
    lines.push(`git update-ref ${q(ref.name)} ${ref.sha} || exit 22`);
  }
  const stash = manifest.refs.find((r) => r.name === 'refs/stash');
  if (stash) {
    // Through `stash store`, so `git stash list` shows it: a bare ref has no reflog.
    lines.push(`git update-ref -d refs/stash 2>/dev/null; git stash store -q -m 'Moved from the old sandbox' ${stash.sha} || exit 22`);
  }
  lines.push(`git for-each-ref --format='%(refname)' refs/talyn-import | while read -r r; do git update-ref -d "$r"; done`);
  for (const ref of manifest.refs) {
    if (!ref.name.startsWith('refs/heads/')) continue;
    const name = ref.name.slice('refs/heads/'.length);
    if (ref.upstream.startsWith('origin/')) {
      lines.push(
        `git config branch.${q(name)}.remote origin && git config branch.${q(name)}.merge ${q(`refs/heads/${ref.upstream.slice('origin/'.length)}`)} || exit 22`,
      );
    } else {
      lines.push(`git config --unset branch.${q(name)}.remote 2>/dev/null; git config --unset branch.${q(name)}.merge 2>/dev/null; true`);
    }
  }
  if (manifest.branch) {
    lines.push(`git checkout --quiet -f ${q(manifest.branch)} || exit 22`);
    if (manifest.upstream.startsWith('origin/')) {
      const remoteBranch = manifest.upstream.slice('origin/'.length);
      const spec = q(`+refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`);
      lines.push(
        `git config --get-all remote.origin.fetch | grep -qxF -e ${q('+refs/heads/*:refs/remotes/origin/*')} -e ${spec} || git config --add remote.origin.fetch ${spec}`,
        `git fetch --quiet --no-tags origin ${spec} 2>/dev/null || true`,
      );
    }
  } else {
    lines.push(`git checkout --quiet -f --detach ${manifest.head} || exit 22`);
  }
  lines.push(
    'gunzip -c "$d/staged.patch.gz" > "$d/staged.patch" || exit 23',
    'if [ -s "$d/staged.patch" ]; then git apply --index --binary --whitespace=nowarn "$d/staged.patch" || exit 23; fi',
    'gunzip -c "$d/unstaged.patch.gz" > "$d/unstaged.patch" || exit 24',
    'if [ -s "$d/unstaged.patch" ]; then git apply --binary --whitespace=nowarn "$d/unstaged.patch" || exit 24; fi',
  );
  if (has('filtered.tgz')) lines.push('tar -xzf "$d/filtered.tgz" -C . || exit 25');
  for (const path of manifest.filteredDeleted) lines.push(`rm -f -- ${q(path)} || exit 25`);
  if (has('ignored.tgz')) lines.push('tar -xzf "$d/ignored.tgz" -C . || exit 25');
  if (has('agent.tgz')) lines.push('tar -xzf "$d/agent.tgz" -C / || exit 26');
  return lines.join('\n');
}

// ============================================================================
// The move
// ============================================================================

const inFlight = new Map<string, Promise<MoveResult>>();
const held = new Map<string, number>();

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

/** Tests only: wait for every move this process is running. */
export async function settleMovesForTests(): Promise<void> {
  await Promise.allSettled([...inFlight.values()]);
}

/** Tests only: forget holds and stale-golden checks. The backoff is on the row. */
export function resetMovesForTests(): void {
  held.clear();
  staleChecks.clear();
}

/** Whether automatic moves wait, from the failures recorded on the row. */
export function backingOff(row: Pick<WorkbenchRow, 'settings'>, now = Date.now()): boolean {
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const failures = Number(settings.moveFailures ?? 0);
  const at = typeof settings.moveFailedAt === 'string' ? Date.parse(settings.moveFailedAt) : NaN;
  if (!failures || Number.isNaN(at)) return false;
  return now - at < Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
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

/** Renews the claim while a move runs. `lost` once a renewal finds the row in another state. */
interface Lease {
  lost: boolean;
  stop: () => void;
}

function startLease(id: string, from: string, target: string): Lease {
  const lease: Lease = { lost: false, stop: () => undefined };
  const timer = setInterval(() => {
    void heartbeatMove(id, from, target)
      .then((ok) => {
        if (!ok) lease.lost = true;
      })
      .catch((err) => console.warn(`[workbench] renewing the move lease of ${id} failed:`, err));
  }, LEASE_RENEW_MS);
  timer.unref?.();
  lease.stop = () => clearInterval(timer);
  return lease;
}

class MoveBusy extends Error {}
class MoveBlocked extends Error {}

interface Created {
  sandboxId: string;
  fleetHost: string | null;
  fleetSandboxId: string | null;
}

async function runMove(row: WorkbenchRow, reason: MoveReason, opts: MoveOptions): Promise<MoveResult> {
  if (row.archivedAt || row.runtime !== 'sandbox' || !row.sandboxId || held.has(row.id)) {
    return { moved: false, reason: 'not_applicable' };
  }
  const from = row.sandboxId;
  const previousMessage = row.statusMessage;
  const targetId = await freeSandboxId(row);
  const claimed = await claimMove(row.id, from, targetId, 'Saving the session’s work');
  if (!claimed) return { moved: false, reason: 'busy' };
  const lease = startLease(row.id, from, targetId);

  let created: Created | null = null;
  let step = 'claim';
  let chats: ChatRow[] = [];
  let stopped = false;
  let manifest: MoveManifest | null = null;
  let committed: WorkbenchRow | null = null;
  try {
    // Read only now that the claim has committed: a turn that started before it is seen here.
    if ((await otherRunningChats(row.id, opts.ownerChatId)) > 0) throw new MoveBusy();
    opts.onClaim?.(true);
    await emitWorkbenchUpdated(await publicWorkbench(claimed));
    recordWorkbenchEvent(claimed, 'move_start', `${reason}: ${from} → ${targetId}`);
    chats = await listChats(row.id);
    const sessions: MoveSession[] = chats
      .filter((c) => c.agentSessionId)
      .map((c) => ({ agent: c.agent === 'codex' ? 'codex' : 'claude', sessionId: c.agentSessionId! }));

    step = 'stop';
    stopped = await stopOldBoxWork(claimed);

    step = 'export';
    manifest = await exportFromOldBox(claimed, sessions);

    if (lease.lost || !(await heartbeatMove(row.id, from, targetId))) throw new Error('the move lost its claim');
    step = 'create';
    await setMessage(claimed, 'Starting a fresh sandbox');
    const { createWorkbenchSandbox } = await import('./lifecycle.js');
    const made = await createWorkbenchSandbox(claimed, targetId);
    if (!made.ok) throw new Error(made.error);
    created = made;
    await setMoveTargetHost(row.id, from, targetId, made.fleetHost, made.fleetSandboxId);
    const fresh: WorkbenchRow = { ...claimed, sandboxGeneration: made.sandboxId, sandboxId: made.sandboxId, fleetHost: made.fleetHost ?? null };

    if (lease.lost || !(await heartbeatMove(row.id, from, targetId))) throw new Error('the move lost its claim');
    step = 'clone';
    const cloned = await runCapture(fresh, cloneScript(claimed), { cwd: '/', timeoutMs: CLONE_TIMEOUT_MS });
    if (cloned.exitCode !== 0) throw new Error(`the clone failed: ${tail(cloned.stderr) || `exit ${cloned.exitCode}`}`);

    if (lease.lost || !(await heartbeatMove(row.id, from, targetId))) throw new Error('the move lost its claim');
    step = 'transfer';
    await setMessage(claimed, 'Copying the work into the new sandbox');
    for (const file of manifest.files) await transferFile(claimed, fresh, file);

    if (lease.lost || !(await heartbeatMove(row.id, from, targetId))) throw new Error('the move lost its claim');
    step = 'import';
    const imported = await runCapture(fresh, moveImportScript({ workbenchId: row.id, manifest }), {
      quiet: true,
      timeoutMs: IMPORT_TIMEOUT_MS,
    });
    if (imported.exitCode !== 0) {
      const what = MOVE_IMPORT_EXIT[imported.exitCode] ?? `the import exited ${imported.exitCode}`;
      throw new Error(`${what}${tail(imported.stderr) ? `: ${tail(imported.stderr)}` : ''}`);
    }

    if (lease.lost || !(await heartbeatMove(row.id, from, targetId))) throw new Error('the move lost its claim');
    step = 'setup';
    const setupNote = await runSetup(claimed, fresh);

    step = 'commit';
    if (lease.lost || !(await heartbeatMove(row.id, from, targetId))) throw new Error('the move lost its claim');
    committed = await commitMove(row.id, from, {
      sandboxId: made.sandboxId,
      fleetHost: made.fleetHost ?? null,
      fleetSandboxId: made.fleetSandboxId,
      statusMessage: setupNote,
      ...(reason === 'stale_golden' ? {} : { settings: { movedForDiskTo: made.sandboxId } }),
    });
    if (!committed) throw new Error('the session was archived, deleted or swept during the move');
  } catch (err) {
    try {
      return await handleFailure({ row, claimed, from, targetId, previousMessage, created, step, err, reason, manifest, chats, stopped, opts });
    } finally {
      lease.stop();
    }
  }
  lease.stop();
  await afterCommit(claimed, committed, reason, manifest, chats, stopped, opts);
  return { moved: true, row: committed };
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-3).join(' ').slice(-300);
}

/**
 * Stop what writes the old box after the export would read it: the scripts
 * (followed here or by another instance) and every terminal. True when
 * anything was running.
 */
async function stopOldBoxWork(row: WorkbenchRow): Promise<boolean> {
  const terminals = closeWorkbenchTerminals(row.id);
  const followed = runningScriptNames(row.id).length;
  await stopAllScripts(row).catch(() => undefined);
  // The pattern comes from the env and is bracketed, so it never matches this script's own command line.
  const r = await runCapture(
    row,
    [
      'pat="[$(printf %.1s "$TALYN_PREFIX")]$(printf %s "$TALYN_PREFIX" | cut -c2-)"',
      'n=$(pgrep -fc "$pat" 2>/dev/null || true)',
      'pkill -TERM -f "$pat" 2>/dev/null || true',
      't=$(tmux list-sessions 2>/dev/null | wc -l)',
      'tmux kill-server 2>/dev/null || true',
      'echo "$(( ${n:-0} + ${t:-0} ))"',
    ].join('\n'),
    { cwd: '/', env: { TMPDIR: '/dev/shm', TALYN_PREFIX: `talyn-script-${row.id}` }, quiet: true, timeoutMs: 60_000 },
  ).catch(() => null);
  const remote = Number(r?.stdout.trim() || 0) || 0;
  return terminals + followed + remote > 0;
}

async function exportFromOldBox(row: WorkbenchRow, sessions: MoveSession[]): Promise<MoveManifest> {
  const r = await runCapture(row, moveExportScript({ workbenchId: row.id, sessions }), {
    env: moveExportEnv(row.id),
    quiet: true,
    timeoutMs: EXPORT_TIMEOUT_MS,
  });
  if (BLOCKING_EXITS.has(r.exitCode)) throw new MoveBlocked(MOVE_EXPORT_EXIT[r.exitCode]);
  if (r.exitCode !== 0) {
    const what = MOVE_EXPORT_EXIT[r.exitCode] ?? `the export exited ${r.exitCode}`;
    throw new Error(`${what}${tail(r.stderr) ? `: ${tail(r.stderr)}` : ''}`);
  }
  if (r.truncated) throw new Error('the export answer was cut short');
  const manifest = parseMoveManifest(r.stdout);
  if (!manifest) throw new Error('the export did not finish: its manifest is incomplete');
  const total = manifest.files.reduce((sum, f) => sum + f.size, 0);
  if (total > MOVE_TRANSFER_MAX_BYTES) {
    throw new Error(
      `the work comes to ${Math.ceil(total / MIB)} MB compressed, ` +
        `more than the ${MOVE_TRANSFER_MAX_BYTES / MIB} MB a move can carry`,
    );
  }
  return manifest;
}

/** One staged file, old box to new, a chunk at a time. Every chunk's length is checked. */
async function transferFile(oldRow: WorkbenchRow, newRow: WorkbenchRow, file: MoveManifest['files'][number]): Promise<void> {
  const source = `${moveStagingDir(oldRow.id)}/${file.name}`;
  const dir = moveImportDir(oldRow.id);
  const target = shellQuote(`${dir}/${file.name}`);
  const part = `${dir}/${file.name}.part`;
  if (file.size === 0) {
    await writeSandboxFiles(newRow, [], { before: `mkdir -p ${shellQuote(dir)} && : > ${target}` });
    return;
  }
  for (let offset = 0; offset < file.size; offset += MOVE_CHUNK_BYTES) {
    const length = Math.min(MOVE_CHUNK_BYTES, file.size - offset);
    const r = await runCapture(oldRow, moveReadChunkScript(source, offset, length), {
      cwd: '/',
      env: moveExportEnv(oldRow.id),
      quiet: true,
      timeoutMs: CHUNK_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) throw new Error(`could not read ${file.name} on the old sandbox: ${tail(r.stderr)}`);
    if (r.truncated || r.stdoutBytes.length !== length) {
      throw new Error(`reading ${file.name} returned ${r.stdoutBytes.length} of ${length} bytes`);
    }
    await writeSandboxFiles(newRow, [{ path: part, base64: r.stdoutBytes.toString('base64') }], {
      ...(offset === 0 ? { before: `mkdir -p ${shellQuote(dir)} && : > ${target}` } : {}),
      after: `cat ${shellQuote(part)} >> ${target} && rm -f ${shellQuote(part)}`,
      timeoutMs: CHUNK_TIMEOUT_MS,
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

/** Report only work that did not survive. */
export function movedNote(input: {
  reason: MoveReason;
  conversation: 'carried' | 'missing' | 'none';
  stopped: boolean;
  manifest: Pick<MoveManifest, 'skipped' | 'skippedCount' | 'skippedDirs'>;
}): string | null {
  const parts: string[] = [];
  const skipped = skippedNote(input.manifest);
  if (skipped) parts.push(skipped);
  if (input.conversation === 'missing') parts.push('the agent conversation could not be restored; the transcript is still available');
  if (input.stopped) parts.push('running scripts and terminals were stopped; start them again');
  if (!parts.length) return null;
  const text = parts.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

export function skippedNote(manifest: Pick<MoveManifest, 'skipped' | 'skippedCount' | 'skippedDirs'>): string | null {
  if (!manifest.skippedCount) return null;
  const names = manifest.skipped.slice(0, 10).join(', ');
  const more = manifest.skippedCount - Math.min(10, manifest.skipped.length);
  return `these files did not carry over: ${names}${more > 0 ? ` and ${more} more` : ''}`;
}

async function note(chat: ChatRow, subtype: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  const stored = await appendEvents(chat.id, [{ turn: chat.turnCount, event: { type: 'system', subtype, text, ...extra } }]);
  emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
}

async function noteAll(workbenchId: string, subtype: string, text: string): Promise<void> {
  for (const chat of await listChats(workbenchId)) {
    if (!chat.closedAt) await note(chat, subtype, text).catch(() => undefined);
  }
}

async function startQueued(workbenchId: string, ownerChatId?: string): Promise<void> {
  const { startQueuedIfIdle } = await import('./turns.js');
  for (const chat of await listChats(workbenchId)) {
    if (chat.id === ownerChatId || chat.closedAt || chat.queuedMessages.length === 0) continue;
    await startQueuedIfIdle(chat.id).catch(() => false);
  }
}

/** Run one post-commit step. Nothing after the commit may undo it, so a failure is logged and the rest go on. */
async function bestEffort(row: WorkbenchRow, what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.warn(`[workbench] after moving ${row.id}, ${what} failed:`, err);
    recordWorkbenchEvent(row, 'move_cleanup', `${what} failed`, false, err);
  }
}

async function afterCommit(
  old: WorkbenchRow,
  committed: WorkbenchRow,
  reason: MoveReason,
  manifest: MoveManifest | null,
  chats: ChatRow[],
  stopped: boolean,
  opts: MoveOptions,
): Promise<void> {
  staleChecks.delete(old.id);
  recordWorkbenchEvent(committed, 'moved', `${old.sandboxId} → ${committed.sandboxId} (${reason})`);
  await bestEffort(committed, 'announcing the new sandbox', async () => {
    const current = await getWorkbench(committed.id);
    if (current) await emitWorkbenchUpdated(await publicWorkbench(current));
  });
  await bestEffort(committed, 'stopping the old followers', () => stopAllScripts(old));
  await bestEffort(committed, `deleting the old sandbox ${old.sandboxId}`, async () =>
    (await fleetClientFor(old.workspaceId, old.fleetHost)).deleteSandbox(old.sandboxId!),
  );
  const missing = new Set(manifest?.missingSessions ?? []);
  for (const chat of chats) {
    if (chat.closedAt) continue;
    await bestEffort(committed, `the note in chat ${chat.id}`, async () => {
      let current = chat;
      let conversation: 'carried' | 'missing' | 'none' = chat.agentSessionId ? 'carried' : 'none';
      if (chat.agentSessionId && missing.has(chat.agentSessionId)) {
        conversation = 'missing';
        // Its file was not on the old box, so a resume would fail the next turn.
        const cleared = await updateChat(chat.id, { agentSessionId: null });
        if (cleared) {
          current = cleared;
          emitWorkbenchChat(cleared.workspaceId, rowToChat(cleared));
        }
      }
      const text = movedNote({
        reason,
        conversation,
        stopped,
        manifest: manifest ?? { skipped: [], skippedCount: 0, skippedDirs: [] },
      });
      if (text) await note(current, 'sandbox_moved', text, manifest?.skipped.length ? { skippedFiles: manifest.skipped } : {});
    });
  }
  await bestEffort(committed, 'starting queued messages', () => startQueued(committed.id, opts.ownerChatId));
}

async function handleFailure(f: {
  row: WorkbenchRow;
  claimed: WorkbenchRow;
  from: string;
  targetId: string;
  previousMessage: string | null;
  created: Created | null;
  step: string;
  err: unknown;
  reason: MoveReason;
  manifest: MoveManifest | null;
  chats: ChatRow[];
  stopped: boolean;
  opts: MoveOptions;
}): Promise<MoveResult> {
  const { row, claimed, from, targetId, created, err } = f;

  // A commit whose answer was lost: if the row names the new box, it is the session's box now.
  let current: WorkbenchRow | null;
  try {
    current = await getWorkbench(row.id);
  } catch (readErr) {
    console.error(`[workbench] moving ${row.id}: could not re-read the row after a failure, so nothing is cleaned up:`, readErr);
    return { moved: false, reason: 'failed', message: userFacingError(err) };
  }
  if (current && current.sandboxId === targetId && current.status !== 'moving') {
    recordWorkbenchEvent(current, 'move_commit_recovered', 'the commit landed although its answer was lost');
    await afterCommit(claimed, current, f.reason, f.manifest, f.chats, f.stopped, f.opts);
    return { moved: true, row: current };
  }

  if (err instanceof MoveBusy) {
    const released = await releaseMove(row.id, from, targetId, f.previousMessage).catch(() => null);
    if (released) await emitWorkbenchUpdated(await publicWorkbench(released)).catch(() => undefined);
    await startQueued(row.id, f.opts.ownerChatId).catch(() => undefined);
    return { moved: false, reason: 'busy' };
  }

  const blocked = err instanceof MoveBlocked;
  const message = userFacingError(err);
  console.warn(`[workbench] moving ${row.id} ${blocked ? 'refused' : 'failed'} at ${f.step}:`, err);
  recordWorkbenchEvent(claimed, blocked ? 'move_blocked' : 'move_failed', `${f.step}: ${message}`, false, err);

  if (created) {
    try {
      const client = await fleetClientFor(claimed.workspaceId, created.fleetHost);
      await client.deleteSandbox(created.sandboxId);
    } catch (deleteErr) {
      console.warn(`[workbench] deleting the half-made sandbox ${created.sandboxId} failed:`, deleteErr);
      recordWorkbenchEvent(claimed, 'move_cleanup', `new sandbox ${created.sandboxId} not deleted`, false, deleteErr);
    }
  }
  const oldBoxLost = f.step === 'export' && err instanceof FleetRunNotFoundError;
  if (!oldBoxLost) await dropStaging(claimed);
  const released = await releaseMove(row.id, from, targetId, f.previousMessage).catch((releaseErr) => {
    console.warn(`[workbench] releasing the move of ${row.id} failed:`, releaseErr);
    return null;
  });
  await recordMoveFailure(row.id).catch(() => null);
  if (!released) return { moved: false, reason: blocked ? 'blocked' : 'failed', message };

  await emitWorkbenchUpdated(await publicWorkbench(released)).catch(() => undefined);
  if (oldBoxLost && !released.archivedAt) await recoverLostSandbox(released, err).catch(() => undefined);
  if (f.stopped && !released.archivedAt) {
    await noteAll(row.id, 'sandbox_processes_stopped', 'Talyn stopped running scripts and terminals; start them again.').catch(() => undefined);
  }
  if (released.archivedAt) {
    const { scheduleArchive } = await import('./lifecycle.js');
    scheduleArchive(row.id);
  } else {
    await startQueued(row.id, f.opts.ownerChatId).catch(() => undefined);
  }
  return { moved: false, reason: blocked ? 'blocked' : 'failed', message };
}

/** The staging lives in memory, but a long-lived box should not keep it. */
async function dropStaging(row: WorkbenchRow): Promise<void> {
  const env = moveExportEnv(row.id);
  await runCapture(row, `rm -rf -- ${shellQuote(moveStagingDir(row.id))} ${shellQuote(env.GIT_INDEX_FILE)}`, {
    cwd: '/',
    env,
    quiet: true,
    timeoutMs: 60_000,
  }).catch(() => undefined);
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
  if (row.archivedAt || row.runtime !== 'sandbox' || row.status !== 'ready' || !row.sandboxId) return false;
  if (held.has(row.id) || backingOff(row)) return false;
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
  const r = await runCapture(row, DISK_PROBE_SCRIPT, { cwd: '/', env: { TMPDIR: '/dev/shm' }, quiet: true, timeoutMs: 60_000 });
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

/**
 * A box a disk move already made, still on the newest golden: a second move
 * would land on the same image with the same work, so it is not made. The
 * chats are told once per box.
 */
async function alreadyFreshForDisk(row: WorkbenchRow): Promise<boolean> {
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  if (!row.sandboxId || settings.movedForDiskTo !== row.sandboxId) return false;
  const stale = await fleetClientFor(row.workspaceId, row.fleetHost)
    .then((client) => client.getSandbox(row.sandboxId!))
    .then((r) => r.sandbox.goldenStale === true)
    .catch(() => false);
  if (stale) return false;
  if (settings.lowDiskNotedFor !== row.sandboxId) {
    await mergeWorkbenchSettings(row.id, { lowDiskNotedFor: row.sandboxId }).catch(() => undefined);
    await noteAll(
      row.id,
      'sandbox_low_disk',
      'This sandbox is on the newest image and still has less than 2 GB free. Remove large files or build outputs to make room.',
    ).catch(() => undefined);
  }
  return true;
}

export type DiskRecovery = { ok: true; row: WorkbenchRow; action: 'grown' | 'moved' } | { ok: false };

/** T2 and T3: grow the disk when the fleet can, else move. */
export async function growOrMove(
  row: WorkbenchRow,
  reason: 'low_disk' | 'disk_full',
  opts: { ownerChatId?: string; probe?: DiskProbe | null } = {},
): Promise<DiskRecovery> {
  const current = await getWorkbench(row.id);
  if (!current || current.archivedAt || current.status !== 'ready' || current.sandboxId !== row.sandboxId || held.has(row.id)) {
    return { ok: false };
  }
  const grown = await tryGrowDisk(row, opts.probe).catch((err) => {
    console.warn(`[workbench] growing the disk of ${row.id} failed:`, err);
    return false;
  });
  if (grown) return { ok: true, row, action: 'grown' };
  if (backingOff(row) || (await alreadyFreshForDisk(row))) return { ok: false };
  const moved = await moveWorkbenchToFreshSandbox(row, reason, { ownerChatId: opts.ownerChatId });
  return moved.moved ? { ok: true, row: moved.row, action: 'moved' } : { ok: false };
}

/**
 * T3 from the exec layer: an idempotent exec failed on a full disk. A grow
 * keeps the same box, so the caller may run once more: true. Otherwise a move
 * starts in the background and the caller does not retry.
 */
export async function growForDiskFull(row: WorkbenchRow): Promise<boolean> {
  const fresh = await getWorkbench(row.id);
  if (!fresh || fresh.archivedAt || fresh.status !== 'ready' || fresh.sandboxId !== row.sandboxId || held.has(row.id)) return false;
  const grown = await tryGrowDisk(fresh).catch(() => false);
  if (grown) return true;
  if (!backingOff(fresh) && !(await alreadyFreshForDisk(fresh))) {
    void moveWorkbenchToFreshSandbox(fresh, 'disk_full').catch(() => undefined);
  }
  return false;
}

/**
 * The sweep: a move whose lease lapsed, because its process died. The row
 * still names the old box, which holds the work, so the move is undone, the
 * half-made box deleted on the host it was made on, and the staging dropped.
 * A move with a live lease (this instance's or another's) is never touched.
 */
export async function sweepAbandonedMoves(): Promise<number> {
  let undone = 0;
  for (const row of await staleMovingWorkbenches(LEASE_STALE_SECONDS)) {
    if (inFlight.has(row.id) || !row.sandboxId) continue;
    const settings = (row.settings ?? {}) as Record<string, unknown>;
    const target = typeof settings.moveSandboxId === 'string' ? settings.moveSandboxId : null;
    if (!target) continue;
    const released = await releaseMove(row.id, row.sandboxId, target, null, { staleAfterSeconds: LEASE_STALE_SECONDS });
    if (!released) continue;
    undone++;
    recordWorkbenchEvent(released, 'move_abandoned', 'a move whose process stopped was undone', false);
    await emitWorkbenchUpdated(await publicWorkbench(released)).catch(() => undefined);
    if (target !== row.sandboxId) {
      const host = typeof settings.moveTargetHost === 'string' ? settings.moveTargetHost : row.fleetHost;
      await fleetClientFor(row.workspaceId, host)
        .then((client) => client.deleteSandbox(target))
        .catch((err) => console.warn(`[workbench] deleting the abandoned sandbox ${target} failed:`, err));
    }
    if (!released.archivedAt) {
      await dropStaging(released);
      await startQueued(row.id).catch(() => undefined);
    }
  }
  return undone;
}
