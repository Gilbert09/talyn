import { mergeBaseLine } from '../workbenches/changes.js';
import { WorkbenchError } from '../workbenches/errors.js';
import { runCapture } from '../workbenches/sandboxRuntime.js';
import type { WorkbenchRow } from '../workbenches/store.js';

export const MAX_PREVIEW_PATCH_BYTES = 20 * 1024 * 1024;

export function buildPreviewPatchCommand(row: Pick<WorkbenchRow, 'baseBranch'>): string {
  return [
    'set -o pipefail',
    mergeBaseLine(row),
    '[ -n "$mb" ] || exit 2',
    'tmp=$(mktemp -d) || exit 2',
    'trap \'rm -rf -- "$tmp"\' EXIT',
    'git ls-files --others --exclude-standard -z > "$tmp/untracked" || exit 2',
    '{',
    '  git diff --binary --no-ext-diff --no-textconv --no-color "$mb" -- || exit 2',
    '  while IFS= read -r -d \'\' f; do',
    '    git diff --binary --no-ext-diff --no-textconv --no-color --no-index -- /dev/null "./$f"',
    '    rc=$?; [ "$rc" -le 1 ] || exit "$rc"',
    '  done < "$tmp/untracked"',
    `} | head -c ${MAX_PREVIEW_PATCH_BYTES + 1} > "$tmp/patch"`,
    'rc=$?',
    `[ "$(wc -c < "$tmp/patch")" -le ${MAX_PREVIEW_PATCH_BYTES} ] || exit 42`,
    '[ "$rc" -eq 0 ] || exit "$rc"',
    'printf "%s\\n" "$mb"',
    'cat "$tmp/patch"',
  ].join('\n');
}

export async function getPreviewPatch(row: WorkbenchRow): Promise<{ base: string; patch: string }> {
  // The quiet exec limit is smaller than a preview patch.
  const result = await runCapture(row, buildPreviewPatchCommand(row), { timeoutMs: 60_000, follow: true });
  if (result.exitCode === 42 || result.stdoutBytes.length > MAX_PREVIEW_PATCH_BYTES + 65) {
    throw new WorkbenchError('The session patch exceeds 20 MB. Remove large files before you sync.', 413, 'patch_too_large');
  }
  if (result.exitCode !== 0) throw new WorkbenchError('Could not read the session patch.', 502, 'patch_failed');
  const newline = result.stdout.indexOf('\n');
  const base = result.stdout.slice(0, newline);
  if (newline < 0 || !/^[a-f0-9]{40,64}$/.test(base)) throw new WorkbenchError('The session patch is incomplete.', 502, 'patch_failed');
  const patch = result.stdout.slice(newline + 1);
  if (Buffer.byteLength(patch) > MAX_PREVIEW_PATCH_BYTES) {
    throw new WorkbenchError('The session patch exceeds 20 MB. Remove large files before you sync.', 413, 'patch_too_large');
  }
  return { base, patch };
}
