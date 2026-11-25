import { shellQuote } from '@talyn/shared';
import { WorkbenchError } from './errors.js';
import { runCapture } from './sandboxRuntime.js';
import type { WorkbenchRow } from './store.js';

/**
 * One image file from a session's sandbox, for `talyn_show_image`. The agent
 * names the file, so the path may be anywhere in the box (screenshots are
 * often in /tmp). Only real images come back: the type comes from the magic
 * bytes, so this read cannot return a text file such as a secret.
 */

/**
 * The largest image Talyn shows. The quiet exec answer is base64 and the fleet cuts
 * it at 4 MiB, so the file must stay well under 3 MiB. This also keeps the image
 * under the 5 MB image limit of the Anthropic API.
 */
export const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

export type SandboxImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface SandboxImage {
  path: string;
  mediaType: SandboxImageType;
  bytes: number;
  /** The file content, base64. */
  data: string;
}

/** The image type from the first bytes of the file, or null when it is not a supported image. */
export function detectImageType(bytes: Buffer): SandboxImageType | null {
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString('latin1');
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** A path the agent named: absolute, or relative to the repository. One line, no NUL. */
export function assertImagePath(path: string): string {
  const p = path.trim();
  if (!p || /[\0\r\n]/.test(p)) throw new WorkbenchError('That is not a valid file path.', 400, 'bad_path');
  return p;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function tooLarge(path: string, bytes: number | null): WorkbenchError {
  const size = bytes !== null ? ` (${megabytes(bytes)})` : '';
  return new WorkbenchError(
    `${path} is too large to show${size}. The limit is ${megabytes(MAX_IMAGE_BYTES)}. Take a smaller screenshot or save it as JPEG.`,
    413,
    'image_too_large',
  );
}

/** Read one image from the box. The exec runs in the repository, so a relative path starts there. */
export async function readSandboxImage(row: WorkbenchRow, path: string): Promise<SandboxImage> {
  const safePath = assertImagePath(path);
  const q = shellQuote(safePath);
  const script = [
    `[ -f ${q} ] || exit 3`,
    // A size that cannot be read is a failed read, never "too large".
    `n=$(wc -c < ${q} | tr -d ' ') || exit 5`,
    `case "$n" in ''|*[!0-9]*) exit 5 ;; esac`,
    `[ "$n" -le ${MAX_IMAGE_BYTES} ] || { printf '%s' "$n"; exit 4; }`,
    `cat -- ${q}`,
  ].join('\n');
  const r = await runCapture(row, script, { quiet: true, timeoutMs: 60_000 });
  if (r.exitCode === 3) throw new WorkbenchError(`${safePath} does not exist.`, 404, 'file_not_found');
  if (r.exitCode === 4) {
    const n = Number(r.stdout.trim());
    throw tooLarge(safePath, Number.isFinite(n) && n > 0 ? n : null);
  }
  if (r.exitCode !== 0) throw new Error(`reading ${safePath} failed (exit ${r.exitCode}): ${r.stderr.slice(-300)}`);
  if (r.truncated) throw tooLarge(safePath, null);
  const bytes = r.stdoutBytes;
  const mediaType = detectImageType(bytes);
  if (!mediaType) {
    throw new WorkbenchError(`${safePath} is not a PNG, JPEG, GIF or WebP image.`, 415, 'not_an_image');
  }
  return { path: safePath, mediaType, bytes: bytes.length, data: bytes.toString('base64') };
}
