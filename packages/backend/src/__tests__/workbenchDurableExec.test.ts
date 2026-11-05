import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import { FleetRunNotFoundError, type FleetClient } from '../services/selfHosted/client.js';
import type { WorkbenchRow } from '../services/workbenches/store.js';
import { DURABLE_FOLLOWER, DURABLE_SUPERVISOR, FOLLOW_LOST_CONTACT_MS, LOST_CONTACT_MESSAGE, PRUNE_SEGMENTS, followDurableBatches, followDurableExec } from '../services/workbenches/durableExec.js';

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
  it('records spawn and output times in the guest log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talyn-timing-'));
    const paths = { log: join(dir, 'turn.log'), exit: join(dir, 'turn.exit'), started: join(dir, 'turn.started') };
    const queuedAt = Date.now() - 500;
    try {
      const result = spawnSync(process.execPath, ['-e', DURABLE_SUPERVISOR], {
        env: { ...process.env, TALYN_LOG_PATHS: JSON.stringify(paths), TALYN_PID_FILE: join(dir, 'turn.pid'),
          TALYN_TURN_QUEUED_AT: new Date(queuedAt).toISOString(), TALYN_DURABLE_SCRIPT: "printf 'init\\n'" }, encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      const [spawn, record] = readFileSync(paths.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(spawn.spawned).toBe(true);
      expect(spawn.timing.spawnedAt).toBe(record.timing.spawnedAt);
      expect(record.line).toBe('init');
      expect(record.timing.queuedAt).toBe(queuedAt);
      expect(record.timing.spawnedAt).toBeGreaterThanOrEqual(queuedAt + 500);
      expect(record.timing.at).toBeGreaterThanOrEqual(record.timing.spawnedAt);
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

  describe('a box that stops answering', () => {
    // Every follower attempt ends without the agent's exit, as on 2026-11-05
    // when every exec in an adopted box timed out.
    const silentAttempts = () => vi.spyOn(runtime, 'runStream').mockResolvedValue({ exitCode: null, stderrTail: '' });

    it.each([
      { name: 'cannot answer the liveness check', alive: 'throw' as const, ends: true },
      { name: 'reports the agent alive', alive: true, ends: false },
      { name: 'reports the agent gone', alive: false, ends: false },
    ])('when the box $name after the window, ends the turn: $ends', async ({ alive, ends }) => {
      vi.useFakeTimers();
      const stream = silentAttempts();
      const kill = vi.spyOn(runtime, 'killMarker').mockResolvedValue();
      const check = vi.spyOn(runtime, 'isMarkerAlive').mockImplementation(async () => {
        if (alive === 'throw') throw new Error('exit -1');
        return alive;
      });
      const event = vi.spyOn(runtime, 'recordWorkbenchEvent').mockImplementation(() => undefined);
      const signal = new AbortController();
      let settled: { exitCode: number | null; stderrTail: string } | undefined;
      const done = followDurableExec({ id: 'wb' } as WorkbenchRow, 'key', 'marker', 0, async () => undefined, signal.signal)
        .then((o) => { settled = o; });
      try {
        await vi.advanceTimersByTimeAsync(FOLLOW_LOST_CONTACT_MS - 5_000);
        expect(check).not.toHaveBeenCalled();
        expect(settled).toBeUndefined();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(check).toHaveBeenCalledWith(expect.anything(), 'marker');
        if (ends) {
          expect(settled).toEqual({ exitCode: null, stderrTail: LOST_CONTACT_MESSAGE });
          expect(event).toHaveBeenCalledWith(expect.anything(), 'output_lost_contact', LOST_CONTACT_MESSAGE, false);
        } else {
          expect(settled).toBeUndefined();
          // The answer is contact: the window starts again.
          const calls = check.mock.calls.length;
          await vi.advanceTimersByTimeAsync(FOLLOW_LOST_CONTACT_MS - 10_000);
          expect(check.mock.calls.length).toBe(calls);
        }
      } finally {
        signal.abort();
        await vi.advanceTimersByTimeAsync(5_000);
        await done;
        stream.mockRestore(); kill.mockRestore(); check.mockRestore(); event.mockRestore(); vi.useRealTimers();
      }
    });

    it('counts output as contact, so a quiet stretch must last the whole window', async () => {
      vi.useFakeTimers();
      let calls = 0;
      const raw = JSON.stringify({ stream: 'stdout', line: 'still working' });
      const stream = vi.spyOn(runtime, 'runStream').mockImplementation(async (_row, _script, opts) => {
        calls++;
        // One line twenty minutes in, then silence.
        if (calls === 600) opts.onStdoutLine?.(`${Buffer.byteLength(raw) + 1} ${Buffer.from(raw).toString('base64')}`);
        return { exitCode: null, stderrTail: '' };
      });
      const kill = vi.spyOn(runtime, 'killMarker').mockResolvedValue();
      const check = vi.spyOn(runtime, 'isMarkerAlive').mockRejectedValue(new Error('exit -1'));
      const event = vi.spyOn(runtime, 'recordWorkbenchEvent').mockImplementation(() => undefined);
      const records: number[] = [];
      let settled = false;
      const done = followDurableExec({ id: 'wb' } as WorkbenchRow, 'key', 'marker', 0, async (_r, offset) => { records.push(offset); })
        .then(() => { settled = true; });
      try {
        await vi.advanceTimersByTimeAsync(FOLLOW_LOST_CONTACT_MS + 60_000);
        expect(records).toHaveLength(1);
        expect(check).not.toHaveBeenCalled();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(FOLLOW_LOST_CONTACT_MS);
        await done;
        expect(check).toHaveBeenCalledTimes(1);
      } finally { stream.mockRestore(); kill.mockRestore(); check.mockRestore(); event.mockRestore(); vi.useRealTimers(); }
    });

    it('passes a sandbox the liveness check finds missing to recovery', async () => {
      vi.useFakeTimers();
      const stream = silentAttempts();
      const kill = vi.spyOn(runtime, 'killMarker').mockResolvedValue();
      const error = new FleetRunNotFoundError('missing box');
      const check = vi.spyOn(runtime, 'isMarkerAlive').mockRejectedValue(error);
      try {
        const done = followDurableExec({ id: 'wb' } as WorkbenchRow, 'key', 'marker', 0, async () => undefined);
        const settled = expect(done).rejects.toBe(error);
        await vi.advanceTimersByTimeAsync(FOLLOW_LOST_CONTACT_MS + 5_000);
        await settled;
      } finally { stream.mockRestore(); kill.mockRestore(); check.mockRestore(); vi.useRealTimers(); }
    });
  });

  describe('isMarkerAlive', () => {
    // A quiet answer with no trailer of ours, so the fleet's own exit code is
    // the answer: -1 is what a check killed by its own timeout reports.
    it.each([
      { exitCode: 0, want: true },
      { exitCode: 1, want: false },
      { exitCode: -1, want: 'throws' },
      { exitCode: 137, want: 'throws' },
    ])('reads exit $exitCode as $want', async ({ exitCode, want }) => {
      const quietExec = vi.fn(async () => ({ kind: 'quiet' as const, result: { stdout: '', stderr: '', exitCode } }));
      runtime.setWorkbenchFleetClientForTests(async () => ({ quietExec }) as unknown as FleetClient);
      try {
        const check = runtime.isMarkerAlive({ id: 'wb', workspaceId: 'ws', runtime: 'sandbox', sandboxId: 'sb' } as WorkbenchRow, 'marker');
        if (want === 'throws') await expect(check).rejects.toThrow(/did not finish/);
        else await expect(check).resolves.toBe(want);
        expect(quietExec).toHaveBeenCalledTimes(1);
      } finally { runtime.setWorkbenchFleetClientForTests(null); }
    });
  });
});
