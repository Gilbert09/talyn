import { checkpointRestoreSteps, shellQuote, toShellScript, WORKBENCH_IMPORT_MAX_BYTES } from '@talyn/shared';

/**
 * A session's saved work, as data: the guest scripts, their parsers and the
 * chat notes. No I/O here, so the scripts can run against real repositories
 * in a test.
 *
 * The work is a hidden commit: the work tree staged into a TEMPORARY copy of
 * the index (`add -A`, so untracked files that are not ignored are included),
 * written as a tree, and committed with HEAD as its parent. The branch, HEAD,
 * the real index and the work tree are never touched. The commit goes into a
 * `git bundle` relative to the base branch, which therefore also carries every
 * commit that was not pushed. Nothing is pushed: the bundle leaves the box
 * through exec and is kept in Talyn's storage (`workStorage.ts`).
 */

/**
 * The largest bundle Talyn keeps, compressed. Storage is not what bounds it:
 * the bundle is stored in 2 MiB parts, far under Supabase Storage's per-object
 * limit (50 MB by default). The transfer is: every part is one exec out of the
 * box, and on restore one exec per 288 KiB back in. This is the most a move
 * carries over the same channel (`MOVE_TRANSFER_MAX_BYTES`), so a session that
 * can move can also be saved. With one checkpoint and one archive per session,
 * a session holds at most twice this. A larger bundle is refused with a note,
 * never cut.
 */
export const WORK_BUNDLE_MAX_BYTES = 4 * WORKBENCH_IMPORT_MAX_BYTES;

export type WorkKind = 'checkpoint' | 'archive';

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid workbench id for saved work: ${id}`);
  return id;
}

/** A LOCAL ref in the box that names the last saved commit, so the bundle has a ref and `gc` keeps it. Never pushed. */
export function workLocalRef(workbenchId: string): string {
  return `refs/talyn/work/${safeId(workbenchId)}`;
}

/**
 * Where the box stages the bundle: tmpfs, so a box with a full disk can still
 * save. The script reads it as `$TMPDIR/talyn-work-<id>`, and `saveWork` runs
 * it with `TMPDIR=/dev/shm`, which is this path.
 */
export function workStagingDir(workbenchId: string): string {
  return `/dev/shm/talyn-work-${safeId(workbenchId)}`;
}

export function workStagedBundle(workbenchId: string): string {
  return `${workStagingDir(workbenchId)}/work.bundle`;
}

/** Where a replacement box receives the bundle. Its disk is fresh. */
export function workRestoreBundle(workbenchId: string): string {
  return `/tmp/talyn-work-${safeId(workbenchId)}.bundle`;
}

const IDENTITY = [
  'GIT_AUTHOR_NAME=Talyn',
  'GIT_AUTHOR_EMAIL=checkpoints@talyn.dev',
  'GIT_COMMITTER_NAME=Talyn',
  'GIT_COMMITTER_EMAIL=checkpoints@talyn.dev',
].join(' ');

/** The box's `sha256sum`, or macOS's `shasum` for the tests. */
const SHA256 = 'sha256_of() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d" " -f1; }';

/**
 * Save the work as a bundle in the staging folder, or say why not.
 *
 * Prints one line:
 *   CLEAN                                     no uncommitted work and no commit GitHub lacks
 *   UNCHANGED <sha>                           HEAD and the tree are those of `previousSha`
 *   TOO_LARGE <bytes>                         the bundle is over the limit; nothing is staged
 *   BUNDLE <sha> <epoch> <base|-> <bytes> <sha256>
 * and exits non-zero when it could not save. The bundle excludes the base
 * branch's history when the box knows it, and is a full bundle when not.
 */
export function workSaveScript(
  row: { id: string; baseBranch: string },
  opts: { kind: WorkKind; previousSha: string | null; maxBytes?: number },
): string {
  const max = opts.maxBytes ?? WORK_BUNDLE_MAX_BYTES;
  const previous = opts.previousSha && /^[0-9a-f]{40,64}$/.test(opts.previousSha) ? opts.previousSha : '';
  return [
    'set -u',
    SHA256,
    `d="\${TMPDIR:-/dev/shm}"/${shellQuote(`talyn-work-${safeId(row.id)}`)}`,
    `ref=${shellQuote(workLocalRef(row.id))}`,
    'idx="$d.index"',
    'rm -rf -- "$d" "$idx"; mkdir -p "$d" || exit 1',
    'fail() { rm -rf -- "$d" "$idx"; echo "$1" >&2; exit 1; }',
    'head=$(git rev-parse --verify -q HEAD) || fail "the branch has no commit to save on"',
    'real=$(git rev-parse --git-path index) || fail "not a git repository"',
    'if [ -f "$real" ]; then cp "$real" "$idx" || fail "could not copy the index"; fi',
    'GIT_INDEX_FILE="$idx" git add -A -- . >/dev/null || fail "could not stage the work"',
    'tree=$(GIT_INDEX_FILE="$idx" git write-tree) || fail "could not write the tree"',
    'rm -f -- "$idx"',
    'unpushed=$(git rev-list --count HEAD --not --remotes=origin 2>/dev/null || echo 1)',
    'if [ "$tree" = "$(git rev-parse "HEAD^{tree}")" ] && [ "$unpushed" = 0 ]; then rm -rf -- "$d"; echo CLEAN; exit 0; fi',
    `prev=${previous || "''"}`,
    'if [ -n "$prev" ] && git cat-file -e "$prev^{commit}" 2>/dev/null &&',
    '  [ "$(git rev-parse "$prev^{tree}")" = "$tree" ] && [ "$(git rev-parse "$prev^")" = "$head" ]; then',
    '  rm -rf -- "$d"; echo "UNCHANGED $prev"; exit 0',
    'fi',
    `sha=$(${IDENTITY} git commit-tree --no-gpg-sign "$tree" -p "$head" -m ${shellQuote(`talyn work ${opts.kind} ${row.id}`)}) || fail "could not write the commit"`,
    'git update-ref "$ref" "$sha" || fail "could not name the commit"',
    `base=$(git rev-parse -q --verify ${shellQuote(`refs/remotes/origin/${row.baseBranch}^{commit}`)} 2>/dev/null || true)`,
    'if [ -n "$base" ]; then git bundle create "$d/work.bundle" "$ref" --not "$base" >/dev/null 2>&1',
    'else git bundle create "$d/work.bundle" "$ref" >/dev/null 2>&1; fi || fail "could not write the bundle"',
    'size=$(wc -c < "$d/work.bundle" | tr -d " ")',
    `if [ "$size" -gt ${max} ]; then rm -rf -- "$d"; echo "TOO_LARGE $size"; exit 0; fi`,
    'echo "BUNDLE $sha $(git log -1 --format=%ct "$sha") ${base:--} $size $(sha256_of "$d/work.bundle")"',
  ].join('\n');
}

/** Remove the staging folder after the bundle has been read out. */
export function workCleanupScript(workbenchId: string): string {
  return `rm -rf -- ${shellQuote(workStagingDir(workbenchId))} ${shellQuote(`${workStagingDir(workbenchId)}.index`)}`;
}

export type WorkSaveResult =
  | { kind: 'bundle'; sha: string; at: Date; base: string | null; size: number; sha256: string }
  | { kind: 'clean' }
  | { kind: 'unchanged'; sha: string }
  | { kind: 'too_large'; size: number }
  | { kind: 'failed'; detail: string };

function tailOf(stderr: string): string {
  return stderr.trim().split('\n').slice(-3).join(' ').slice(-300);
}

export function parseWorkSave(r: { exitCode: number; stdout: string; stderr: string }): WorkSaveResult {
  const line = r.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (r.exitCode === 0) {
    if (line === 'CLEAN') return { kind: 'clean' };
    const unchanged = /^UNCHANGED ([0-9a-f]{40,64})$/.exec(line);
    if (unchanged) return { kind: 'unchanged', sha: unchanged[1] };
    const large = /^TOO_LARGE (\d+)$/.exec(line);
    if (large) return { kind: 'too_large', size: Number(large[1]) };
    const b = /^BUNDLE ([0-9a-f]{40,64}) (\d+) ([0-9a-f]{40,64}|-) (\d+) ([0-9a-f]{64})$/.exec(line);
    if (b) {
      return { kind: 'bundle', sha: b[1], at: new Date(Number(b[2]) * 1000), base: b[3] === '-' ? null : b[3], size: Number(b[4]), sha256: b[5] };
    }
  }
  return { kind: 'failed', detail: tailOf(r.stderr) || `saving the work exited ${r.exitCode}` };
}

/**
 * After a replacement box's clone, with the bundle already copied to
 * {@link workRestoreBundle}: check it, bring its commits in, and apply it.
 *
 * Prints one line:
 *   STALE <sha> <epoch>               the branch on GitHub moved past the saved commit's parent
 *   RESTORED <sha> <epoch> <commits>  applied; <commits> were carried that GitHub does not have
 *
 * The saved commit's parent is where HEAD was. When the branch on GitHub is
 * that commit or behind it (or does not exist), the branch is moved to it,
 * which keeps the commits that were not pushed, and the saved tree is written
 * as uncommitted changes. When GitHub's branch is not an ancestor of it,
 * somebody pushed after the save: applying it would undo that work, so it is
 * left alone and reported. A prerequisite the box lacks (a shallow clone) is
 * fetched from origin, as a move's import does.
 */
export function workRestoreScript(
  row: { id: string; branch: string },
  meta: { sha: string; size: number; sha256: string },
): string {
  if (!/^[0-9a-f]{40,64}$/.test(meta.sha) || !/^[0-9a-f]{64}$/.test(meta.sha256) || !Number.isInteger(meta.size)) {
    throw new Error('invalid saved work metadata');
  }
  const placeholder = '0'.repeat(40);
  const apply = toShellScript(
    checkpointRestoreSteps({ sha: placeholder, tmpIndexPath: `/tmp/talyn-work-restore-${safeId(row.id)}.index` }),
  ).replace(placeholder, '"$cp"');
  return [
    'set -u',
    SHA256,
    `b=${shellQuote(workRestoreBundle(row.id))}`,
    `ref=${shellQuote(workLocalRef(row.id))}`,
    'trap \'rm -f -- "$b" "$b.prereqs"\' EXIT',
    `[ "$(wc -c < "$b" | tr -d " ")" = ${meta.size} ] || { echo "the saved work did not arrive whole" >&2; exit 20; }`,
    `[ "$(sha256_of "$b")" = ${meta.sha256} ] || { echo "the saved work did not match its checksum" >&2; exit 20; }`,
    'depth=; if [ "$(git rev-parse --is-shallow-repository)" = true ]; then depth=--depth=1; fi',
    'have() { git cat-file -e "$1^{commit}" 2>/dev/null || git fetch --quiet --no-tags $depth origin "$1"; }',
    `sed -n '/^$/q; s/^-\\([0-9a-f]\\{40,64\\}\\).*/\\1/p' "$b" > "$b.prereqs" || exit 21`,
    'while read -r p; do have "$p" >&2 || { echo "the box lacks a commit the saved work builds on" >&2; exit 21; }; done < "$b.prereqs"',
    'git fetch -q --no-tags "$b" "+$ref:$ref" >&2 || { echo "could not read the saved work" >&2; exit 21; }',
    'cp=$(git rev-parse --verify -q "$ref^{commit}") || exit 21',
    `[ "$cp" = ${meta.sha} ] || { echo "the saved work names a different commit" >&2; exit 21; }`,
    'base=$(git rev-parse --verify -q "$cp^") || exit 21',
    'at=$(git log -1 --format=%ct "$cp")',
    `remote=$(git ls-remote origin ${shellQuote(`refs/heads/${row.branch}`)} | cut -f1)`,
    'if [ -n "$remote" ] && ! git merge-base --is-ancestor "$remote" "$base" 2>/dev/null; then echo "STALE $cp $at"; exit 0; fi',
    'commits=$(git rev-list --count "$base" --not --remotes=origin 2>/dev/null || echo 0)',
    'if [ "$(git rev-parse HEAD)" != "$base" ]; then',
    `  { git reset -q --hard && git checkout -q -B ${shellQuote(row.branch)} "$base"; } >&2 || { echo "could not check out the saved commits" >&2; exit 22; }`,
    'fi',
    `export cp; bash -c ${shellQuote(apply)} >&2 || { echo "could not write the saved files" >&2; exit 23; }`,
    'echo "RESTORED $cp $at $commits"',
  ].join('\n');
}

export type WorkRestore =
  | { kind: 'none' }
  | { kind: 'restored'; sha: string; at: Date; commits: number }
  | { kind: 'stale'; sha: string; at: Date }
  | { kind: 'failed'; detail: string };

export function parseWorkRestore(r: { exitCode: number; stdout: string; stderr: string }): WorkRestore {
  const line = r.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (r.exitCode === 0) {
    const restored = /^RESTORED ([0-9a-f]{40,64}) (\d+) (\d+)$/.exec(line);
    if (restored) {
      return { kind: 'restored', sha: restored[1], at: new Date(Number(restored[2]) * 1000), commits: Number(restored[3]) };
    }
    const stale = /^STALE ([0-9a-f]{40,64}) (\d+)$/.exec(line);
    if (stale) return { kind: 'stale', sha: stale[1], at: new Date(Number(stale[2]) * 1000) };
  }
  return { kind: 'failed', detail: tailOf(r.stderr) || `the restore exited ${r.exitCode}` };
}

// ============================================================================
// Notes
// ============================================================================

const LOST_PREFIX = 'The sandbox was lost and Talyn started a new one';

/** The note when no checkpoint exists. Honest, because nothing was saved. */
export const NO_CHECKPOINT_NOTE =
  `${LOST_PREFIX} from the branch on GitHub. Talyn had no checkpoint of this session's work, ` +
  'so changes that were not pushed are lost.';

/** `2026-10-29 14:05 UTC`. The note is stored text, so it names its time zone. */
export function checkpointTime(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function minutes(n: number): string {
  return `${n} minute${n === 1 ? '' : 's'}`;
}

function mb(bytes: number): string {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

function commitsCarried(n: number): string {
  return n > 0 ? `, with ${n} commit${n === 1 ? '' : 's'} that had not been pushed` : '';
}

/** What the replacement box holds of the lost one's work, for the chat. */
export function recoveryWorkNote(restore: WorkRestore, opts: { lostAt: Date; recordedAt?: Date | null }): string {
  switch (restore.kind) {
    case 'none':
      return NO_CHECKPOINT_NOTE;
    case 'restored': {
      const gap = Math.max(0, Math.ceil((opts.lostAt.getTime() - restore.at.getTime()) / 60_000));
      const missing = gap <= 1
        ? 'Changes made in the last minute before the loss may be missing.'
        : `Changes made after it, up to ${minutes(gap)} of work, are missing.`;
      return `${LOST_PREFIX}. Talyn restored the work from a checkpoint taken at ${checkpointTime(restore.at)}${commitsCarried(restore.commits)}. ${missing}`;
    }
    case 'stale':
      return (
        `${LOST_PREFIX} from the branch on GitHub. The branch changed on GitHub after the last checkpoint ` +
        `(taken at ${checkpointTime(restore.at)}), so Talyn did not apply it, because that would undo the newer commits. ` +
        'Talyn keeps the checkpoint.'
      );
    case 'failed': {
      const when = opts.recordedAt ? ` (taken at ${checkpointTime(opts.recordedAt)})` : '';
      return (
        `${LOST_PREFIX} from the branch on GitHub. Talyn could not apply the last checkpoint${when}: ${restore.detail}. ` +
        'Talyn keeps the checkpoint, so the changes may still be recoverable.'
      );
    }
  }
}

/** What came back when an archived session was restored. */
export function archiveRestoreNote(restore: WorkRestore): string {
  const base = 'This session was restored onto a new sandbox.';
  switch (restore.kind) {
    case 'none':
      return base;
    case 'restored':
      return `${base} Talyn put back the work saved when it was archived${commitsCarried(restore.commits)}.`;
    case 'stale':
      return `${base} The branch changed on GitHub after the session was archived, so Talyn did not apply the saved work, because that would undo the newer commits. Talyn keeps the saved work.`;
    case 'failed':
      return `${base} Talyn could not put back the work saved when it was archived: ${restore.detail}. Talyn keeps the saved work.`;
  }
}

/** A checkpoint refused for its size. Shown once until a checkpoint succeeds again. */
export function tooLargeNote(size: number, maxBytes = WORK_BUNDLE_MAX_BYTES): string {
  return (
    `This session's unsaved work comes to ${mb(size)} compressed, more than the ${mb(maxBytes)} Talyn keeps, ` +
    'so Talyn could not save a checkpoint of it. If the sandbox is lost, this work is lost too. ' +
    'Commit and push it, or remove large files that are not ignored.'
  );
}

/** Why an archive kept the sandbox: the work is too large to save. */
export function archiveTooLargeMessage(size: number, maxBytes = WORK_BUNDLE_MAX_BYTES): string {
  return (
    `The session's unsaved work comes to ${mb(size)} compressed, more than the ${mb(maxBytes)} Talyn keeps, ` +
    'so Talyn kept the sandbox. Commit and push the work, or remove large files that are not ignored, then archive again.'
  );
}
