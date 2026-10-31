import { mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

let dir: string | undefined;
let seq = 0;

/**
 * Write a script to a temp file and return a path that bash accepts. A script
 * passed as `bash -c` hits the Windows command-line limit (32,767 characters)
 * once a generated sync script grows past it.
 */
export function bashScriptFile(script: string): string {
  dir ??= mkdtempSync(path.join(os.tmpdir(), 'talyn-bash-'));
  const file = path.join(dir, `script-${seq++}.sh`);
  writeFileSync(file, script);
  return file.split(path.sep).join('/');
}
