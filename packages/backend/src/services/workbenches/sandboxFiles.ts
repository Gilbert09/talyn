import { shellQuote } from '@talyn/shared';
import { runCapture } from './sandboxRuntime.js';
import type { WorkbenchRow } from './store.js';

/**
 * Writing files into a sandbox. The fleet has no upload API and an exec has
 * no stdin, so the bytes travel as base64 in the exec's environment and a
 * script decodes them. One env string is capped by the kernel at 128 KiB
 * (MAX_ARG_STRLEN), so a file larger than a chunk is spread over several
 * variables, and over several execs when needed.
 */

/** One env var's worth of base64. Under the kernel's 128 KiB per-string cap. */
export const SANDBOX_ENV_CHUNK_B64 = 96 * 1024;

/**
 * Chunks per exec. argv and env share ARG_MAX (2 MiB with the default 8 MiB
 * stack) and the framing's inner `bash -c` receives the env a second time, so
 * this keeps one exec's env well under half of that.
 */
const CHUNKS_PER_EXEC = 4;

export interface SandboxFile {
  /** Absolute, or `~/…` for a path under the agent's `$HOME`. */
  path: string;
  base64: string;
}

/** A path for a script: `~` and `~/x` become `"$HOME"` and `"$HOME"/'x'`, anything else is quoted as it is. */
export function shellPath(path: string): string {
  if (path === '~') return '"$HOME"';
  return path.startsWith('~/') ? `"$HOME"/${shellQuote(path.slice(2))}` : shellQuote(path);
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  if (i <= 0) return i === 0 ? '/' : '.';
  return path.slice(0, i);
}

/**
 * Write `files` (each to a temp path beside it, then `mv` into place, so a
 * reader never sees half a file) and run `before` and `after` in the first
 * and the last exec. Throws when an exec fails.
 */
export async function writeSandboxFiles(
  wb: WorkbenchRow,
  files: SandboxFile[],
  opts: { before?: string; after?: string; timeoutMs?: number } = {},
): Promise<void> {
  const steps: Array<{ line: (v: string) => string; data: string } | { line: () => string; data: null }> = [];
  for (const file of files) {
    const target = shellPath(file.path);
    const tmp = shellPath(`${file.path}.talyn-tmp`);
    steps.push({ line: () => `mkdir -p ${shellPath(dirOf(file.path))}`, data: null });
    // At least one chunk, so an empty file is still created.
    for (let off = 0; off === 0 || off < file.base64.length; off += SANDBOX_ENV_CHUNK_B64) {
      const first = off === 0;
      steps.push({
        line: (v) => `printf %s "$${v}" | base64 -d ${first ? '>' : '>>'} ${tmp}`,
        data: file.base64.slice(off, off + SANDBOX_ENV_CHUNK_B64),
      });
      if (file.base64.length === 0) break;
    }
    steps.push({ line: () => `mv -f ${tmp} ${target}`, data: null });
  }

  const execs: Array<{ lines: string[]; env: Record<string, string> }> = [{ lines: [], env: {} }];
  for (const step of steps) {
    let current = execs[execs.length - 1];
    if (step.data === null) {
      current.lines.push(step.line());
      continue;
    }
    if (Object.keys(current.env).length >= CHUNKS_PER_EXEC) {
      current = { lines: [], env: {} };
      execs.push(current);
    }
    const name = `TALYN_F${Object.keys(current.env).length}`;
    current.env[name] = step.data;
    current.lines.push(step.line(name));
  }

  for (const [i, exec] of execs.entries()) {
    const lines = [
      'set -e',
      ...(i === 0 && opts.before ? [opts.before] : []),
      ...exec.lines,
      ...(i === execs.length - 1 && opts.after ? [opts.after] : []),
    ];
    if (lines.length === 1) continue;
    const r = await runCapture(wb, lines.join('\n'), {
      cwd: '/',
      env: exec.env,
      timeoutMs: opts.timeoutMs ?? 30_000,
      quiet: true,
    });
    if (r.exitCode !== 0) {
      throw new Error(`writing files in the sandbox failed (exit ${r.exitCode}): ${r.stderr.slice(-300)}`);
    }
  }
}
