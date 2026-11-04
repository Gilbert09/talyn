import { shellQuote } from '@talyn/shared';
import { CHANGE_LIST_SECTIONS, mergeBaseLine } from './changes.js';
import type { ChangesObjectName } from './changesStore.js';

/**
 * The guest side of a changes capture, as data: the script and its parser.
 * No I/O here, so the script can run against a real repository in a test.
 *
 * The script stages everything in tmpfs (`$TMPDIR`, `/dev/shm` on the box),
 * like the saved work does, and prints a manifest. The work tree is read
 * through a TEMPORARY copy of the index (`add -A`, so untracked files that
 * are not ignored are in it), written as a tree. The real index, HEAD and
 * the work tree are never touched. Every patch is a diff between two trees,
 * so the three scopes agree with each other.
 */

/** The combined patch, uncompressed: the same cap as the preview patch. */
export const CAPTURE_PATCH_MAX_BYTES = 20 * 1024 * 1024;
/** The repository's file list, NUL-separated. */
export const CAPTURE_FILES_MAX_BYTES = 8 * 1024 * 1024;
/** The changed files' contents, in all. Past it, a file is listed without its content. */
export const CAPTURE_CONTENTS_MAX_BYTES = 16 * 1024 * 1024;
/** One changed file's content. Past it, the file is listed without its content. */
export const CAPTURE_FILE_MAX_BYTES = 1024 * 1024;
/** Changed files whose content is read. Each one is a `git cat-file`; past this the rest are listed without content. */
export const CAPTURE_CONTENT_FILES_MAX = 2000;

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid workbench id for a changes capture: ${id}`);
  return id;
}

/** Where the box stages a capture. The script reads it as `$TMPDIR/talyn-changes-<id>`. */
export function captureStagingDir(workbenchId: string, tmp = '/dev/shm'): string {
  return `${tmp}/talyn-changes-${safeId(workbenchId)}`;
}

const SHA256 = 'sha256_of() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d" " -f1; }';
const DIFF = 'git diff --no-color --no-ext-diff --no-textconv --find-renames';

/** The three patches: file name, the two trees, and the label of its name list. */
const PATCHES: Array<{ name: ChangesObjectName; from: string; to: string; names: string }> = [
  { name: 'patch', from: '$mb', to: '$tree', names: 'P_COMBINED' },
  { name: 'patch-uncommitted', from: '$head', to: '$tree', names: 'P_UNCOMMITTED' },
  { name: 'patch-committed', from: '$mb', to: '$head', names: 'P_COMMITTED' },
];

/**
 * Capture the changes, or say that nothing moved.
 *
 * Prints, one per line:
 *   UNCHANGED <mb> <head> <tree>       the same three shas as `previous`; nothing is staged
 *   CAPTURE <mb> <head> <tree>         then, per object:
 *   OBJ <name> <bytes> <sha256> <raw>  a gzip file `<dir>/<name>.gz`; <raw> is its size uncompressed
 *   TOO_LARGE <name> <raw>             over its cap; not staged; at least <raw> bytes
 * and exits non-zero when it could not capture.
 *
 * `lists` is always staged: the changes list, length-prefixed sections
 * (`<LABEL> <bytes>\n<bytes>`), the same git commands as a live list read,
 * plus the name lists of the three patches and the byte offset of each file
 * in them, in the patches' own order.
 */
export function changesCaptureScript(
  row: { id: string; baseBranch: string },
  opts: { previous?: { mergeBase: string; headSha: string; treeSha: string } | null; maxPatchBytes?: number } = {},
): string {
  const maxPatch = opts.maxPatchBytes ?? CAPTURE_PATCH_MAX_BYTES;
  const prev = opts.previous && [opts.previous.mergeBase, opts.previous.headSha, opts.previous.treeSha].every((s) => /^[0-9a-f]{40,64}$/.test(s))
    ? `${opts.previous.mergeBase} ${opts.previous.headSha} ${opts.previous.treeSha}`
    : '';
  const section = (label: string, command: string) => `{ ${command} ; } > "$d/l/${label}" 2>/dev/null || true`;
  return [
    'set -u',
    SHA256,
    `d="\${TMPDIR:-/dev/shm}"/${shellQuote(`talyn-changes-${safeId(row.id)}`)}`,
    'idx="$d.index"',
    'rm -rf -- "$d" "$idx"; mkdir -p "$d/l" || exit 1',
    'fail() { rm -rf -- "$d" "$idx"; echo "$1" >&2; exit 1; }',
    'head=$(git rev-parse --verify -q HEAD) || fail "the branch has no commit"',
    mergeBaseLine(row),
    '[ -n "$mb" ] || fail "no merge base"',
    'real=$(git rev-parse --git-path index) || fail "not a git repository"',
    'if [ -f "$real" ]; then cp "$real" "$idx" || fail "could not copy the index"; fi',
    'GIT_INDEX_FILE="$idx" git add -A -- . >/dev/null 2>&1 || fail "could not read the work tree"',
    'tree=$(GIT_INDEX_FILE="$idx" git write-tree) || fail "could not write the tree"',
    'rm -f -- "$idx"',
    `if [ "$mb $head $tree" = ${shellQuote(prev)} ]; then rm -rf -- "$d"; echo "UNCHANGED $mb $head $tree"; exit 0; fi`,
    'echo "CAPTURE $mb $head $tree"',
    // gzip a staged file, print its OBJ line, and remove the raw file.
    'obj() { raw=$(wc -c < "$d/$1" | tr -d " "); gzip -n -c "$d/$1" > "$d/$1.gz" || fail "could not compress $1"; rm -f -- "$d/$1";',
    '  echo "OBJ $1 $(wc -c < "$d/$1.gz" | tr -d " ") $(sha256_of "$d/$1.gz") $raw"; }',
    // Write at most max+1 bytes, so an over-large object never fills tmpfs.
    'capped() { name=$1; max=$2; shift 2; "$@" | head -c $((max + 1)) > "$d/$name";',
    '  if [ "$(wc -c < "$d/$name" | tr -d " ")" -gt "$max" ]; then rm -f -- "$d/$name"; echo "TOO_LARGE $name $((max + 1))"; else obj "$name"; fi; }',
    // The changes list: the live read's own commands.
    section('MB', 'printf %s "$mb"'),
    section('HEAD', 'printf %s "$head"'),
    section('TREE', 'printf %s "$tree"'),
    ...CHANGE_LIST_SECTIONS.map((s) => section(s.label, s.command)),
    // The patches, and where each file starts in them, in the order of their name lists.
    'patchobj() { name=$1; label=$2; shift 2;',
    `  ${DIFF} --binary "$@" | head -c ${maxPatch + 1} > "$d/$name"`,
    `  if [ "$(wc -c < "$d/$name" | tr -d " ")" -gt ${maxPatch} ]; then rm -f -- "$d/$name"; echo "TOO_LARGE $name ${maxPatch + 1}"; return; fi`,
    `  { grep -a -b '^diff --git ' "$d/$name" | cut -d: -f1; } > "$d/l/\${label}_OFFSETS" 2>/dev/null`,
    `  { ${DIFF} --name-status -z "$@"; } > "$d/l/$label" 2>/dev/null`,
    '  obj "$name"; }',
    ...PATCHES.map((p) => `patchobj ${p.name} ${p.names} "${p.from}" "${p.to}"`),
    // Every file in the work tree, ignored ones excluded.
    `capped files ${CAPTURE_FILES_MAX_BYTES} git ls-tree -r -z --name-only "$tree"`,
    // The changed files' contents at the tree: one `cat-file --batch-check` to
    // size them, a shell loop to choose (no process per file), one `--batch`
    // to read the chosen ones. A path with a newline cannot be a batch line,
    // so it asks for a missing object and is listed without content.
    section('CHANGED', 'git diff --name-only -z --no-renames --diff-filter=d "$mb" "$tree"'),
    `{ while IFS= read -r -d '' p; do case "$p" in *$'\\n'*) echo ${'0'.repeat(40)} ;; *) printf '%s:%s\\n' "$tree" "$p" ;; esac; done < "$d/l/CHANGED"; } > "$d/want"`,
    `git cat-file --batch-check='%(objecttype) %(objectsize)' < "$d/want" > "$d/check" 2>/dev/null || fail "could not size the changed files"`,
    'total=0; n=0; exec 3< "$d/want"',
    '{ while read -r type size rest; do IFS= read -r want <&3; n=$((n + 1)); keep=0',
    `  if [ "$type" = blob ] && [ "$n" -le ${CAPTURE_CONTENT_FILES_MAX} ] && [ "$size" -le ${CAPTURE_FILE_MAX_BYTES} ] && [ $((total + size)) -le ${CAPTURE_CONTENTS_MAX_BYTES} ]; then`,
    '    keep=1; total=$((total + size)); printf "%s\\n" "$want" >&4; fi',
    '  printf "%s %s %s\\n" "$keep" "$size" "$type"',
    'done < "$d/check"; } 4> "$d/keep" > "$d/l/CONTENT_INDEX"',
    'exec 3<&-',
    'git cat-file --batch < "$d/keep" > "$d/contents" || fail "could not read the changed files"',
    'rm -f -- "$d/want" "$d/check" "$d/keep"',
    'obj contents',
    // The lists last, so they carry every section above.
    '{ for f in "$d"/l/*; do printf "%s %s\\n" "$(basename "$f")" "$(wc -c < "$f" | tr -d " ")"; cat "$f"; done; } > "$d/lists" || fail "could not write the lists"',
    'rm -rf -- "$d/l"',
    'obj lists',
  ].join('\n');
}

export type CaptureLine =
  | { kind: 'unchanged'; mergeBase: string; headSha: string; treeSha: string }
  | {
      kind: 'capture';
      mergeBase: string;
      headSha: string;
      treeSha: string;
      objects: Array<{ name: ChangesObjectName | 'lists'; bytes: number; sha256: string; raw: number }>;
      tooLarge: Array<{ name: ChangesObjectName; raw: number }>;
    }
  | { kind: 'failed'; detail: string };

const NAMES = new Set(['patch', 'patch-uncommitted', 'patch-committed', 'files', 'contents', 'lists']);

export function parseCaptureOutput(r: { exitCode: number; stdout: string; stderr: string }): CaptureLine {
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const fail = (detail: string): CaptureLine => ({ kind: 'failed', detail });
  if (r.exitCode !== 0) return fail(r.stderr.trim().split('\n').slice(-3).join(' ').slice(-300) || `the capture exited ${r.exitCode}`);
  const sha = '([0-9a-f]{40,64})';
  const unchanged = new RegExp(`^UNCHANGED ${sha} ${sha} ${sha}$`).exec(lines[0] ?? '');
  if (unchanged) return { kind: 'unchanged', mergeBase: unchanged[1], headSha: unchanged[2], treeSha: unchanged[3] };
  const head = new RegExp(`^CAPTURE ${sha} ${sha} ${sha}$`).exec(lines[0] ?? '');
  if (!head) return fail('the capture printed no manifest');
  const objects: Extract<CaptureLine, { kind: 'capture' }>['objects'] = [];
  const tooLarge: Extract<CaptureLine, { kind: 'capture' }>['tooLarge'] = [];
  for (const line of lines.slice(1)) {
    const o = /^OBJ (\S+) (\d+) ([0-9a-f]{64}) (\d+)$/.exec(line);
    if (o && NAMES.has(o[1])) {
      objects.push({ name: o[1] as ChangesObjectName | 'lists', bytes: Number(o[2]), sha256: o[3], raw: Number(o[4]) });
      continue;
    }
    const t = /^TOO_LARGE (\S+) (\d+)$/.exec(line);
    if (t && NAMES.has(t[1]) && t[1] !== 'lists') {
      tooLarge.push({ name: t[1] as ChangesObjectName, raw: Number(t[2]) });
      continue;
    }
    return fail(`the capture printed an unknown line: ${line.slice(0, 80)}`);
  }
  if (!objects.some((o) => o.name === 'lists')) return fail('the capture staged no lists');
  return { kind: 'capture', mergeBase: head[1], headSha: head[2], treeSha: head[3], objects, tooLarge };
}

/** The staged file of an object, for the part reader. */
export function capturedObjectPath(workbenchId: string, name: string, tmp = '/dev/shm'): string {
  return `${captureStagingDir(workbenchId, tmp)}/${name}.gz`;
}

/** `length` bytes of `path` from `offset`. Portable: no GNU `dd` flags, so it runs on macOS in a test. */
export function captureReadChunkScript(path: string, offset: number, length: number): string {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0) throw new Error('invalid chunk');
  return `tail -c +${offset + 1} ${shellQuote(path)} | head -c ${length}`;
}

export function captureCleanupScript(workbenchId: string, tmp = '/dev/shm'): string {
  const dir = captureStagingDir(workbenchId, tmp);
  return `rm -rf -- ${shellQuote(dir)} ${shellQuote(`${dir}.index`)}`;
}

/** The length-prefixed sections of `lists`. */
export function parseListSections(body: Buffer): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  let at = 0;
  while (at < body.length) {
    const nl = body.indexOf(0x0a, at);
    if (nl < 0) throw new Error('the stored lists end inside a header');
    const m = /^([A-Z_]+) (\d+)$/.exec(body.subarray(at, nl).toString('utf8'));
    if (!m) throw new Error('the stored lists have a bad header');
    const len = Number(m[2]);
    if (nl + 1 + len > body.length) throw new Error('the stored lists end inside a section');
    out[m[1]] = body.subarray(nl + 1, nl + 1 + len);
    at = nl + 1 + len;
  }
  return out;
}

/** One changed file of `contents`. `content` is null when it was not stored. */
export interface CapturedFile {
  path: string;
  size: number;
  content: Buffer | null;
}

/** Each changed file, in order: whether its content is stored, and its size. */
export interface ContentsEntry {
  path: string;
  size: number;
  stored: boolean;
}

/** Pair the `CHANGED` list with `CONTENT_INDEX` (`<keep> <size> <type>` per file). */
export function contentsEntries(changed: Buffer, index: string): ContentsEntry[] {
  const paths = changed.toString('utf8').split('\0');
  if (paths[paths.length - 1] === '') paths.pop();
  const lines = index.split('\n').filter(Boolean);
  if (lines.length !== paths.length) throw new Error('the stored contents index does not match the changed files');
  return paths.map((path, i) => {
    const [keep, size] = lines[i].split(' ');
    return { path, size: Number(size) || 0, stored: keep === '1' };
  });
}

/** The changed files from `git cat-file --batch` output, in the order of `entries` that are stored. */
export function parseCapturedContents(body: Buffer, entries: ContentsEntry[]): Map<string, CapturedFile> {
  const out = new Map<string, CapturedFile>();
  let at = 0;
  for (const entry of entries) {
    if (!entry.stored) {
      out.set(entry.path, { path: entry.path, size: entry.size, content: null });
      continue;
    }
    const nl = body.indexOf(0x0a, at);
    if (nl < 0) throw new Error('the stored contents end inside a header');
    const m = /^[0-9a-f]{40,64} blob (\d+)$/.exec(body.subarray(at, nl).toString('utf8'));
    if (!m) throw new Error('the stored contents have a bad header');
    const size = Number(m[1]);
    if (nl + 1 + size > body.length) throw new Error('the stored contents end inside a file');
    out.set(entry.path, { path: entry.path, size, content: body.subarray(nl + 1, nl + 1 + size) });
    // `--batch` ends each object with a newline.
    at = nl + 1 + size + 1;
  }
  return out;
}
