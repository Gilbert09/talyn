import { shellQuote } from '@talyn/shared';
import { safeMarker, pidFileFor } from './execFraming.js';
import { FleetRunNotFoundError } from '../selfHosted/client.js';
import { runCapture, runStream, recordWorkbenchEvent, type StreamOutcome } from './sandboxRuntime.js';
import type { WorkbenchRow } from './store.js';

export interface LogRecord { stream: 'stdout' | 'stderr'; line: string }
export function durablePaths(key: string): { log: string; exit: string; started: string } {
  const base = `/root/.talyn/turns/${safeMarker(key)}`;
  return { log: `${base}.log`, exit: `${base}.exit`, started: `${base}.started` };
}

// The supervisor has no pipe back to the backend. Its process group stays in the box.
export const DURABLE_SUPERVISOR = String.raw`
const fs = require('fs'), cp = require('child_process'), readline = require('readline');
const p = JSON.parse(process.env.TALYN_LOG_PATHS);
fs.mkdirSync(require('path').dirname(p.log), {recursive:true});
try { fs.closeSync(fs.openSync(p.started, 'wx')); } catch (e) { if(e.code==='EEXIST') process.exit(0); throw e; }
fs.mkdirSync(require('path').dirname(process.env.TALYN_PID_FILE), {recursive:true});
fs.writeFileSync(process.env.TALYN_PID_FILE, String(process.pid));
const fd = fs.openSync(p.log, 'a');
const child = cp.spawn('bash', ['-c', process.env.TALYN_DURABLE_SCRIPT], {stdio:['ignore','pipe','pipe']});
for (const stream of ['stdout','stderr']) {
  readline.createInterface({input:child[stream], crlfDelay:Infinity}).on('line', line => {
    fs.writeSync(fd, JSON.stringify({stream,line})+'\n');
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
  const fd = fs.openSync(p.log, 'r');
  try {
    let buf = Buffer.alloc(65536), n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, offset + pending.length)) > 0) {
      pending = Buffer.concat([pending, buf.subarray(0,n)]);
      let end;
      while ((end = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0,end); offset += end+1;
        process.stdout.write(offset+' '+line.toString('base64')+'\n');
        pending = pending.subarray(end+1);
        if (limit && offset >= limit) return;
      }
    }
  } finally { fs.closeSync(fd); }
};
const tick = () => {
  read();
  if (limit && offset >= limit) return;
  if (fs.existsSync(p.exit)) { read(); process.exitCode = Number(fs.readFileSync(p.exit,'utf8')); return; }
  try { const pid = Number(fs.readFileSync(process.env.TALYN_PID_FILE,'utf8')); if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('No process'); process.kill(pid, 0); }
  catch { read(); process.exitCode = 125; return; }
  setTimeout(tick, 250);
};
tick();
`;

export async function startDurableExec(
  row: WorkbenchRow, key: string, marker: string, script: string, env: Record<string, string>,
): Promise<void> {
  const result = await runCapture(row, `nohup setsid node -e ${shellQuote(DURABLE_SUPERVISOR)} >/dev/null 2>&1 < /dev/null &\n` +
    'pid=$!; for i in $(seq 1 100); do [ -f "$TALYN_LOG_FILE" ] && [ -f "$TALYN_PID_FILE" ] && exit 0; kill -0 "$pid" 2>/dev/null || exit 1; sleep 0.05; done; exit 1', {
    quiet: true,
    env: { ...env, TALYN_DURABLE_SCRIPT: script, TALYN_LOG_FILE: durablePaths(key).log, TALYN_LOG_PATHS: JSON.stringify(durablePaths(key)), TALYN_PID_FILE: pidFileFor(marker) },
  });
  if (result.exitCode !== 0) throw new Error('The agent could not start its output log.');
}

/** Each callback commits before the next record. A reconnect starts at the last accepted byte. */
export async function followDurableExec(
  row: WorkbenchRow, key: string, marker: string, offset: number,
  onRecord: (record: LogRecord, offset: number) => Promise<void>, signal?: AbortSignal, untilOffset?: number,
): Promise<StreamOutcome> {
  let current = offset;
  let stderrTail = '';
  while (!signal?.aborted) {
    let chain = Promise.resolve();
    let failure: unknown;
    let outcome: StreamOutcome | undefined;
    try {
      outcome = await runStream(row, `node -e ${shellQuote(DURABLE_FOLLOWER)}`, {
        marker: `follow-${safeMarker(key)}`, signal,
        env: { TALYN_LOG_PATHS: JSON.stringify(durablePaths(key)), TALYN_LOG_OFFSET: String(current), TALYN_LOG_LIMIT: String(untilOffset ?? 0), TALYN_PID_FILE: pidFileFor(marker) },
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
          }).catch((err: unknown) => { failure = err; });
        },
      });
    } catch (err) {
      if (signal?.aborted) break;
      if (err instanceof FleetRunNotFoundError) throw err;
      recordWorkbenchEvent(row, 'output_reconnect', 'The sandbox output will reconnect.', false, err);
      // A transport failure says nothing about the command in the box.
      console.warn(`[workbench] retrying the output log for ${key}:`, err);
    }
    await chain;
    if (failure) throw failure;
    if (outcome?.exitCode !== null && outcome?.exitCode !== undefined) return { ...outcome, stderrTail };
    if (!signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { exitCode: null, stderrTail };
}
