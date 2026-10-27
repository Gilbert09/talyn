import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import { FleetRunNotFoundError } from '../services/selfHosted/client.js';
import type { WorkbenchRow } from '../services/workbenches/store.js';
import { DURABLE_FOLLOWER, DURABLE_SUPERVISOR, PRUNE_SEGMENTS, followDurableBatches, followDurableExec } from '../services/workbenches/durableExec.js';

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
  it('checks the exit file again after the process disappears', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talyn-exit-'));
    try {
      const paths = { log: join(dir, 'turn.log'), exit: join(dir, 'turn.exit') };
      const pid = join(dir, 'pid');
      writeFileSync(pid, '123');
      const race = `const raceFs = require('fs'); process.kill = () => { raceFs.writeFileSync(${JSON.stringify(paths.exit)}, '0'); throw Error('gone'); };`;
      const result = spawnSync(process.execPath, ['-e', race + DURABLE_FOLLOWER], {
        env: { ...process.env, TALYN_LOG_PATHS: JSON.stringify(paths), TALYN_LOG_OFFSET: '0', TALYN_PID_FILE: pid }, encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rotates segments, follows them in order, and prunes only committed segments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talyn-segments-'));
    const paths = { log: join(dir, 'script.log'), exit: join(dir, 'script.exit'), started: join(dir, 'script.started') };
    const env = { ...process.env, TALYN_LOG_PATHS: JSON.stringify(paths), TALYN_PID_FILE: join(dir, 'script.pid'),
      TALYN_SEGMENT_BYTES: '64', TALYN_DURABLE_SCRIPT: "printf 'first\\nsecond\\nthird\\nfourth\\n'" };
    try {
      expect(spawnSync(process.execPath, ['-e', DURABLE_SUPERVISOR], { env }).status).toBe(0);
      const follow = spawnSync(process.execPath, ['-e', DURABLE_FOLLOWER], { env: { ...env, TALYN_LOG_OFFSET: '0' }, encoding: 'utf8' });
      expect(follow.status, follow.stderr).toBe(0);
      const lines = follow.stdout.trim().split('\n');
      expect(lines.map((line) => JSON.parse(Buffer.from(line.split(' ')[1], 'base64').toString()).line)).toEqual(['first', 'second', 'third', 'fourth']);
      const prune = (offset: number) => spawnSync(process.execPath, ['-e', PRUNE_SEGMENTS], {
        env: { ...env, TALYN_LOG_FILE: paths.log, TALYN_COMMITTED_OFFSET: String(offset) }, encoding: 'utf8',
      });
      expect(readdirSync(paths.log)).toHaveLength(3);
      expect(prune(63).status).toBe(0);
      expect(readdirSync(paths.log)).toHaveLength(3);
      expect(prune(128).status).toBe(0);
      expect(readdirSync(paths.log)).toEqual(['128']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([{ ms: 150, bytes: 65536 }, { ms: 250, records: 50 }])('flushes live output on the $ms ms timer', async (limits) => {
    vi.useFakeTimers();
    const commit = vi.fn(async () => undefined);
    const signal = new AbortController();
    const raw = JSON.stringify({ stream: 'stdout', line: 'one' });
    const stream = vi.spyOn(runtime, 'runStream').mockImplementation(async (_row, _script, opts) => {
      opts.onStdoutLine?.(`${Buffer.byteLength(raw) + 1} ${Buffer.from(raw).toString('base64')}`);
      await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { exitCode: null, stderrTail: '' };
    });
    const kill = vi.spyOn(runtime, 'killMarker').mockResolvedValue();
    try {
      const done = followDurableBatches({ id: 'wb' } as WorkbenchRow, 'key', 'marker', 0, commit, { ...limits, signal: signal.signal });
      await vi.advanceTimersByTimeAsync(limits.ms - 1);
      expect(commit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(commit).toHaveBeenCalledTimes(1);
      signal.abort();
      await done;
      expect(kill).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^follow-/));
    } finally { stream.mockRestore(); kill.mockRestore(); vi.useRealTimers(); }
  });

});
