import { randomUUID } from 'node:crypto';
import { shellQuote } from '@talyn/shared';
import { safeMarker, pidFileFor } from './execFraming.js';
import { FleetRunNotFoundError } from '../selfHosted/client.js';
import { runCapture, runStream, killMarker, recordWorkbenchEvent, type StreamOutcome } from './sandboxRuntime.js';
import type { WorkbenchRow } from './store.js';

export interface LogRecord { stream: 'stdout' | 'stderr'; line: string }

/**
 * Where durable logs live. The guest runs every exec as the unprivileged
 * `fleet` user (uid 1000), so the directory must be writable by it: `/root` is
 * 0700 root in the guest image, and a supervisor told to write there dies
 * before its start marker, every time.
 */
export const DURABLE_DIR = '/tmp/talyn-turns';

export function durablePaths(key: string): { log: string; exit: string; started: string; launchError: string } {
  const base = `${DURABLE_DIR}/${safeMarker(key)}`;
  return { log: `${base}.log`, exit: `${base}.exit`, started: `${base}.started`, launchError: `${base}.launch-err` };
}

// The supervisor has no pipe back to the backend. Its process group stays in the box.
export const DURABLE_SUPERVISOR = String.raw`
const fs = require('fs'), cp = require('child_process'), readline = require('readline');
const p = JSON.parse(process.env.TALYN_LOG_PATHS);
fs.mkdirSync(require('path').dirname(p.log), {recursive:true});
try { fs.writeFileSync(p.started, '1', {flag:'wx'}); } catch (e) { if(e.code==='EEXIST') process.exit(0); throw e; }
fs.mkdirSync(require('path').dirname(process.env.TALYN_PID_FILE), {recursive:true});
fs.writeFileSync(process.env.TALYN_PID_FILE, String(process.pid));
const segmentBytes = Number(process.env.TALYN_SEGMENT_BYTES || 0);
if (segmentBytes) fs.mkdirSync(p.log, {recursive:true});
let position = 0, start = 0;
let fd = fs.openSync(segmentBytes ? p.log+'/0' : p.log, 'a');
const write = data => {
  while (data.length) {
    if (segmentBytes && position - start === segmentBytes) {
      fs.closeSync(fd); start = position; fd = fs.openSync(p.log+'/'+start, 'a');
    }
    const size = segmentBytes ? Math.min(data.length, segmentBytes-(position-start)) : data.length;
    fs.writeSync(fd, data.subarray(0,size)); position += size; data = data.subarray(size);
  }
  if (segmentBytes && position - start === segmentBytes) {
    fs.closeSync(fd); start = position; fd = fs.openSync(p.log+'/'+start, 'a');
  }
};
const child = cp.spawn('bash', ['-c', process.env.TALYN_DURABLE_SCRIPT], {stdio:['ignore','pipe','pipe']});
for (const stream of ['stdout','stderr']) {
  readline.createInterface({input:child[stream], crlfDelay:Infinity}).on('line', line => {
    write(Buffer.from(JSON.stringify({stream,line})+'\n'));
  });
}
const finish = code => {
  fs.closeSync(fd);
  fs.writeFileSync(p.exit+'.tmp', String(code));
  fs.renameSync(p.exit+'.tmp', p.exit);
};
child.on('error', () => finish(127));
child.on('close', (code, signal) => finish(code === null ? 128 : code));
`;

export const DURABLE_FOLLOWER = String.raw`
const fs = require('fs');
const p = JSON.parse(process.env.TALYN_LOG_PATHS);
const limit = Number(process.env.TALYN_LOG_LIMIT || 0);
let offset = Number(process.env.TALYN_LOG_OFFSET), pending = Buffer.alloc(0);
const read = () => {
  if (!fs.existsSync(p.log)) return;
  const segmented = fs.statSync(p.log).isDirectory();
  const starts = segmented ? fs.readdirSync(p.log).filter(s => /^\d+$/.test(s)).map(Number).sort((a,b)=>a-b) : [0];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i], end = starts[i+1];
    if (end !== undefined && offset + pending.length >= end) continue;
    const fd = fs.openSync(segmented ? p.log+'/'+start : p.log, 'r');
    try {
      let buf = Buffer.alloc(65536), n;
      while ((n = fs.readSync(fd, buf, 0, buf.length, offset + pending.length - start)) > 0) {
        pending = Buffer.concat([pending, buf.subarray(0,n)]);
        let newline;
        while ((newline = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0,newline); offset += newline+1;
          process.stdout.write(offset+' '+line.toString('base64')+'\n');
          pending = pending.subarray(newline+1);
          if (limit && offset >= limit) return;
        }
      }
    } finally { fs.closeSync(fd); }
  }
};
const tick = () => {
  read();
  if (limit && offset >= limit) return;
  if (fs.existsSync(p.exit)) { read(); process.exitCode = Number(fs.readFileSync(p.exit,'utf8')); return; }
  try { const legacy = process.env.TALYN_LEGACY_PID_FILE && fs.existsSync(p.started) && fs.statSync(p.started).size === 0;
    const pid = Number(fs.readFileSync(legacy ? process.env.TALYN_LEGACY_PID_FILE : process.env.TALYN_PID_FILE,'utf8')); if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('No process'); process.kill(-pid, 0); }
  catch {
    read();
    if (fs.existsSync(p.exit)) { process.exitCode = Number(fs.readFileSync(p.exit,'utf8')); return; }
    if (fs.existsSync(p.started) && Date.now() - fs.statSync(p.started).mtimeMs < 5000) { setTimeout(tick, 50); return; }
    process.exitCode = 125; return;
  }
  setTimeout(tick, 250);
};
tick();
`;

export async function startDurableExec(
  row: WorkbenchRow, key: string, marker: string, script: string, env: Record<string, string>, segmented = false,
): Promise<void> {
  const paths = durablePaths(key);
  const result = await runCapture(row, LAUNCHER(DURABLE_SUPERVISOR), {
    quiet: true,
    env: { ...env, TALYN_SEGMENT_BYTES: segmented ? String(8 * 1024 * 1024) : '0', TALYN_DURABLE_SCRIPT: script, TALYN_LOG_FILE: paths.log,
      TALYN_LAUNCH_ERR: paths.launchError, TALYN_LOG_PATHS: JSON.stringify(paths), TALYN_PID_FILE: pidFileFor(marker) },
  });
  if (result.exitCode !== 0) {
    throw new Error('The agent could not start its output log.', { cause: new Error(result.stderr.trim() || `launcher exited ${result.exitCode}`) });
  }
}

/**
 * Start the supervisor detached and wait for its log and pid file. A box that
 * has just been resumed can take many seconds to start node, so the wait is
 * long; it ends as soon as both files appear. The supervisor's own stderr is
 * kept, so a launch that fails says why.
 */
const LAUNCHER = (supervisor: string) => [
  'mkdir -p "$(dirname "$TALYN_LOG_FILE")" || exit 1',
  `nohup setsid node -e ${shellQuote(supervisor)} >/dev/null 2>"$TALYN_LAUNCH_ERR" < /dev/null &`,
  'pid=$!',
  'for i in $(seq 1 600); do',
  '  [ -e "$TALYN_LOG_FILE" ] && [ -f "$TALYN_PID_FILE" ] && exit 0',
  '  kill -0 "$pid" 2>/dev/null || break',
  '  sleep 0.05',
  'done',
  '[ -e "$TALYN_LOG_FILE" ] && [ -f "$TALYN_PID_FILE" ] && exit 0',
  'tail -c 2000 "$TALYN_LAUNCH_ERR" >&2 2>/dev/null',
  'exit 1',
].join('\n');

/**
 * After a failed launch: did the supervisor start after all? Creating the
 * start marker with O_EXCL answers once and for all. When this call creates
 * it, a supervisor that starts later finds it and exits, so the attempt can
 * never run. `unwritable` means no supervisor could have written it either.
 */
export type DurableFence = 'fenced' | 'started' | 'unwritable';

export async function fenceDurableExec(row: WorkbenchRow, key: string): Promise<DurableFence> {
  const started = durablePaths(key).started;
  const result = await runCapture(row, [
    'mkdir -p "$(dirname "$TALYN_LOG_FENCE")" 2>/dev/null',
    'if ( set -C; printf fenced > "$TALYN_LOG_FENCE" ) 2>/dev/null; then exit 0; fi',
    '[ -e "$TALYN_LOG_FENCE" ] && exit 3',
    'exit 4',
  ].join('\n'), { quiet: true, env: { TALYN_LOG_FENCE: started } });
  if (result.exitCode === 0) return 'fenced';
  if (result.exitCode === 3) return 'started';
  if (result.exitCode === 4) return 'unwritable';
  throw new Error(`The start marker could not be checked (exit ${result.exitCode}).`, { cause: new Error(result.stderr) });
}

/** Each callback commits before the next record. A reconnect starts at the last accepted byte. */
export async function followDurableExec(
  row: WorkbenchRow, key: string, marker: string, offset: number,
  onRecord: (record: LogRecord, offset: number) => Promise<void>, signal?: AbortSignal, untilOffset?: number, legacyMarker?: string,
): Promise<StreamOutcome> {
  let current = offset;
  let stderrTail = '';
  while (!signal?.aborted) {
    const followerMarker = `follow-${randomUUID()}`;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let chain = Promise.resolve();
    let failure: unknown;
    let outcome: StreamOutcome | undefined;
    let missing: unknown;
    try {
      outcome = await runStream(row, `node -e ${shellQuote(DURABLE_FOLLOWER)}`, {
        marker: followerMarker, signal: controller.signal,
        env: { TALYN_LOG_PATHS: JSON.stringify(durablePaths(key)), TALYN_LOG_OFFSET: String(current), TALYN_LOG_LIMIT: String(untilOffset ?? 0), TALYN_LEGACY_PID_FILE: legacyMarker ? pidFileFor(legacyMarker) : '', TALYN_PID_FILE: pidFileFor(marker) },
        onStdoutLine: (line) => {
          chain = chain.then(async () => {
            if (failure) return;
            const split = line.indexOf(' ');
            const next = Number(line.slice(0, split));
            if (!Number.isSafeInteger(next) || next <= current) return;
            const record = JSON.parse(Buffer.from(line.slice(split + 1), 'base64').toString('utf8')) as LogRecord;
            await onRecord(record, next);
            current = next;
            if (record.stream === 'stderr') stderrTail = `${stderrTail}\n${record.line}`.slice(-4000);
          }).catch((err: unknown) => { failure = err; controller.abort(); });
        },
      });
    } catch (err) {
      if (err instanceof FleetRunNotFoundError) missing = err;
      if (!missing && !signal?.aborted) recordWorkbenchEvent(row, 'output_reconnect', 'The sandbox output will reconnect.', false, err);
      // A transport failure says nothing about the command in the box.
      if (!missing && !signal?.aborted) console.warn(`[workbench] retrying the output log for ${key}:`, err);
    }
    await chain;
    signal?.removeEventListener('abort', abort);
    if (!missing && (controller.signal.aborted || !outcome || outcome.exitCode === null)) {
      await killMarker(row, followerMarker).catch((err) => {
        recordWorkbenchEvent(row, 'follower_cleanup_failed', 'The output follower could not stop.', false, err);
      });
    }
    if (missing) throw missing;
    if (failure) throw failure;
    if (outcome?.exitCode !== null && outcome?.exitCode !== undefined) return { ...outcome, stderrTail };
    if (!signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { exitCode: null, stderrTail };
}

export async function retryBatchWrite<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await write(); } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}

export interface DurableRecord { record: LogRecord; offset: number }

/** Batch disk and socket writes. Per-line writes exhaust the database disk IO budget. */
export async function followDurableBatches(
  row: WorkbenchRow, key: string, marker: string, offset: number,
  commit: (records: DurableRecord[]) => Promise<void>,
  options: { records?: number; bytes?: number; ms: number; signal: AbortSignal; legacyMarker?: string },
): Promise<StreamOutcome> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  let pending: DurableRecord[] = [];
  let bytes = 0;
  let timer: NodeJS.Timeout | undefined;
  let chain = Promise.resolve();
  let failure: unknown;
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    const batch = pending; pending = []; bytes = 0;
    if (batch.length) chain = chain.then(async () => {
      if (!failure) await commit(batch);
    }).catch((error: unknown) => { failure = error; controller.abort(); });
    return chain;
  };
  try {
    const outcome = await followDurableExec(row, key, marker, offset, async (record, next) => {
      if (failure) throw failure;
      pending.push({ record, offset: next }); bytes += Buffer.byteLength(record.line) + 1;
      if (pending.length >= (options.records ?? Infinity) || bytes >= (options.bytes ?? Infinity)) await flush();
      else if (!timer) timer = setTimeout(() => { void flush(); }, options.ms);
    }, controller.signal, undefined, options.legacyMarker);
    await flush();
    if (failure) throw failure;
    return outcome;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
  }
}

export async function durableExecExists(row: WorkbenchRow, key: string): Promise<boolean> {
  const paths = durablePaths(key);
  const result = await runCapture(row, `test -e ${shellQuote(paths.started)} || test -e ${shellQuote(paths.log)}`, { quiet: true, env: { TALYN_LOG_PROBE: paths.log } });
  return result.exitCode === 0;
}

export async function removeDurableExec(row: WorkbenchRow, key: string, marker: string): Promise<void> {
  await removeDurableExecs(row, [{ key, marker }]);
}

/** One exec for every attempt of a turn. */
export async function removeDurableExecs(row: WorkbenchRow, entries: Array<{ key: string; marker: string }>): Promise<void> {
  const files = entries.flatMap(({ key, marker }) => [...Object.values(durablePaths(key)), pidFileFor(marker)]);
  await runCapture(row, `rm -rf -- ${files.map(shellQuote).join(' ')}`, { quiet: true });
}

export const PRUNE_SEGMENTS = String.raw`
const fs = require('fs'), p = process.env.TALYN_LOG_FILE, offset = Number(process.env.TALYN_COMMITTED_OFFSET);
if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
  const starts = fs.readdirSync(p).filter(s => /^\d+$/.test(s)).map(Number).sort((a,b)=>a-b);
  for (let i=0;i<starts.length-1;i++) if (starts[i+1] <= offset) fs.rmSync(p+'/'+starts[i], {force:true});
}
`;
export async function pruneDurableSegments(row: WorkbenchRow, key: string, offset: number): Promise<void> {
  await runCapture(row, `node -e ${shellQuote(PRUNE_SEGMENTS)}`, { quiet: true,
    env: { TALYN_LOG_FILE: durablePaths(key).log, TALYN_COMMITTED_OFFSET: String(offset) } });
}

export async function durableMarker(row: WorkbenchRow, key: string, marker: string, legacyMarker: string): Promise<string> {
  const started = shellQuote(durablePaths(key).started);
  const result = await runCapture(row, `test -f ${started} && ! test -s ${started}`, { quiet: true });
  return result.exitCode === 0 ? legacyMarker : marker;
}
