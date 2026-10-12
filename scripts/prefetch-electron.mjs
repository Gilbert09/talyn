#!/usr/bin/env node
/**
 * Download the Electron zips a release leg packages, with retries, before
 * electron-builder runs.
 *
 * electron-builder downloads each zip itself and does not retry. On
 * 2026-10-12 GitHub answered 504 for the darwin-x64 zip once, and the macOS
 * leg failed after it had already published the arm64 zip. That left a
 * "Latest" release with no DMG and no latest-mac.yml.
 *
 * Usage: node scripts/prefetch-electron.mjs <out-dir> <platform-arch>...
 *   e.g. node scripts/prefetch-electron.mjs "$RUNNER_TEMP/electron" darwin-arm64 darwin-x64
 *
 * Then pass -c.electronDist=<out-dir> to electron-builder. It uses a zip from
 * that directory when the file name matches. CAUTION: when the zip for a
 * target is NOT there, electron-builder reads the directory as an unpacked
 * Electron and the build fails. So name every platform-arch the leg builds.
 *
 * Each zip is checked against the release's SHASUMS256.txt, which is what
 * electron-builder does on its own download.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const ATTEMPTS = 6;
const FIRST_WAIT_MS = 5_000;

const [outDir, ...targets] = process.argv.slice(2);
if (!outDir || targets.length === 0) {
  console.error('Usage: prefetch-electron.mjs <out-dir> <platform-arch>...');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const version = require('electron/package.json').version;
const base = `https://github.com/electron/electron/releases/download/v${version}`;

async function download(url) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (err) {
      lastError = err;
      if (attempt === ATTEMPTS) break;
      const waitMs = FIRST_WAIT_MS * 2 ** (attempt - 1);
      console.warn(`${url}: ${err.message}. Attempt ${attempt} of ${ATTEMPTS}, next in ${waitMs / 1000}s.`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new Error(`${url}: ${lastError.message} after ${ATTEMPTS} attempts`);
}

const sums = new Map(
  (await download(`${base}/SHASUMS256.txt`))
    .toString('utf8')
    .split('\n')
    .map((line) => /^([0-9a-f]{64}) [ *]?(\S+)$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => [m[2], m[1]]),
);

await mkdir(outDir, { recursive: true });
for (const target of targets) {
  const name = `electron-v${version}-${target}.zip`;
  const expected = sums.get(name);
  if (!expected) throw new Error(`${name} is not in SHASUMS256.txt for v${version}`);
  const body = await download(`${base}/${name}`);
  const actual = createHash('sha256').update(body).digest('hex');
  if (actual !== expected) throw new Error(`${name}: sha256 ${actual}, expected ${expected}`);
  await writeFile(path.join(outDir, name), body);
  console.log(`${name}: ${(body.length / 1e6).toFixed(1)} MB, checksum good`);
}
