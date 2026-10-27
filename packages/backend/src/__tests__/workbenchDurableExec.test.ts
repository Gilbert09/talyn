import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import { FleetRunNotFoundError } from '../services/selfHosted/client.js';
import type { WorkbenchRow } from '../services/workbenches/store.js';
import { DURABLE_FOLLOWER, DURABLE_SUPERVISOR, followDurableExec } from '../services/workbenches/durableExec.js';

describe('durable sandbox log', () => {
  it('passes a missing sandbox to recovery instead of retrying its old log forever', async () => {
    const error = new FleetRunNotFoundError('missing box');
    const stream = vi.spyOn(runtime, 'runStream').mockRejectedValue(error);
    try {
      await expect(followDurableExec({ id: 'wb' } as WorkbenchRow, 'turn', 'marker', 0, async () => undefined)).rejects.toBe(error);
      expect(stream).toHaveBeenCalledTimes(1);
    } finally { stream.mockRestore(); }
  });
  it.each([0, 7])('saves Unicode output and resumes at a byte boundary, exit %i', (code) => {
    const dir = mkdtempSync(join(tmpdir(), 'talyn-log-'));
    const paths = { log: join(dir, 'turn.log'), exit: join(dir, 'turn.exit'), started: join(dir, 'turn.started') };
    const env = { ...process.env, TALYN_LOG_PATHS: JSON.stringify(paths), TALYN_PID_FILE: join(dir, 'turn.pid'),
      TALYN_DURABLE_SCRIPT: `printf 'héllo\\nsecond\\n'; printf 'error\\n' >&2; exit ${code}` };
    try {
      const run = spawnSync(process.execPath, ['-e', DURABLE_SUPERVISOR], { env, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(paths.exit, 'utf8')).toBe(String(code));
      const lines = readFileSync(paths.log, 'utf8').trimEnd().split('\n');
      const offset = Buffer.byteLength(lines[0] + '\n');
      const prefix = spawnSync(process.execPath, ['-e', DURABLE_FOLLOWER], {
        env: { ...env, TALYN_LOG_OFFSET: '0', TALYN_LOG_LIMIT: String(offset) }, encoding: 'utf8',
      });
      expect(prefix.status).toBe(0);
      expect(prefix.stdout.trim().split('\n')).toHaveLength(1);
      const follow = spawnSync(process.execPath, ['-e', DURABLE_FOLLOWER], {
        env: { ...env, TALYN_LOG_OFFSET: String(offset) }, encoding: 'utf8',
      });
      expect(follow.status, follow.stderr).toBe(code);
      const output = follow.stdout.trim().split('\n').map((line) => JSON.parse(Buffer.from(line.split(' ')[1], 'base64').toString()));
      expect(output).toEqual(lines.slice(1).map((line) => JSON.parse(line)));
      const again = spawnSync(process.execPath, ['-e', DURABLE_SUPERVISOR], { env, encoding: 'utf8' });
      expect(again.status).toBe(0);
      expect(readFileSync(paths.log, 'utf8').trimEnd().split('\n')).toEqual(lines);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('reports a dead process only after reading its final output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talyn-log-'));
    try {
      const paths = { log: join(dir, 'turn.log'), exit: join(dir, 'turn.exit') };
      writeFileSync(paths.log, JSON.stringify({ stream: 'stdout', line: 'last' }) + '\n');
      const result = spawnSync(process.execPath, ['-e', DURABLE_FOLLOWER], {
        env: { ...process.env, TALYN_LOG_PATHS: JSON.stringify(paths), TALYN_LOG_OFFSET: '0', TALYN_PID_FILE: join(dir, 'missing') }, encoding: 'utf8',
      });
      expect(result.status).toBe(125);
      expect(result.stdout).not.toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
